package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"
)

// grantProposal deliberately has no grant ID or authorization timestamp.
type grantProposal struct {
	Version                       string `json:"version"`
	TransportKind                 string `json:"transportKind"`
	BuildDigest                   string `json:"buildDigest"`
	InstanceID                    string `json:"instanceId"`
	SenderProcessNonce            string `json:"senderProcessNonce"`
	SenderConnectionGeneration    uint64 `json:"senderConnectionGeneration"`
	AuthorizationID               string `json:"authorizationId"`
	CaptureID                     string `json:"captureId"`
	QualificationDigest           string `json:"qualificationDigest"`
	QualificationRevision         uint64 `json:"qualificationRevision"`
	IdentityEpoch                 uint64 `json:"identityEpoch"`
	AccountRecordID               string `json:"accountRecordId"`
	PrincipalUID                  string `json:"principalUid"`
	RoomID                        string `json:"roomId"`
	PlatformRoomID                string `json:"platformRoomId"`
	HelperProcessNonce            string `json:"helperProcessNonce"`
	AuthContextID                 string `json:"authContextId"`
	AuthContextRevision           uint64 `json:"authContextRevision"`
	MaterialDigest                string `json:"materialDigest"`
	RawSourceSessionID            string `json:"rawSourceSessionId"`
	RawSourceConnectionGeneration uint64 `json:"rawSourceConnectionGeneration"`
	RawBrowserContextID           string `json:"rawBrowserContextId"`
	RoomBindingProofDigest        string `json:"roomBindingProofDigest"`
	InputConnectionGeneration     uint64 `json:"inputConnectionGeneration"`
	LiveEpoch                     string `json:"liveEpoch"`
	LiveEpochStartedAtMs          int64  `json:"liveEpochStartedAtMs"`
}

type committedGrant struct {
	grantProposal
	GrantID        string `json:"grantId"`
	AuthorizedAtMs int64  `json:"authorizedAtMs"`
}

type grantRecord struct {
	kind          string
	hash          string
	state         string
	grant         *committedGrant
	target        string
	capture       bool
	message       *helperMessage
	qualification *helperQualification
	reconcile     *helperReconcileRecord
}

type helperMessage struct {
	requestID, sourceKey, payloadHash string
	requestHash, textDigest           string
	acceptedAtMs                      int64
	firstWriteAttemptAtMs             *int64
	joinedWitnessID                   string
	joinedAtMs                        int64
	facts                             []json.RawMessage
	factsDigest                       string
	pendingReconcile                  string
	latestReconcile                   string
	recoveryReleased                  bool
	unknownObserved                   bool
	conflict                          bool
	grant                             committedGrant
	writeAttempted, executionEnded    bool
	boundary                          *writeBoundary
	syncWork                          *syncHTTPWork
	responseStatus                    int
	responseLength                    int
	responseDigest                    string
}

type responseEvidence struct {
	status  int
	length  int
	digest  string
	success bool
}

type helperFixedDeployment struct {
	buildDigest, instanceID, senderNonce, accountRecordID, principalUID, roomID string
}

// Only a successful same-context profile operation may populate this record.
type helperQualification struct {
	captureID, digest, principalUID string
	revision, identityEpoch         uint64
	capturedAtMs                    int64
}

type helperGrants struct {
	mu                sync.Mutex
	context           *authContext
	deployment        helperFixedDeployment
	revision          uint64
	now               func() time.Time
	records           map[string]grantRecord
	cancelledAuth     map[string]bool
	cancelledCaptures map[string]bool
	active            *committedGrant
	qualification     *helperQualification
	inFlight          bool
	activeRequestID   string
	sourceOperations  map[string]string
	capacity          int
	lastCommitMs      int64
	captureID         string
	captureGeneration uint64
	captureBusy       bool
	captureWork       *syncHTTPWork
}

func newHelperGrants(context *authContext, deployment helperFixedDeployment, revision uint64, now func() time.Time, capacity int) *helperGrants {
	return &helperGrants{context: context, deployment: deployment, revision: revision, now: now, capacity: capacity,
		records: make(map[string]grantRecord), cancelledAuth: make(map[string]bool), cancelledCaptures: make(map[string]bool),
		sourceOperations: make(map[string]string)}
}

func proposalDigest(proposal grantProposal) string {
	hash, _ := canonicalHash(proposal)
	return hash
}

func validIdentifier(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if c < 0x21 || c > 0x7e {
			return false
		}
	}
	return true
}

func validDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && hex.EncodeToString(decoded) == value
}

func validDecimal(value string) bool {
	if len(value) == 0 || len(value) > 20 || value[0] == '0' {
		return false
	}
	n, err := strconv.ParseUint(value, 10, 64)
	return err == nil && n > 0 && strconv.FormatUint(n, 10) == value
}

