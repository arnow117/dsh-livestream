package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

func newOwnedTLSServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	address, ok := server.Listener.Addr().(*net.TCPAddr)
	if !ok || !address.IP.IsLoopback() || address.Port == 3080 || address.Port == 3081 || address.Port == 7390 || address.Port == 8757 {
		server.Close()
		t.Fatal("invalid owned fixture listener")
	}
	t.Logf("owned-tls-listener pid=%d port=%d", os.Getpid(), address.Port)
	server.StartTLS()
	return server
}

func fixtureTarget(server *httptest.Server) tlsTarget {
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	origin, err := url.Parse(server.URL)
	if err != nil {
		panic(err)
	}
	return tlsTarget{address: server.Listener.Addr().String(), serverName: "example.com",
		config: &tls.Config{RootCAs: roots}, originHost: origin.Host, path: "/chat"}
}

func runFixtureRequest(t *testing.T, target tlsTarget, request *http.Request, boundary *writeBoundary) syncHTTPResult {
	t.Helper()
	work := newSyncHTTPWork(boundary)
	work.start(target, request, 2*time.Second, nil)
	awaitSignal(t, work.done, "request completion")
	return work.result
}

func TestRejectsOtherTargetBeforeDial(t *testing.T) {
	var requests atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	defer server.Close()
	boundary := &writeBoundary{current: func() bool { return true }}
	request, err := http.NewRequest(http.MethodGet, server.URL+"/other", nil)
	if err != nil {
		t.Fatal(err)
	}
	result := runFixtureRequest(t, fixtureTarget(server), request, boundary)
	if result.err == nil || boundary.wasAttempted() || requests.Load() != 0 {
		t.Fatal("other path was not rejected before dial")
	}
}

func TestOneShotRedirectAndCookieIsolation(t *testing.T) {
	var requests atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("Cookie") != "fixture=frozen" {
			t.Error("unexpected frozen cookie header")
		}
		http.SetCookie(w, &http.Cookie{Name: "fixture", Value: "replacement"})
		w.Header().Set("Location", "/redirected")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	for range 2 {
		boundary := &writeBoundary{current: func() bool { return true }}
		request, err := http.NewRequest(http.MethodGet, server.URL+"/chat", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Cookie", "fixture=frozen")
		result := runFixtureRequest(t, fixtureTarget(server), request, boundary)
		if result.err != nil || result.status != http.StatusTemporaryRedirect || !boundary.wasAttempted() {
			t.Fatal("redirect or write boundary was not preserved")
		}
	}
	if requests.Load() != 2 {
		t.Fatalf("got %d requests, want two original requests", requests.Load())
	}
}

func TestOneShotEOFDoesNotReplay(t *testing.T) {
	var requests atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		connection.Close()
	}))
	defer server.Close()
	boundary := &writeBoundary{current: func() bool { return true }}
	request, err := http.NewRequest(http.MethodGet, server.URL+"/chat", nil)
	if err != nil {
		t.Fatal(err)
	}
	result := runFixtureRequest(t, fixtureTarget(server), request, boundary)
	if result.err == nil || !boundary.wasAttempted() || requests.Load() != 1 {
		t.Fatalf("expected one attempted request and EOF, got count=%d error=%v", requests.Load(), result.err)
	}
}

func TestRevocationBeforeApplicationWrite(t *testing.T) {
	var requests atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	defer server.Close()
	boundary := &writeBoundary{current: func() bool { return true }}
	boundary.revoke()
	request, err := http.NewRequest(http.MethodGet, server.URL+"/chat", nil)
	if err != nil {
		t.Fatal(err)
	}
	result := runFixtureRequest(t, fixtureTarget(server), request, boundary)
	if result.err == nil || boundary.wasAttempted() || requests.Load() != 0 {
		t.Fatal("revoked request reached application")
	}
}

type failingConn struct{ net.Conn }

func (f failingConn) Write([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

type blockedConn struct {
	net.Conn
	entered chan struct{}
	release chan struct{}
}

func (c blockedConn) Write(p []byte) (int, error) { close(c.entered); <-c.release; return len(p), nil }

func TestRevokeDoesNotSettleInProgressWriteAndBlocksContinuation(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	blocked := blockedConn{Conn: left, entered: make(chan struct{}), release: make(chan struct{})}
	boundary := &writeBoundary{current: func() bool { return true }}
	connection := syncGuardedConn{Conn: blocked, work: newSyncHTTPWork(boundary)}
	writeDone := make(chan struct{})
	go func() { defer close(writeDone); _, _ = connection.Write([]byte("first")) }()
	awaitSignal(t, blocked.entered, "write entry")
	revoked := make(chan struct{})
	go func() { boundary.revoke(); close(revoked) }()
	awaitSignal(t, revoked, "revoke acknowledgement")
	select {
	case <-writeDone:
		t.Fatal("revoke was incorrectly treated as write completion")
	default:
	}
	close(blocked.release)
	awaitSignal(t, writeDone, "write completion")
	if !boundary.wasAttempted() {
		t.Fatal("in-progress write must remain attempted")
	}
	if _, err := connection.Write([]byte("continuation")); !errors.Is(err, errWriteRevoked) {
		t.Fatal("write started after revocation")
	}
}

func TestEveryWriteChecksOriginalBoundary(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	valid := true
	boundary := &writeBoundary{current: func() bool { return valid }}
	connection := syncGuardedConn{Conn: failingConn{left}, work: newSyncHTTPWork(boundary)}
	if _, err := connection.Write([]byte("first")); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatal("expected zero-byte write error")
	}
	if !boundary.wasAttempted() {
		t.Fatal("zero-byte write remains attempted")
	}
	valid = false
	if _, err := connection.Write([]byte("continuation")); !errors.Is(err, errWriteRevoked) {
		t.Fatal("binding change was not rejected")
	}
	boundary.revoke()
	if _, err := connection.Write([]byte("after revoke")); !errors.Is(err, errWriteRevoked) {
		t.Fatal("revoked continuation was not rejected")
	}
}
