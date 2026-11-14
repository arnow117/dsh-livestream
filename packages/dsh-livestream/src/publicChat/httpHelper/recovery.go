package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"unicode/utf16"
)

type messageRef struct {
	RequestID         string         `json:"requestId"`
	SourceKey         string         `json:"sourceKey"`
	RequestHash       string         `json:"requestHash"`
	HelperPayloadHash string         `json:"helperPayloadHash"`
	TextDigest        string         `json:"textDigest"`
	Grant             committedGrant `json:"grant"`
}

type helperMessageReconcile struct {
	ControlID                string            `json:"controlId"`
	Ref                      messageRef        `json:"ref"`
	FactsRevision            int               `json:"factsRevision"`
	FactsDigest              string            `json:"factsDigest"`
	Facts                    []json.RawMessage `json:"facts"`
	OriginControlPayloadHash string            `json:"originControlPayloadHash"`
}

type recoveryReceipt struct {
	Version                  string     `json:"version"`
	ControlID                string     `json:"controlId"`
	Kind                     string     `json:"kind"`
	OriginControlPayloadHash string     `json:"originControlPayloadHash"`
	HelperPayloadHash        string     `json:"helperPayloadHash"`
	Ref                      messageRef `json:"ref"`
	RefDigest                string     `json:"refDigest"`
	FactsRevision            int        `json:"factsRevision"`
	FactsDigest              string     `json:"factsDigest"`
	HelperNonce              string     `json:"helperNonce"`
	SenderProcessNonce       string     `json:"senderProcessNonce"`
	AuthContextID            string     `json:"authContextId"`
	AuthContextRevision      uint64     `json:"authContextRevision"`
	MaterialDigest           string     `json:"materialDigest"`
	JoinedWitnessID          string     `json:"joinedWitnessId"`
	JoinedAtMs               int64      `json:"joinedAtMs"`
	AcceptedAtMs             int64      `json:"acceptedAtMs"`
	FirstWriteAttemptAtMs    *int64     `json:"firstWriteAttemptAtMs"`
	WriteAttempted           bool       `json:"writeAttempted"`
	RecoveryCommitID         string     `json:"recoveryCommitId"`
	CommittedAtMs            int64      `json:"committedAtMs"`
	Decision                 string     `json:"decision"`
}

type helperReconcileRecord struct {
	request helperMessageReconcile
	receipt *recoveryReceipt
}

type factCommon struct {
	Kind             string `json:"kind"`
	FactID           string `json:"factId"`
	Seq              int    `json:"seq"`
	RefDigest        string `json:"refDigest"`
	HostRecordedAtMs int64  `json:"hostRecordedAtMs"`
}

type noteFact struct {
	factCommon
	Note string `json:"note"`
}

type observationFact struct {
	factCommon
	Source              string  `json:"source"`
	AttributionStrength string  `json:"attributionStrength"`
	ObservedAtMs        int64   `json:"observedAtMs"`
	TextDigest          string  `json:"textDigest"`
	PrincipalUID        string  `json:"principalUid"`
	RoomID              string  `json:"roomId"`
	PlatformRoomID      string  `json:"platformRoomId"`
	ObserverRef         *string `json:"observerRef"`
}

func factFields(raw json.RawMessage, keys ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || len(fields) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := fields[key]; !ok {
			return false
		}
	}
	return true
}