func validWebRoomID(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func (a *helperGrants) validProposal(p grantProposal) bool {
	if a.context == nil || a.now == nil || a.qualification == nil || !a.context.validAt(a.now()) || p.Version != "dsh-public-chat-v1" ||
		p.TransportKind != "frozen_http" || p.HelperProcessNonce != a.context.processNonce ||
		p.AuthContextID != a.context.contextID || p.AuthContextRevision != a.revision || p.MaterialDigest != a.context.materialDigest ||
		p.BuildDigest != a.deployment.buildDigest || p.InstanceID != a.deployment.instanceID ||
		p.SenderProcessNonce != a.deployment.senderNonce || p.AccountRecordID != a.deployment.accountRecordID ||
		p.PrincipalUID != a.deployment.principalUID || p.RoomID != a.deployment.roomID ||
		p.CaptureID != a.qualification.captureID || p.QualificationDigest != a.qualification.digest ||
		p.QualificationRevision != a.qualification.revision || p.IdentityEpoch != a.qualification.identityEpoch ||
		p.PrincipalUID != a.qualification.principalUID ||
		!validDigest(p.BuildDigest) || !validDigest(p.QualificationDigest) || !validDigest(p.RoomBindingProofDigest) ||
		!validDecimal(p.PrincipalUID) || !validWebRoomID(p.RoomID) || !validDecimal(p.PlatformRoomID) || p.LiveEpochStartedAtMs <= 0 {
		return false
	}
	nowMs := a.now().UnixMilli()
	if a.qualification.capturedAtMs <= 0 || nowMs < a.qualification.capturedAtMs ||
		nowMs-a.qualification.capturedAtMs > 60000 {
		return false
	}
	const maxSafeInteger = uint64(1<<53 - 1)
	for _, n := range []uint64{p.SenderConnectionGeneration, p.QualificationRevision, p.IdentityEpoch,
		p.AuthContextRevision, p.RawSourceConnectionGeneration, p.InputConnectionGeneration} {
		if n > maxSafeInteger {
			return false
		}
	}
	for _, value := range []string{p.InstanceID, p.SenderProcessNonce, p.AuthorizationID, p.CaptureID,
		p.AccountRecordID, p.RawSourceSessionID, p.RawBrowserContextID, p.LiveEpoch} {
		if !validIdentifier(value) {
			return false
		}
	}
	return true
}

func cloneGrantRecord(record grantRecord) grantRecord {
	if record.grant != nil {
		grant := *record.grant
		record.grant = &grant
	}
	if record.message != nil {
		message := *record.message
		record.message = &message
	}
	if record.qualification != nil {
		qualification := *record.qualification
		record.qualification = &qualification
	}
	if record.reconcile != nil {
		reconcile := *record.reconcile
		reconcile.request.Facts = cloneRawFacts(reconcile.request.Facts)
		if reconcile.receipt != nil {
			receipt := *reconcile.receipt
			reconcile.receipt = &receipt
		}
		record.reconcile = &reconcile
	}
	return record
}

// beginSend registers the original message and reserves the only execution
// slot before any transport or signing work starts. Duplicate IDs never return
// a second boundary and therefore cannot cause another application Write.
func (a *helperGrants) beginSendWithFacts(requestID, sourceKey, payloadHash, requestHash, textDigest string, grant committedGrant) (*writeBoundary, grantRecord, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !validIdentifier(requestID) || !validIdentifier(sourceKey) || !validDigest(payloadHash) ||
		!validDigest(requestHash) || !validDigest(textDigest) {
		return nil, grantRecord{}, errors.New("invalid message operation")
	}
	if previous, ok := a.records[requestID]; ok {
		if previous.kind != "send" || previous.hash != payloadHash || previous.message == nil ||
			previous.message.sourceKey != sourceKey || previous.message.grant != grant ||
			previous.message.requestHash != requestHash || previous.message.textDigest != textDigest {
			return nil, grantRecord{}, errors.New("operation conflict")
		}
		return nil, cloneGrantRecord(previous), nil
	}
	if _, exists := a.sourceOperations[sourceKey]; exists {
		return nil, grantRecord{}, errors.New("source already used")
	}
	if a.capacity <= 0 || len(a.records) >= a.capacity || a.inFlight || a.messageHeldLocked() || a.active == nil || *a.active != grant ||
		a.context == nil || a.now == nil || !a.context.validAt(a.now()) {
		return nil, grantRecord{}, errors.New("send unavailable")
	}
	acceptedAtMs := a.now().UnixMilli()
	if acceptedAtMs < grant.AuthorizedAtMs || acceptedAtMs <= 0 || acceptedAtMs > 1<<53-1 {
		return nil, grantRecord{}, errors.New("message clock unavailable")
	}
	emptyFactsDigest, err := canonicalHash([]json.RawMessage{})
	if err != nil {
		return nil, grantRecord{}, errors.New("message facts unavailable")
	}
	message := &helperMessage{requestID: requestID, sourceKey: sourceKey, payloadHash: payloadHash, grant: grant,
		requestHash: requestHash, textDigest: textDigest, acceptedAtMs: acceptedAtMs, factsDigest: emptyFactsDigest}
	record := grantRecord{kind: "send", hash: payloadHash, state: "dispatching", message: message}
	a.records[requestID] = record
	a.sourceOperations[sourceKey] = requestID
	a.inFlight = true
	a.activeRequestID = requestID
	boundary := &writeBoundary{shared: &a.mu}
	boundary.onFirstAttempt = func() bool {
		at := a.now().UnixMilli()
		if at < message.acceptedAtMs || at > 1<<53-1 {
			return false
		}
		message.firstWriteAttemptAtMs = &at
		return true
	}
	boundary.current = func() bool {
		return a.inFlight && a.activeRequestID == requestID && a.active != nil && *a.active == grant &&
			a.context != nil && a.now != nil && a.context.validAt(a.now())
	}
	message.boundary = boundary
	return boundary, cloneGrantRecord(record), nil
}

// finishSend is called only after the original operation and every write
// continuation have stopped. A failed Write remains attempted even at 0 bytes.
func (a *helperGrants) finishSend(requestID string, boundary *writeBoundary) (grantRecord, error) {
	return a.finishSendWithResponse(requestID, boundary, nil)
}

func (a *helperGrants) finishSendWithResponse(requestID string, boundary *writeBoundary, response *responseEvidence) (grantRecord, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	record, ok := a.records[requestID]
	if !ok || record.kind != "send" || record.message == nil || !a.inFlight || a.activeRequestID != requestID ||
		boundary == nil || record.message.boundary != boundary || boundary.shared != &a.mu {
		return grantRecord{}, errors.New("unknown message execution")
	}
	work := record.message.syncWork
	if work == nil {
		return grantRecord{}, errors.New("original worker is missing")
	}
	select {
	case <-work.done:
	default:
		return grantRecord{}, errors.New("original worker has not joined")
	}
	boundary.revoked = true
	record.message.writeAttempted = boundary.attempted
	record.message.executionEnded = true
	joinedAt := a.now().UnixMilli()
	var witness [16]byte
	clockValid := joinedAt >= record.message.acceptedAtMs && joinedAt <= 1<<53-1 &&
		(record.message.firstWriteAttemptAtMs == nil || joinedAt >= *record.message.firstWriteAttemptAtMs)
	witnessErr := error(nil)
	if clockValid {
		_, witnessErr = rand.Read(witness[:])
	}
	if clockValid && witnessErr == nil {
		record.message.joinedWitnessID = hex.EncodeToString(witness[:])
		record.message.joinedAtMs = joinedAt
	}
	if response != nil {
		record.message.responseStatus = response.status
		record.message.responseLength = response.length
		record.message.responseDigest = response.digest
	}
	if !clockValid || witnessErr != nil {
		record.state = "unknown"
		record.message.unknownObserved = true
	} else if boundary.attempted && response != nil && response.success {
		record.state = "api_reported_success"
	} else if boundary.attempted {
		record.state = "unknown"
		record.message.unknownObserved = true
	} else {
		record.state = "terminal_not_dispatched"
	}
	a.records[requestID] = record
	a.inFlight = false
	a.activeRequestID = ""
	return cloneGrantRecord(record), nil
}

// attachSyncWork associates the registered request with its sole original
// worker before any dial or HTTP work is started.
func (a *helperGrants) attachSyncWork(requestID string, boundary *writeBoundary, work *syncHTTPWork) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	record, ok := a.records[requestID]
	if !ok || record.kind != "send" || record.message == nil || record.message.boundary != boundary ||
		!a.inFlight || a.activeRequestID != requestID || record.message.syncWork != nil {
		return false
	}
	record.message.syncWork = work
	if boundary.revoked || a.active == nil || *a.active != record.message.grant {
		work.sealLocked()
	}
	a.records[requestID] = record
	return true
}

