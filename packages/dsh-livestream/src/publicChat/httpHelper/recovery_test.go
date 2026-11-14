package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRecoveryRequiresOriginalJoinedAndDirectObservation(t *testing.T) {
	var requests atomic.Int32
	fixture := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer fixture.Close()
	authority, proposal := grantFixture(t)
	committed, err := authority.bind(proposal)
	if err != nil || committed.grant == nil {
		t.Fatal("grant unavailable")
	}
	payloadHash := strings.Repeat("d", 64)
	requestHash := strings.Repeat("e", 64)
	textDigest := strings.Repeat("f", 64)
	boundary, _, err := authority.beginSendWithFacts("recover-message", "recover-source", payloadHash, requestHash, textDigest, *committed.grant)
	if err != nil {
		t.Fatal(err)
	}
	request, err := buildFixedRequest(authority.context, "chat", committed.grant, "fixture", authority.now())
	if err != nil {
		t.Fatal(err)
	}
	target := fixtureTarget(fixture)
	target.originHost, target.path = "live.douyin.com", "/webcast/room/chat/"
	work := newSyncHTTPWork(boundary)
	if !authority.attachSyncWork("recover-message", boundary, work) {
		t.Fatal("worker not registered")
	}
	work.start(target, request, 2*time.Second, nil)
	awaitSignal(t, work.done, "original worker")
	original, err := authority.finishSendWithResponse("recover-message", boundary, &responseEvidence{status: 500})
	if err != nil || original.state != "unknown" || !original.message.writeAttempted {
		t.Fatal("unknown original not retained")
	}
	ref := messageRef{RequestID: "recover-message", SourceKey: "recover-source", RequestHash: requestHash,
		HelperPayloadHash: payloadHash, TextDigest: textDigest, Grant: *committed.grant}
	refDigest, err := canonicalHash(ref)
	if err != nil {
		t.Fatal(err)
	}
	fact, err := json.Marshal(map[string]any{"kind": "positive_observation", "factId": "fact-1", "seq": 1,
		"refDigest": refDigest, "hostRecordedAtMs": authority.now().UnixMilli(), "source": "owner", "attributionStrength": "direct",
		"observedAtMs": authority.now().UnixMilli(), "textDigest": textDigest, "principalUid": "42", "roomId": "101", "platformRoomId": "202", "observerRef": nil})
	if err != nil {
		t.Fatal(err)
	}
	facts := []json.RawMessage{fact}
	factsDigest, err := canonicalHash(facts)
	if err != nil {
		t.Fatal(err)
	}
	req := helperMessageReconcile{ControlID: "control-1", Ref: ref, FactsRevision: 1, FactsDigest: factsDigest,
		Facts: facts, OriginControlPayloadHash: strings.Repeat("a", 64)}
	privateHash, err := canonicalHash(req)
	if err != nil {
		t.Fatal(err)
	}
	result, err := authority.reconcileMessage(req, privateHash)
	if err != nil || result.state != "committed" || result.reconcile == nil || result.reconcile.receipt == nil {
		t.Fatal("valid original observation did not commit")
	}
	replayed, err := authority.reconcileMessage(req, privateHash)
	if err != nil || replayed.reconcile.receipt.RecoveryCommitID != result.reconcile.receipt.RecoveryCommitID {
		t.Fatal("same control did not return the original receipt")
	}
	newControl := req
	newControl.ControlID = "different-control-same-head"
	newHash, _ := canonicalHash(newControl)
	if _, err := authority.reconcileMessage(newControl, newHash); err == nil {
		t.Fatal("a second control recommitted the same fact head")
	}
	if authority.records["recover-message"].state != "unknown" || authority.messageHeldLocked() || requests.Load() != 1 {
		t.Fatal("recovery changed the original outcome or repeated the platform request")
	}
	if duplicate, _, err := authority.beginSendWithFacts("recover-message", "recover-source", payloadHash, requestHash, textDigest, *committed.grant); err != nil || duplicate != nil {
		t.Fatal("original request was allowed another application write")
	}
}

