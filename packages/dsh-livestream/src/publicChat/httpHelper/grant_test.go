package main

import (
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

func grantFixture(t *testing.T) (*helperGrants, grantProposal) {
	t.Helper()
	now := time.Now().Truncate(time.Second)
	context, err := freezeAuthContext(fixtureMaterial(t, now), now)
	if err != nil {
		t.Fatal(err)
	}
	deployment := helperFixedDeployment{buildDigest: strings.Repeat("a", 64), instanceID: "instance",
		senderNonce: "sender", accountRecordID: "record", principalUID: "42", roomID: "101"}
	authority := newHelperGrants(context, deployment, 1, func() time.Time { return now }, 32)
	proposal := grantProposal{
		Version: "dsh-public-chat-v1", TransportKind: "frozen_http", BuildDigest: strings.Repeat("a", 64),
		InstanceID: "instance", SenderProcessNonce: "sender", SenderConnectionGeneration: 1,
		AuthorizationID: "authorization", CaptureID: "capture", QualificationDigest: strings.Repeat("b", 64),
		QualificationRevision: 1, IdentityEpoch: 1, AccountRecordID: "record", PrincipalUID: "42",
		RoomID: "101", PlatformRoomID: "202", HelperProcessNonce: context.processNonce,
		AuthContextID: context.contextID, AuthContextRevision: 1, MaterialDigest: context.materialDigest,
		RawSourceSessionID: "session", RawSourceConnectionGeneration: 1, RawBrowserContextID: "raw-context",
		RoomBindingProofDigest: strings.Repeat("c", 64), InputConnectionGeneration: 1,
		LiveEpoch: "live", LiveEpochStartedAtMs: now.Add(-time.Second).UnixMilli(),
	}
	authority.qualification = &helperQualification{captureID: proposal.CaptureID, digest: proposal.QualificationDigest,
		principalUID: proposal.PrincipalUID, revision: proposal.QualificationRevision, identityEpoch: proposal.IdentityEpoch, capturedAtMs: now.UnixMilli()}
	return authority, proposal
}

func TestMessageWriteUnknownSurvivesRevokeAndBlocksNewGrant(t *testing.T) {
	authority, proposal := grantFixture(t)
	committed, err := authority.bind(proposal)
	if err != nil || committed.grant == nil {
		t.Fatal("missing committed grant")
	}
	boundary, _, err := authority.beginSend("request", "source", strings.Repeat("d", 64), *committed.grant)
	if err != nil || boundary == nil {
		t.Fatal("send did not register")
	}
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	work := newSyncHTTPWork(boundary)
	if !authority.attachSyncWork("request", boundary, work) {
		t.Fatal("original worker was not registered")
	}
	connection := syncGuardedConn{Conn: failingConn{left}, work: work}
	type writeResult struct {
		n   int
		err error
	}
	firstResult := make(chan writeResult, 1)
	continueWrite := make(chan struct{})
	var release sync.Once
	defer release.Do(func() { close(continueWrite) })
	secondResult := make(chan error, 1)
	go func() {
		n, writeErr := connection.Write([]byte("fixture"))
		firstResult <- writeResult{n: n, err: writeErr}
		<-continueWrite
		_, writeErr = connection.Write([]byte("continuation"))
		secondResult <- writeErr
		close(work.done)
	}()
	first := <-firstResult
	if first.n != 0 || first.err != io.ErrUnexpectedEOF {
		t.Fatal("expected zero-byte failure after Write began")
	}
	if _, err := authority.revoke(helperRevoke{ID: "revoke", HelperNonce: proposal.HelperProcessNonce,
		Kind: "authorization", TargetID: proposal.AuthorizationID, GrantID: committed.grant.GrantID}); err != nil {
		t.Fatal("revoke failed")
	}
	release.Do(func() { close(continueWrite) })
	if err := <-secondResult; err != errWriteRevoked {
		t.Fatal("write began after revoke")
	}
	<-work.done
	newProposal := proposal
	newProposal.AuthorizationID = "new-authorization"
	if _, err := authority.bind(newProposal); err == nil {
		t.Fatal("new grant accepted while old execution active")
	}
	result, err := authority.finishSend("request", boundary)
	if err != nil || result.state != "unknown" || !result.message.writeAttempted || !result.message.executionEnded {
		t.Fatal("zero-byte attempted write did not remain unknown")
	}
	if _, err := authority.bind(newProposal); err == nil {
		t.Fatal("unknown message allowed a new grant")
	}
	if duplicate, _, err := authority.beginSend("request", "source", strings.Repeat("d", 64), *committed.grant); err != nil || duplicate != nil {
		t.Fatal("duplicate message returned a new write boundary")
	}
}

func TestMaterialExpiryBetweenCommitAndWrite(t *testing.T) {
	authority, proposal := grantFixture(t)
	committed, err := authority.bind(proposal)
	if err != nil || committed.grant == nil {
		t.Fatal("missing committed grant")
	}
	boundary, _, err := authority.beginSend("message", "expiry-source", strings.Repeat("a", 64), *committed.grant)
	if err != nil {
		t.Fatal(err)
	}
	start := authority.now()
	authority.now = func() time.Time { return start.Add(time.Minute) }
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	connection := syncGuardedConn{Conn: failingConn{left}, work: newSyncHTTPWork(boundary)}
	if _, err := connection.Write([]byte("fixture")); err != errWriteRevoked || boundary.wasAttempted() {
		t.Fatal("expired authentication context reached application Write")
	}
}

func TestGrantCommitIdempotencyAndRevoke(t *testing.T) {
	authority, proposal := grantFixture(t)
	first, err := authority.bind(proposal)
	if err != nil || first.state != "authorized" || first.grant == nil {
		t.Fatal("proposal did not commit")
	}
	second, err := authority.bind(proposal)
	if err != nil || second.grant == nil || *second.grant != *first.grant {
		t.Fatal("same ID did not retain the original commit")
	}
	changed := proposal
	changed.RoomID = "303"
	if _, err = authority.bind(changed); err == nil {
		t.Fatal("same ID with changed payload was accepted")
	}
	revoke := helperRevoke{ID: "revoke", HelperNonce: proposal.HelperProcessNonce,
		Kind: "authorization", TargetID: proposal.AuthorizationID, GrantID: first.grant.GrantID}
	if record, err := authority.revoke(revoke); err != nil || record.state != "revoked" {
		t.Fatal("targeted revoke failed")
	}
	if replay, err := authority.bind(proposal); err != nil || replay.state != "revoked" {
		t.Fatal("revoked authorization revived")
	}
}

func TestCaptureTombstoneDoesNotRevokeLaterCapture(t *testing.T) {
	authority, old := grantFixture(t)
	if _, err := authority.revoke(helperRevoke{ID: "cancel-old", HelperNonce: old.HelperProcessNonce,
		Kind: "capture", TargetID: old.CaptureID}); err != nil {
		t.Fatal(err)
	}
	if record, err := authority.bind(old); err != nil || record.state != "revoked" {
		t.Fatal("old capture revived")
	}
	newProposal := old
	newProposal.AuthorizationID, newProposal.CaptureID = "new-authorization", "new-capture"
	authority.qualification = &helperQualification{captureID: newProposal.CaptureID, digest: newProposal.QualificationDigest,
		principalUID: newProposal.PrincipalUID, revision: newProposal.QualificationRevision, identityEpoch: newProposal.IdentityEpoch, capturedAtMs: authority.now().UnixMilli()}
	if record, err := authority.bind(newProposal); err != nil || record.state != "authorized" {
		t.Fatal("old capture tombstone affected later capture")
	}
	if _, err := authority.revoke(helperRevoke{ID: "cancel-old-again", HelperNonce: old.HelperProcessNonce,
		Kind: "capture", TargetID: old.CaptureID}); err != nil || authority.active == nil {
		t.Fatal("old capture cancellation affected later grant")
	}
}

func TestRejectedGrantCannotBeReissued(t *testing.T) {
	authority, proposal := grantFixture(t)
	authority.qualification = nil
	if record, err := authority.bind(proposal); err != nil || record.state != "rejected" {
		t.Fatal("unqualified proposal was not recorded as rejected")
	}
	authority.qualification = &helperQualification{captureID: proposal.CaptureID, digest: proposal.QualificationDigest,
		principalUID: proposal.PrincipalUID, revision: proposal.QualificationRevision, identityEpoch: proposal.IdentityEpoch, capturedAtMs: authority.now().UnixMilli()}
	if record, err := authority.bind(proposal); err != nil || record.state != "rejected" || authority.active != nil {
		t.Fatal("rejected authorization was reissued")
	}
}