// A network operation whose internal transport continuations have not been
// proven terminated remains held, including when no Write was observed yet.
func (a *helperGrants) holdNetworkUnknown(requestID string, boundary *writeBoundary) (grantRecord, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	record, ok := a.records[requestID]
	if !ok || record.kind != "send" || record.message == nil || !a.inFlight || a.activeRequestID != requestID ||
		boundary == nil || record.message.boundary != boundary {
		return grantRecord{}, errors.New("unknown message execution")
	}
	boundary.revoked = true
	record.message.writeAttempted = boundary.attempted
	record.message.executionEnded = false
	record.state = "unknown"
	record.message.unknownObserved = true
	a.records[requestID] = record
	return cloneGrantRecord(record), nil
}

// bind commits under the same mutex used by the application's Write guard.
// A repeated ID returns its original record; no capacity eviction is allowed.
func (a *helperGrants) bind(p grantProposal) (grantRecord, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	hash := proposalDigest(p)
	if hash == "" {
		return grantRecord{}, errors.New("invalid operation payload")
	}
	if previous, ok := a.records[p.AuthorizationID]; ok {
		if previous.kind != "authorize" || previous.hash != hash {
			return grantRecord{}, errors.New("operation conflict")
		}
		return cloneGrantRecord(previous), nil
	}
	if !validIdentifier(p.AuthorizationID) || a.capacity <= 0 || len(a.records) >= a.capacity {
		return grantRecord{}, errors.New("operation unavailable")
	}
	record := grantRecord{kind: "authorize", hash: hash, state: "rejected", target: p.AuthorizationID}
	if a.cancelledAuth[p.AuthorizationID] || a.cancelledCaptures[p.CaptureID] {
		record.state = "revoked"
		a.records[p.AuthorizationID] = record
		return record, nil
	}
	if a.active != nil || a.inFlight || a.messageHeldLocked() || a.captureBusy {
		return grantRecord{}, errors.New("authorization busy")
	}
	if !a.validProposal(p) {
		a.records[p.AuthorizationID] = record
		return record, nil
	}
	timestamp := a.now().UnixMilli()
	if timestamp <= 0 || timestamp < p.LiveEpochStartedAtMs || timestamp < a.lastCommitMs || !a.context.validAt(time.UnixMilli(timestamp)) {
		a.records[p.AuthorizationID] = record
		return record, nil
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		a.records[p.AuthorizationID] = record
		return record, nil
	}
	grant := committedGrant{grantProposal: p, GrantID: hex.EncodeToString(id[:]), AuthorizedAtMs: timestamp}
	a.lastCommitMs = timestamp
	a.active = &grant
	record.state = "authorized"
	record.grant = &grant
	a.records[p.AuthorizationID] = record
	return cloneGrantRecord(record), nil
}

