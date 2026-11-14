package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func writeFixtureFrame(t *testing.T, writer io.Writer, authority *helperGrants, sequence uint64, kind, id string, payload any) {
	t.Helper()
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := canonicalHash(payload)
	if err != nil {
		t.Fatal(err)
	}
	frame := privateFrame{Protocol: privateProtocol, Seq: sequence, Kind: kind, OperationID: id, PayloadHash: hash,
		ExpectedHelperNonce: authority.context.processNonce, AuthContextID: authority.context.contextID,
		AuthContextRevision: authority.revision, MaterialDigest: authority.context.materialDigest, Payload: data}
	if err := writePrivateFrame(writer, frame); err != nil {
		t.Fatal(err)
	}
}

func readFixtureReply(t *testing.T, reader io.Reader) fixtureReply {
	t.Helper()
	var prefix [4]byte
	if _, err := io.ReadFull(reader, prefix[:]); err != nil {
		t.Fatal(err)
	}
	size := binary.BigEndian.Uint32(prefix[:])
	if size == 0 || size > maxFrameBytes {
		t.Fatal("invalid fixture response size")
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(reader, data); err != nil {
		t.Fatal(err)
	}
	var reply fixtureReply
	if err := json.Unmarshal(data, &reply); err != nil {
		t.Fatal(err)
	}
	return reply
}

func TestPrivateFramesRevokeDoesNotSettleOriginalWrite(t *testing.T) {
	var requests atomic.Int32
	fixture := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status_code":0}`)
	}))
	defer fixture.Close()
	authority, proposal := grantFixture(t)
	chat := fixtureTarget(fixture)
	chat.originHost, chat.path = "live.douyin.com", "/webcast/room/chat/"
	entered, release, closed := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	server := &privateServer{authority: authority, chatTarget: &chat, sendHooks: &syncHTTPHooks{
		beforeApplicationWrite: func() { close(entered); <-release },
		afterSupervisorClose:   func() { close(closed) },
	}}
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	defer inputReader.Close()
	defer outputReader.Close()
	serverDone := make(chan error, 1)
	go func() { serverDone <- server.serve(inputReader, outputWriter); outputWriter.Close() }()
	bind := fixtureExchange(t, inputWriter, outputReader, authority, 1, "bindGrant", proposal.AuthorizationID, proposal)
	var commit struct {
		Grant committedGrant `json:"grant"`
	}
	if bind.Status != "authorized" || json.Unmarshal(bind.Payload, &commit) != nil || commit.Grant.GrantID == "" {
		t.Fatal("helper did not commit original grant")
	}
	send := privateSend{RequestID: "original-message", SourceKey: "original-source", RequestHash: strings.Repeat("d", 64), SourceKind: "manual", Grant: commit.Grant, Text: "fixture"}
	writeFixtureFrame(t, inputWriter, authority, 2, "send", send.RequestID, send)
	awaitSignal(t, entered, "original application Write")
	revoke := helperRevoke{ID: "original-revoke", HelperNonce: proposal.HelperProcessNonce, Kind: "authorization",
		TargetID: proposal.AuthorizationID, GrantID: commit.Grant.GrantID}
	ack := fixtureExchange(t, inputWriter, outputReader, authority, 3, "revoke", revoke.ID, revoke)
	if ack.Status != "revoked" {
		t.Fatal("original targeted revoke was not acknowledged")
	}
	awaitSignal(t, closed, "original socket closure")
	authority.mu.Lock()
	active := authority.inFlight
	ended := authority.records[send.RequestID].message.executionEnded
	authority.mu.Unlock()
	if !active || ended {
		t.Fatal("revoke incorrectly settled the active message")
	}
	next := proposal
	next.AuthorizationID = "next-authorization"
	if _, err := authority.bind(next); err == nil {
		t.Fatal("new grant bypassed the original execution")
	}
	releaseOnce.Do(func() { close(release) })
	reply := readFixtureReply(t, outputReader)
	if reply.Status != "unknown" || requests.Load() > 1 {
		t.Fatal("attempted write was settled or replayed incorrectly")
	}
	inputWriter.Close()
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	if !authority.messageHeldLocked() || strings.TrimSpace(send.SourceKey) == "" {
		t.Fatal("unknown original source did not retain its hold")
	}
}

