package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

type profileRequest struct {
	CaptureID             string `json:"captureId"`
	HelperNonce           string `json:"helperNonce"`
	QualificationRevision uint64 `json:"qualificationRevision"`
	IdentityEpoch         uint64 `json:"identityEpoch"`
}

// captureProfile obtains both responses sequentially using the same frozen
// context. Each synchronous request owns and joins its worker and supervisor.
func (a *helperGrants) captureProfile(request profileRequest, profileTarget, queryTarget tlsTarget) (grantRecord, error) {
	a.mu.Lock()
	if a.context == nil || a.now == nil || request.HelperNonce != a.context.processNonce || !validIdentifier(request.CaptureID) {
		a.mu.Unlock()
		return grantRecord{}, errors.New("invalid profile operation")
	}
	hash, hashErr := canonicalHash(request)
	if hashErr != nil {
		a.mu.Unlock()
		return grantRecord{}, errors.New("invalid profile operation")
	}
	if previous, ok := a.records[request.CaptureID]; ok {
		previous = cloneGrantRecord(previous)
		a.mu.Unlock()
		if previous.kind != "profile" || previous.hash != hash {
			return grantRecord{}, errors.New("operation conflict")
		}
		return previous, nil
	}
	if a.capacity <= 0 || len(a.records) >= a.capacity {
		a.mu.Unlock()
		return grantRecord{}, errors.New("operation unavailable")
	}
	if a.captureBusy || a.inFlight {
		a.mu.Unlock()
		return grantRecord{}, errors.New("profile busy")
	}
	if a.active != nil {
		original := a.records[a.active.AuthorizationID]
		original.state = "revoked"
		a.records[a.active.AuthorizationID] = original
		a.cancelledAuth[a.active.AuthorizationID] = true
		a.active = nil
	}
	a.qualification = nil
	if a.captureID != "" {
		original := a.records[a.captureID]
		if original.kind == "profile" && original.state == "capturing" {
			original.state = "rejected"
			a.records[a.captureID] = original
		}
	}
	a.captureGeneration++
	generation := a.captureGeneration
	a.captureID = request.CaptureID
	record := grantRecord{kind: "profile", hash: hash, state: "capturing", target: request.CaptureID}
	a.records[request.CaptureID] = record
	if a.cancelledCaptures[request.CaptureID] || a.inFlight || !a.context.validAt(a.now()) {
		if a.cancelledCaptures[request.CaptureID] {
			record.state = "revoked"
		} else {
			record.state = "rejected"
		}
		a.records[request.CaptureID] = record
		a.mu.Unlock()
		return record, nil
	}
	context := a.context
	revision := a.revision
	boundary := &writeBoundary{shared: &a.mu}
	boundary.current = func() bool {
		current := a.records[request.CaptureID]
		return a.context == context && a.revision == revision && a.captureGeneration == generation &&
			a.captureID == request.CaptureID && current.state == "capturing" &&
			!a.cancelledCaptures[request.CaptureID] && context.validAt(a.now())
	}
	a.captureBusy = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.captureBusy = false
		a.captureWork = nil
		a.mu.Unlock()
	}()

	var profile, query map[string]any
	var captureErr error
	for _, item := range []struct {
		operation string
		target    tlsTarget
		output    *map[string]any
	}{{"profile_self", profileTarget, &profile}, {"query_user", queryTarget, &query}} {
		a.mu.Lock()
		current := boundary.current()
		now := a.now()
		a.mu.Unlock()
		if !current {
			captureErr = errors.New("profile invalidated")
			break
		}
		wire, err := buildFixedRequest(context, item.operation, nil, "", now)
		if err != nil {
			captureErr = err
			break
		}
		work := newSyncHTTPWork(boundary)
		a.mu.Lock()
		if !boundary.current() {
			a.mu.Unlock()
			captureErr = errors.New("profile invalidated")
			break
		}
		a.captureWork = work
		a.mu.Unlock()
		work.start(item.target, wire, 15*time.Second, nil)
		// A timed-out or revoked dial retains capture ownership until the
		// original worker and its supervisor have actually joined.
		<-work.done
		a.mu.Lock()
		if a.captureWork == work {
			a.captureWork = nil
		}
		stillCurrent := boundary.current()
		a.mu.Unlock()
		if !stillCurrent || work.result.err != nil {
			captureErr = errors.New("profile unavailable")
			break
		}
		object, ok := parseResponseObject(work.result.status, work.result.contentType, work.result.body)
		if !ok {
			captureErr = errors.New("profile unavailable")
			break
		}
		*item.output = object
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	record = a.records[request.CaptureID]
	if record.state != "capturing" {
		return cloneGrantRecord(record), nil
	}
	uid, ok := principalUID(query["user_uid"])
	if captureErr != nil || !boundary.current() || !ok || uid != a.deployment.principalUID || profile == nil {
		record.state = "rejected"
		a.records[request.CaptureID] = record
		return record, nil
	}
	// Check identity fields only where they name the profile's own user.
	if own, ok := profile["user"].(map[string]any); ok {
		for _, key := range []string{"uid", "user_uid"} {
			if value, exists := own[key]; exists {
				candidate, valid := principalUID(value)
				if !valid || candidate != uid {
					record.state = "rejected"
					a.records[request.CaptureID] = record
					return record, nil
				}
			}
		}
	}
	capturedAtMs := a.now().UnixMilli()
	proof := struct {
		CaptureID, ContextID, HelperNonce, MaterialDigest, PrincipalUID string
		Revision, IdentityEpoch                                         uint64
		CapturedAtMs                                                    int64
	}{request.CaptureID, context.contextID, context.processNonce, context.materialDigest, uid,
		request.QualificationRevision, request.IdentityEpoch, capturedAtMs}
	proofBytes, _ := json.Marshal(proof)
	proofDigest := sha256.Sum256(proofBytes)
	qualification := &helperQualification{captureID: request.CaptureID, digest: hex.EncodeToString(proofDigest[:]),
		principalUID: uid, revision: request.QualificationRevision, identityEpoch: request.IdentityEpoch, capturedAtMs: capturedAtMs}
	a.qualification = qualification
	record.state = "qualified"
	record.qualification = qualification
	a.records[request.CaptureID] = record
	return cloneGrantRecord(record), nil
}