func validRecoveryFacts(ref messageRef, facts []json.RawMessage) ([]observationFact, error) {
	if facts == nil || len(facts) > 32 {
		return nil, errors.New("invalid facts")
	}
	refDigest, err := canonicalHash(ref)
	if err != nil {
		return nil, errors.New("invalid reference")
	}
	seen := make(map[string]bool)
	observations := make([]observationFact, 0)
	var lastRecordedAt int64
	for index, raw := range facts {
		var head struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(raw, &head) != nil {
			return nil, errors.New("invalid fact")
		}
		var common factCommon
		switch head.Kind {
		case "note":
			var fact noteFact
			if !factFields(raw, "kind", "factId", "seq", "refDigest", "hostRecordedAtMs", "note") ||
				decodeFrameStrict(raw, &fact) != nil || fact.Note == "" || len(utf16.Encode([]rune(fact.Note))) > 500 {
				return nil, errors.New("invalid note")
			}
			common = fact.factCommon
		case "positive_observation":
			var fact observationFact
			if !factFields(raw, "kind", "factId", "seq", "refDigest", "hostRecordedAtMs", "source", "attributionStrength",
				"observedAtMs", "textDigest", "principalUid", "roomId", "platformRoomId", "observerRef") ||
				decodeFrameStrict(raw, &fact) != nil || (fact.Source != "owner" && fact.Source != "designated-viewer") ||
				(fact.AttributionStrength != "direct" && fact.AttributionStrength != "indirect") ||
				fact.ObservedAtMs <= 0 || fact.ObservedAtMs > fact.HostRecordedAtMs+5000 ||
				fact.TextDigest != ref.TextDigest || fact.PrincipalUID != ref.Grant.PrincipalUID ||
				fact.RoomID != ref.Grant.RoomID || fact.PlatformRoomID != ref.Grant.PlatformRoomID ||
				(fact.Source == "owner" && fact.ObserverRef != nil) ||
				(fact.Source == "designated-viewer" && (fact.ObserverRef == nil || !validIdentifier(*fact.ObserverRef))) {
				return nil, errors.New("invalid observation")
			}
			common = fact.factCommon
			observations = append(observations, fact)
		default:
			return nil, errors.New("invalid fact kind")
		}
		if !validIdentifier(common.FactID) || seen[common.FactID] || common.Seq != index+1 ||
			common.RefDigest != refDigest || common.HostRecordedAtMs <= 0 || common.HostRecordedAtMs > 1<<53-1-5000 ||
			common.HostRecordedAtMs < lastRecordedAt {
			return nil, errors.New("invalid fact reference")
		}
		seen[common.FactID] = true
		lastRecordedAt = common.HostRecordedAtMs
	}
	return observations, nil
}

func (a *helperGrants) messageHeldLocked() bool {
	for _, record := range a.records {
		if record.kind == "send" && record.message != nil &&
			(record.message.conflict || record.message.pendingReconcile != "" ||
				((record.state == "unknown" || record.message.unknownObserved) && !record.message.recoveryReleased)) {
			return true
		}
	}
	return false
}

func (a *helperGrants) invalidateRecoveryGrantLocked() {
	if a.active != nil {
		id := a.active.AuthorizationID
		a.cancelledAuth[id] = true
		if active, ok := a.records[a.activeRequestID]; ok && active.message != nil && active.message.syncWork != nil {
			active.message.syncWork.sealLocked()
		}
		if record, ok := a.records[id]; ok && record.kind == "authorize" {
			record.state = "revoked"
			a.records[id] = record
		}
		a.active = nil
	}
	a.qualification = nil
}

func cloneRawFacts(facts []json.RawMessage) []json.RawMessage {
	result := make([]json.RawMessage, len(facts))
	for i, fact := range facts {
		result[i] = bytes.Clone(fact)
	}
	return result
}

func (a *helperGrants) reconcileMessage(request helperMessageReconcile, privateHash string) (grantRecord, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.reconcileMessageLocked(request, privateHash)
}