type helperRevoke struct {
	ID          string `json:"id"`
	HelperNonce string `json:"helperNonce"`
	Kind        string `json:"kind"`
	TargetID    string `json:"targetId"`
	GrantID     string `json:"grantId,omitempty"`
}

func (a *helperGrants) revoke(request helperRevoke) (grantRecord, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.context == nil || request.HelperNonce != a.context.processNonce || !validIdentifier(request.ID) ||
		!validIdentifier(request.TargetID) || (request.Kind != "authorization" && request.Kind != "capture") ||
		(request.Kind == "capture" && request.GrantID != "") {
		return grantRecord{}, errors.New("invalid revoke")
	}
	hash, err := canonicalHash(request)
	if err != nil {
		return grantRecord{}, errors.New("invalid operation payload")
	}
	if previous, ok := a.records[request.ID]; ok {
		if previous.kind != "revoke" || previous.hash != hash {
			return grantRecord{}, errors.New("operation conflict")
		}
		return cloneGrantRecord(previous), nil
	}
	if len(a.records) >= a.capacity || a.capacity <= 0 {
		return grantRecord{}, errors.New("operation unavailable")
	}
	if request.GrantID != "" {
		original, ok := a.records[request.TargetID]
		if !ok || original.kind != "authorize" || original.grant == nil || original.grant.GrantID != request.GrantID {
			return grantRecord{}, errors.New("target conflict")
		}
	}
	if request.Kind == "capture" {
		a.cancelledCaptures[request.TargetID] = true
		if a.captureID == request.TargetID && a.captureWork != nil {
			a.captureWork.sealLocked()
		}
		if original, ok := a.records[request.TargetID]; ok && original.kind == "profile" && original.state != "revoked" {
			original.state = "revoked"
			a.records[request.TargetID] = original
		}
	} else {
		a.cancelledAuth[request.TargetID] = true
	}
	if a.active != nil && ((request.Kind == "capture" && a.active.CaptureID == request.TargetID) ||
		(request.Kind == "authorization" && a.active.AuthorizationID == request.TargetID)) {
		if activeMessage, ok := a.records[a.activeRequestID]; ok && activeMessage.message != nil && activeMessage.message.syncWork != nil {
			activeMessage.message.syncWork.sealLocked()
		}
		original := a.records[a.active.AuthorizationID]
		original.state = "revoked"
		a.records[a.active.AuthorizationID] = original
		a.active = nil
	}
	if a.qualification != nil && request.Kind == "capture" && a.qualification.captureID == request.TargetID {
		a.qualification = nil
	}
	record := grantRecord{kind: "revoke", hash: hash, state: "revoked", target: request.TargetID, capture: request.Kind == "capture"}
	a.records[request.ID] = record
	return record, nil
}