func TestPrivateRecoveryFramesRetainWrittenUnknown(t *testing.T) {
	var requests atomic.Int32
	fixture := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer fixture.Close()
	authority, proposal := grantFixture(t)
	chat := fixtureTarget(fixture)
	chat.originHost, chat.path = "live.douyin.com", "/webcast/room/chat/"
	server := &privateServer{authority: authority, chatTarget: &chat}
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	defer inputReader.Close()
	defer outputReader.Close()
	serverDone := make(chan error, 1)
	go func() { serverDone <- server.serve(inputReader, outputWriter); outputWriter.Close() }()
	bind := fixtureExchange(t, inputWriter, outputReader, authority, 1, "bindGrant", proposal.AuthorizationID, proposal)
	var committed struct {
		Grant committedGrant `json:"grant"`
	}
	if bind.Status != "authorized" || json.Unmarshal(bind.Payload, &committed) != nil || committed.Grant.GrantID == "" {
		t.Fatal("grant was not committed")
	}
	send := privateSend{RequestID: "frame-message", SourceKey: "frame-source", RequestHash: strings.Repeat("d", 64),
		SourceKind: "manual", Grant: committed.Grant, Text: "fixture"}
	result := fixtureExchange(t, inputWriter, outputReader, authority, 2, "send", send.RequestID, send)
	if result.Status != "unknown" || requests.Load() != 1 {
		t.Fatal("original did not remain a single written unknown")
	}
	payloadHash, _ := canonicalHash(send)
	digest := sha256.Sum256([]byte(send.Text))
	ref := messageRef{RequestID: send.RequestID, SourceKey: send.SourceKey, RequestHash: send.RequestHash,
		HelperPayloadHash: payloadHash, TextDigest: hex.EncodeToString(digest[:]), Grant: committed.Grant}
	refDigest, _ := canonicalHash(ref)
	fact, _ := json.Marshal(map[string]any{"kind": "positive_observation", "factId": "fact-frame", "seq": 1,
		"refDigest": refDigest, "hostRecordedAtMs": authority.now().UnixMilli(), "source": "owner", "attributionStrength": "direct",
		"observedAtMs": authority.now().UnixMilli(), "textDigest": ref.TextDigest, "principalUid": "42", "roomId": "101",
		"platformRoomId": "202", "observerRef": nil})
	facts := []json.RawMessage{fact}
	factsDigest, _ := canonicalHash(facts)
	control := helperMessageReconcile{ControlID: "frame-control", Ref: ref, FactsRevision: 1, FactsDigest: factsDigest,
		Facts: facts, OriginControlPayloadHash: strings.Repeat("a", 64)}
	ack := fixtureExchange(t, inputWriter, outputReader, authority, 3, "reconcileMessage", control.ControlID, control)
	if ack.Status != "committed" {
		t.Fatalf("reconcile returned %q", ack.Status)
	}
	var first struct {
		Reconcile struct {
			Receipt recoveryReceipt `json:"receipt"`
		} `json:"reconcile"`
	}
	if json.Unmarshal(ack.Payload, &first) != nil || first.Reconcile.Receipt.RecoveryCommitID == "" {
		t.Fatal("receipt missing")
	}
	query := fixtureExchange(t, inputWriter, outputReader, authority, 4, "query", control.ControlID, struct{}{})
	var second struct {
		Reconcile struct {
			Receipt recoveryReceipt `json:"receipt"`
		} `json:"reconcile"`
	}
	if query.Status != "committed" || json.Unmarshal(query.Payload, &second) != nil ||
		second.Reconcile.Receipt.RecoveryCommitID != first.Reconcile.Receipt.RecoveryCommitID {
		t.Fatal("original receipt changed")
	}
	replay := fixtureExchange(t, inputWriter, outputReader, authority, 5, "send", send.RequestID, send)
	if replay.Status != "unknown" || requests.Load() != 1 {
		t.Fatal("original message was resent or rewritten")
	}
	inputWriter.Close()
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}