func (a *helperGrants) reconcileMessageLocked(request helperMessageReconcile, privateHash string) (grantRecord, error) {
	if !validIdentifier(request.ControlID) || !validDigest(privateHash) || !validDigest(request.OriginControlPayloadHash) ||
		!validDigest(request.FactsDigest) || request.FactsRevision != len(request.Facts) {
		return grantRecord{}, errors.New("invalid recovery control")
	}
	actualHash, err := canonicalHash(request)
	if err != nil || actualHash != privateHash {
		return grantRecord{}, errors.New("invalid recovery hash")
	}
	if previous, ok := a.records[request.ControlID]; ok {
		if previous.kind != "message_reconcile" || previous.hash != privateHash || previous.reconcile == nil {
			return grantRecord{}, errors.New("control conflict")
		}
		if previous.state == "pending_join" {
			return a.finishReconcileLocked(previous)
		}
		return cloneGrantRecord(previous), nil
	}
	if a.capacity <= 0 || len(a.records) >= a.capacity {
		return grantRecord{}, errors.New("control unavailable")
	}
	original, ok := a.records[request.Ref.RequestID]
	if !ok || original.kind != "send" || original.message == nil ||
		(original.state != "dispatching" && original.state != "unknown" && original.state != "terminal_not_dispatched") {
		return grantRecord{}, errors.New("original unavailable")
	}
	message := original.message
	if request.Ref.RequestID != message.requestID || request.Ref.SourceKey != message.sourceKey ||
		request.Ref.RequestHash != message.requestHash || request.Ref.HelperPayloadHash != message.payloadHash ||
		request.Ref.TextDigest != message.textDigest || request.Ref.Grant != message.grant || a.context == nil ||
		request.Ref.Grant.HelperProcessNonce != a.context.processNonce || request.Ref.Grant.AuthContextID != a.context.contextID ||
		request.Ref.Grant.AuthContextRevision != a.revision || request.Ref.Grant.MaterialDigest != a.context.materialDigest ||
		request.Ref.Grant.SenderProcessNonce != a.deployment.senderNonce {
		return grantRecord{}, errors.New("original reference mismatch")
	}
	if message.pendingReconcile != "" {
		return grantRecord{}, errors.New("original control pending")
	}
	if request.FactsRevision == len(message.facts) && request.FactsDigest == message.factsDigest && message.latestReconcile != "" {
		previous := a.records[message.latestReconcile]
		if previous.kind != "message_reconcile" || previous.state != "held" {
			return grantRecord{}, errors.New("current fact head already reconciled")
		}
	}
	observations, err := validRecoveryFacts(request.Ref, request.Facts)
	if err != nil {
		return grantRecord{}, err
	}
	nowMs := a.now().UnixMilli()
	if nowMs <= 0 || nowMs > 1<<53-1-5000 {
		return grantRecord{}, errors.New("recovery clock unavailable")
	}
	for _, raw := range request.Facts {
		var common factCommon
		if json.Unmarshal(raw, &common) != nil || common.HostRecordedAtMs > nowMs+5000 {
			return grantRecord{}, errors.New("fact clock unavailable")
		}
	}
	for _, observation := range observations {
		if observation.ObservedAtMs < message.acceptedAtMs ||
			(message.firstWriteAttemptAtMs != nil && observation.ObservedAtMs < *message.firstWriteAttemptAtMs) {
			return grantRecord{}, errors.New("observation precedes original operation")
		}
	}
	factsHash, err := canonicalHash(request.Facts)
	if err != nil || factsHash != request.FactsDigest {
		return grantRecord{}, errors.New("facts digest mismatch")
	}
	request.Facts = cloneRawFacts(request.Facts)
	record := grantRecord{kind: "message_reconcile", hash: privateHash, state: "pending", target: request.Ref.RequestID,
		reconcile: &helperReconcileRecord{request: request}}
	if request.FactsRevision < len(message.facts) {
		record.state = "superseded"
		a.records[request.ControlID] = record
		return cloneGrantRecord(record), nil
	}
	for i, old := range message.facts {
		oldHash, _ := canonicalHash(old)
		newHash, _ := canonicalHash(request.Facts[i])
		if oldHash != newHash {
			message.conflict = true
			message.recoveryReleased = false
			a.invalidateRecoveryGrantLocked()
			record.state = "held"
			a.records[request.ControlID] = record
			return cloneGrantRecord(record), nil
		}
	}
	if request.FactsRevision > len(message.facts) || (message.factsDigest != "" && request.FactsDigest != message.factsDigest) {
		message.recoveryReleased = false
		a.invalidateRecoveryGrantLocked()
	}
	message.facts = cloneRawFacts(request.Facts)
	message.factsDigest = request.FactsDigest
	message.pendingReconcile = request.ControlID
	message.latestReconcile = request.ControlID
	a.records[request.ControlID] = record
	return a.finishReconcileLocked(record)
}