func TestRecoveryWaitsForOriginalCleanupAndDoesNotReplacePendingControl(t *testing.T) {
	var requests atomic.Int32
	fixture := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer fixture.Close()
	authority, proposal := grantFixture(t)
	committed, err := authority.bind(proposal)
	if err != nil || committed.grant == nil {
		t.Fatal("grant unavailable")
	}
	payloadHash, requestHash, textDigest := strings.Repeat("d", 64), strings.Repeat("e", 64), strings.Repeat("f", 64)
	boundary, _, err := authority.beginSendWithFacts("pending-message", "pending-source", payloadHash, requestHash, textDigest, *committed.grant)
	if err != nil {
		t.Fatal(err)
	}
	request, err := buildFixedRequest(authority.context, "chat", committed.grant, "fixture", authority.now())
	if err != nil {
		t.Fatal(err)
	}
	target := fixtureTarget(fixture)
	target.originHost, target.path = "live.douyin.com", "/webcast/room/chat/"
	work := newSyncHTTPWork(boundary)
	if !authority.attachSyncWork("pending-message", boundary, work) {
		t.Fatal("worker not registered")
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	work.start(target, request, 2*time.Second, &syncHTTPHooks{beforeCleanup: func() { close(entered); <-release }})
	awaitSignal(t, entered, "cleanup barrier")
	if _, err := authority.holdNetworkUnknown("pending-message", boundary); err != nil {
		t.Fatal(err)
	}
	ref := messageRef{RequestID: "pending-message", SourceKey: "pending-source", RequestHash: requestHash,
		HelperPayloadHash: payloadHash, TextDigest: textDigest, Grant: *committed.grant}
	refDigest, _ := canonicalHash(ref)
	fact, _ := json.Marshal(map[string]any{"kind": "positive_observation", "factId": "fact-1", "seq": 1,
		"refDigest": refDigest, "hostRecordedAtMs": authority.now().UnixMilli(), "source": "owner", "attributionStrength": "direct",
		"observedAtMs": authority.now().UnixMilli(), "textDigest": textDigest, "principalUid": "42", "roomId": "101", "platformRoomId": "202", "observerRef": nil})
	facts := []json.RawMessage{fact}
	factsDigest, _ := canonicalHash(facts)
	control := helperMessageReconcile{ControlID: "pending-control", Ref: ref, FactsRevision: 1, FactsDigest: factsDigest,
		Facts: facts, OriginControlPayloadHash: strings.Repeat("a", 64)}
	controlHash, _ := canonicalHash(control)
	first, err := authority.reconcileMessage(control, controlHash)
	if err != nil || first.state != "pending_join" || !authority.inFlight {
		t.Fatal("unjoined original did not remain pending")
	}
	other := control
	other.ControlID = "different-control"
	otherHash, _ := canonicalHash(other)
	if _, err := authority.reconcileMessage(other, otherHash); err == nil {
		t.Fatal("new control replaced a pending original")
	}
	releaseOnce.Do(func() { close(release) })
	awaitSignal(t, work.done, "original worker")
	if _, err := authority.finishSendWithResponse("pending-message", boundary, nil); err != nil {
		t.Fatal(err)
	}
	final, err := authority.reconcileMessage(control, controlHash)
	if err != nil || final.state != "committed" || final.reconcile.receipt == nil || requests.Load() != 1 {
		t.Fatal("original control did not resume after the original worker joined")
	}
}

func TestNeverWrittenRecoveryRequiresOriginalJoinedAndRejectsContradictoryObservation(t *testing.T) {
	for _, observed := range []bool{false, true} {
		name := "never-written"
		if observed {
			name = "contradictory-observation"
		}
		t.Run(name, func(t *testing.T) {
			authority, proposal := grantFixture(t)
			committed, err := authority.bind(proposal)
			if err != nil || committed.grant == nil {
				t.Fatal("grant unavailable")
			}
			payloadHash, requestHash, textDigest := strings.Repeat("d", 64), strings.Repeat("e", 64), strings.Repeat("f", 64)
			boundary, _, err := authority.beginSendWithFacts("never-message", "never-source", payloadHash, requestHash, textDigest, *committed.grant)
			if err != nil {
				t.Fatal(err)
			}
			work := newSyncHTTPWork(boundary)
			if !authority.attachSyncWork("never-message", boundary, work) {
				t.Fatal("original worker not attached")
			}
			work.startPrepared(func() (tlsTarget, *http.Request, error) {
				return tlsTarget{}, nil, errors.New("fixture preparation failed before dial")
			}, time.Second, nil)
			awaitSignal(t, work.done, "never-written original worker")
			original, err := authority.finishSendWithResponse("never-message", boundary, nil)
			if err != nil || original.state != "terminal_not_dispatched" || original.message.writeAttempted ||
				!original.message.executionEnded || original.message.joinedWitnessID == "" {
				t.Fatal("missing original joined never-written terminal")
			}
			ref := messageRef{RequestID: "never-message", SourceKey: "never-source", RequestHash: requestHash,
				HelperPayloadHash: payloadHash, TextDigest: textDigest, Grant: *committed.grant}
			facts := []json.RawMessage{}
			if observed {
				refDigest, _ := canonicalHash(ref)
				fact, _ := json.Marshal(map[string]any{"kind": "positive_observation", "factId": "fact-1", "seq": 1,
					"refDigest": refDigest, "hostRecordedAtMs": authority.now().UnixMilli(), "source": "owner", "attributionStrength": "direct",
					"observedAtMs": authority.now().UnixMilli(), "textDigest": textDigest, "principalUid": "42", "roomId": "101",
					"platformRoomId": "202", "observerRef": nil})
				facts = append(facts, fact)
			}
			factsDigest, _ := canonicalHash(facts)
			control := helperMessageReconcile{ControlID: "never-control", Ref: ref, FactsRevision: len(facts),
				FactsDigest: factsDigest, Facts: facts, OriginControlPayloadHash: strings.Repeat("a", 64)}
			controlHash, _ := canonicalHash(control)
			result, err := authority.reconcileMessage(control, controlHash)
			if err != nil {
				t.Fatal(err)
			}
			if observed {
				if result.state != "held" || !authority.messageHeldLocked() {
					t.Fatal("contradictory observation did not retain the hold")
				}
				return
			}
			if result.state != "committed" || result.reconcile == nil || result.reconcile.receipt == nil ||
				result.reconcile.receipt.Decision != "never_written_released" || result.reconcile.receipt.WriteAttempted ||
				authority.messageHeldLocked() {
				t.Fatal("joined never-written original did not commit its receipt")
			}
		})
	}
}