func TestPrivateSendFifteenSecondBudgetDoesNotJoinLateDial(t *testing.T) {
	fixture := newOwnedTLSServer(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("late dial must not reach the TLS fixture")
	}))
	defer fixture.Close()
	target := fixtureTarget(fixture)
	target.originHost, target.path = "live.douyin.com", "/webcast/room/chat/"
	entered, release, peerDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	target.dial = func(context.Context, string, string) (net.Conn, error) {
		close(entered)
		<-release
		client, peer := net.Pipe()
		go func() {
			defer peer.Close()
			defer close(peerDone)
			var first [1]byte
			if n, _ := peer.Read(first[:]); n != 0 {
				t.Error("late socket received TLS or HTTP bytes")
			}
		}()
		return client, nil
	}
	authority, proposal := grantFixture(t)
	server := &privateServer{authority: authority, chatTarget: &target}
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	defer inputReader.Close()
	defer outputReader.Close()
	serverDone := make(chan error, 1)
	go func() { serverDone <- server.serve(inputReader, outputWriter); outputWriter.Close() }()
	bind := fixtureExchange(t, inputWriter, outputReader, authority, 1, "bindGrant", proposal.AuthorizationID, proposal)
	var committed struct {
		Grant committedGrant `json:"grant"`
	}
	if bind.Status != "authorized" || json.Unmarshal(bind.Payload, &committed) != nil || committed.Grant.GrantID == "" {
		t.Fatal("original grant was not committed")
	}
	send := privateSend{RequestID: "budget-message", SourceKey: "budget-source", RequestHash: strings.Repeat("d", 64),
		SourceKind: "manual", Grant: committed.Grant, Text: "fixture"}
	started := time.Now()
	writeFixtureFrame(t, inputWriter, authority, 2, "send", send.RequestID, send)
	awaitSignal(t, entered, "original late dial")
	replies := make(chan fixtureReply, 1)
	go func() { replies <- readFixtureReply(t, outputReader) }()
	var unknown fixtureReply
	select {
	case unknown = <-replies:
	case <-time.After(18 * time.Second):
		t.Fatal("original fifteen-second result budget did not return")
	}
	if elapsed := time.Since(started); elapsed < 14*time.Second || unknown.Status != "unknown" {
		t.Fatalf("unexpected original budget result: elapsed=%s status=%s", elapsed, unknown.Status)
	}
	authority.mu.Lock()
	active := authority.inFlight
	ended := authority.records[send.RequestID].message.executionEnded
	authority.mu.Unlock()
	if !active || ended {
		t.Fatal("result budget incorrectly released the original worker")
	}
	revoke := helperRevoke{ID: "budget-revoke", HelperNonce: proposal.HelperProcessNonce, Kind: "authorization",
		TargetID: proposal.AuthorizationID, GrantID: committed.Grant.GrantID}
	ack := fixtureExchange(t, inputWriter, outputReader, authority, 3, "revoke", revoke.ID, revoke)
	if ack.Status != "revoked" {
		t.Fatal("original revoke was not acknowledged")
	}
	authority.mu.Lock()
	active = authority.inFlight
	ended = authority.records[send.RequestID].message.executionEnded
	authority.mu.Unlock()
	if !active || ended {
		t.Fatal("revoke ACK incorrectly joined the original dial")
	}
	releaseOnce.Do(func() { close(release) })
	awaitSignal(t, peerDone, "late socket closure")
	deadline := time.Now().Add(2 * time.Second)
	for {
		authority.mu.Lock()
		active = authority.inFlight
		record := authority.records[send.RequestID]
		authority.mu.Unlock()
		if !active && record.message.executionEnded {
			if record.message.writeAttempted || !record.message.unknownObserved {
				t.Fatal("late original did not preserve its no-write fact and unknown hold")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("late original did not join")
		}
		time.Sleep(time.Millisecond)
	}
	inputWriter.Close()
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}