func (a *helperGrants) finishReconcileLocked(record grantRecord) (grantRecord, error) {
	request := record.reconcile.request
	original, ok := a.records[request.Ref.RequestID]
	if !ok || original.message == nil || original.message.pendingReconcile != request.ControlID {
		return grantRecord{}, errors.New("original control unavailable")
	}
	message := original.message
	if !message.executionEnded || message.syncWork == nil {
		record.state = "pending_join"
		a.records[request.ControlID] = record
		return cloneGrantRecord(record), nil
	}
	select {
	case <-message.syncWork.done:
	default:
		record.state = "pending_join"
		a.records[request.ControlID] = record
		return cloneGrantRecord(record), nil
	}
	observations, err := validRecoveryFacts(request.Ref, request.Facts)
	if err != nil {
		return grantRecord{}, err
	}
	validTime := message.joinedWitnessID != "" && message.joinedAtMs >= message.acceptedAtMs &&
		(message.firstWriteAttemptAtMs == nil || message.joinedAtMs >= *message.firstWriteAttemptAtMs)
	direct := false
	for _, observation := range observations {
		if observation.ObservedAtMs < message.acceptedAtMs ||
			(message.firstWriteAttemptAtMs != nil && observation.ObservedAtMs < *message.firstWriteAttemptAtMs) {
			message.conflict = true
		}
		if observation.AttributionStrength == "direct" && message.firstWriteAttemptAtMs != nil &&
			observation.ObservedAtMs >= *message.firstWriteAttemptAtMs {
			direct = true
		}
	}
	if !message.writeAttempted && len(observations) > 0 {
		message.conflict = true
	}
	if !validTime || message.conflict || (message.writeAttempted && !direct) ||
		(message.writeAttempted != (message.firstWriteAttemptAtMs != nil)) {
		record.state = "held"
		message.pendingReconcile = ""
		a.records[request.ControlID] = record
		return cloneGrantRecord(record), nil
	}
	committedAt := a.now().UnixMilli()
	var id [16]byte
	if committedAt < message.joinedAtMs || committedAt > 1<<53-1 {
		message.conflict = true
		message.pendingReconcile = ""
		record.state = "held"
		a.records[request.ControlID] = record
		return cloneGrantRecord(record), nil
	}
	if _, err := rand.Read(id[:]); err != nil {
		message.pendingReconcile = ""
		record.state = "held"
		a.records[request.ControlID] = record
		return cloneGrantRecord(record), nil
	}
	refDigest, err := canonicalHash(request.Ref)
	if err != nil {
		return grantRecord{}, err
	}
	decision := "never_written_released"
	if message.writeAttempted {
		decision = "observed_unknown_released"
	}
	receipt := &recoveryReceipt{Version: "dsh-public-chat-recovery-v1", ControlID: request.ControlID, Kind: "message_reconcile",
		OriginControlPayloadHash: request.OriginControlPayloadHash, HelperPayloadHash: record.hash, Ref: request.Ref,
		RefDigest: refDigest, FactsRevision: request.FactsRevision, FactsDigest: request.FactsDigest,
		HelperNonce: a.context.processNonce, SenderProcessNonce: a.deployment.senderNonce, AuthContextID: a.context.contextID,
		AuthContextRevision: a.revision, MaterialDigest: a.context.materialDigest, JoinedWitnessID: message.joinedWitnessID,
		JoinedAtMs: message.joinedAtMs, AcceptedAtMs: message.acceptedAtMs, FirstWriteAttemptAtMs: message.firstWriteAttemptAtMs,
		WriteAttempted: message.writeAttempted, RecoveryCommitID: hex.EncodeToString(id[:]), CommittedAtMs: committedAt, Decision: decision}
	a.invalidateRecoveryGrantLocked()
	message.recoveryReleased = true
	message.pendingReconcile = ""
	record.state = "committed"
	record.reconcile.receipt = receipt
	a.records[request.ControlID] = record
	return cloneGrantRecord(record), nil
}
