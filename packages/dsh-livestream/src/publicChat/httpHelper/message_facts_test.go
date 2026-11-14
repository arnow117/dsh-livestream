package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestOriginalMessagePersistsHashesAndFirstWriteTime(t *testing.T) {
	authority, proposal := grantFixture(t)
	commit, err := authority.bind(proposal)
	if err != nil || commit.grant == nil {
		t.Fatal("fixture grant unavailable")
	}
	text := "测试🙂"
	textHash := sha256.Sum256([]byte(text))
	requestHash := strings.Repeat("d", 64)
	boundary, record, err := authority.beginSendWithFacts("message-facts", "source-facts", strings.Repeat("e", 64), requestHash, hex.EncodeToString(textHash[:]), *commit.grant)
	if err != nil || boundary == nil || record.message == nil {
		t.Fatal("original message was not registered")
	}
	if record.message.requestHash != requestHash || record.message.textDigest != hex.EncodeToString(textHash[:]) ||
		record.message.acceptedAtMs != authority.now().UnixMilli() || record.message.firstWriteAttemptAtMs != nil {
		t.Fatal("original facts do not match the registered request")
	}
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	conn := syncGuardedConn{Conn: failingConn{left}, work: newSyncHTTPWork(boundary)}
	if n, writeErr := conn.Write([]byte("fixture")); n != 0 || writeErr != io.ErrUnexpectedEOF {
		t.Fatal("fixture did not fail after the original application Write began")
	}
	if record.message.firstWriteAttemptAtMs != nil {
		t.Fatal("returned registration snapshot unexpectedly changed")
	}
	stored := authority.records["message-facts"].message
	if stored.firstWriteAttemptAtMs == nil || *stored.firstWriteAttemptAtMs != authority.now().UnixMilli() || !boundary.wasAttempted() {
		t.Fatal("the original zero-byte Write was not timestamped")
	}
}

func TestClockRollbackDoesNotStartApplicationWrite(t *testing.T) {
	authority, proposal := grantFixture(t)
	commit, err := authority.bind(proposal)
	if err != nil || commit.grant == nil {
		t.Fatal("fixture grant unavailable")
	}
	boundary, _, err := authority.beginSendWithFacts("clock-message", "clock-source", strings.Repeat("e", 64),
		strings.Repeat("d", 64), strings.Repeat("f", 64), *commit.grant)
	if err != nil {
		t.Fatal("fixture registration failed")
	}
	now := authority.now()
	authority.now = func() time.Time { return now.Add(-time.Millisecond) }
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	conn := syncGuardedConn{Conn: failingConn{left}, work: newSyncHTTPWork(boundary)}
	if _, err := conn.Write([]byte("fixture")); err != errWriteRevoked || boundary.wasAttempted() {
		t.Fatal("clock rollback reached the application Write")
	}
}

func TestNoOriginalWorkerCannotProveJoined(t *testing.T) {
	authority, proposal := grantFixture(t)
	commit, err := authority.bind(proposal)
	if err != nil || commit.grant == nil {
		t.Fatal("fixture grant unavailable")
	}
	boundary, _, err := authority.beginSendWithFacts("no-worker", "no-worker-source", strings.Repeat("e", 64),
		strings.Repeat("d", 64), strings.Repeat("f", 64), *commit.grant)
	if err != nil {
		t.Fatal("fixture registration failed")
	}
	if record, err := authority.finishSend("no-worker", boundary); err == nil {
		t.Fatalf("no original worker was joined; reported state %q", record.state)
	}
	if !authority.inFlight {
		t.Fatal("unjoined original operation released its execution slot")
	}
}

// Existing component tests exercise the same original registration with fixed,
// synthetic hashes; this helper is compiled only into the test executable.
func (a *helperGrants) beginSend(requestID, sourceKey, payloadHash string, grant committedGrant) (*writeBoundary, grantRecord, error) {
	return a.beginSendWithFacts(requestID, sourceKey, payloadHash, strings.Repeat("d", 64), strings.Repeat("e", 64), grant)
}
