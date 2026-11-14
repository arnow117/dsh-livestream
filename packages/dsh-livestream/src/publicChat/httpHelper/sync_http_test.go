package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestOriginalGrantStaysInFlightUntilWorkerAndCleanupJoin(t *testing.T) {
	var requests atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status_code":0}`)
	}))
	defer server.Close()
	authority, proposal := grantFixture(t)
	grant, err := authority.bind(proposal)
	if err != nil || grant.grant == nil {
		t.Fatal("fixture grant was not committed")
	}
	boundary, _, err := authority.beginSend("joined-message", "joined-source", strings.Repeat("d", 64), *grant.grant)
	if err != nil {
		t.Fatal("original message was not registered")
	}
	request, err := buildFixedRequest(authority.context, "chat", grant.grant, "fixture", authority.now())
	if err != nil {
		t.Fatal("fixed request could not be built")
	}
	target := fixtureTarget(server)
	target.originHost, target.path = "live.douyin.com", "/webcast/room/chat/"
	work := newSyncHTTPWork(boundary)
	if !authority.attachSyncWork("joined-message", boundary, work) {
		t.Fatal("registered message did not own worker")
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	work.start(target, request, 2*time.Second, &syncHTTPHooks{beforeCleanup: func() {
		close(entered)
		<-release
	}})
	awaitSignal(t, entered, "original cleanup barrier")
	if _, err := authority.finishSend("joined-message", boundary); err == nil {
		t.Fatal("unfinished worker was accepted as terminated")
	}
	next := proposal
	next.AuthorizationID = "other-authorization"
	if _, err := authority.bind(next); err == nil {
		t.Fatal("active original execution did not retain its slot")
	}
	once.Do(func() { close(release) })
	awaitSignal(t, work.done, "original worker join")
	if _, err := authority.finishSend("joined-message", boundary); err != nil || requests.Load() != 1 {
		t.Fatal("joined original execution was not settled exactly once")
	}
}

func awaitSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatalf("%s did not occur", description)
	}
}

func TestSyncHTTPWaitsForCleanupBeforeJoin(t *testing.T) {
	var requests atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status_code":0}`)
	}))
	defer server.Close()
	request, err := http.NewRequest(http.MethodGet, server.URL+"/chat", nil)
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	work := newSyncHTTPWork(&writeBoundary{current: func() bool { return true }})
	work.start(fixtureTarget(server), request, 2*time.Second, &syncHTTPHooks{beforeCleanup: func() {
		close(entered)
		<-release
	}})
	awaitSignal(t, entered, "cleanup barrier")
	select {
	case <-work.done:
		t.Fatal("request joined before cleanup returned")
	default:
	}
	once.Do(func() { close(release) })
	awaitSignal(t, work.done, "joined request")
	if work.result.err != nil || work.result.status != http.StatusOK || requests.Load() != 1 {
		t.Fatalf("unexpected result: status=%d error=%v requests=%d", work.result.status, work.result.err, requests.Load())
	}
}

func TestSyncHTTPDoesNotJoinWhileApplicationWriteIsPaused(t *testing.T) {
	fixture := newOwnedTLSServer(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer fixture.Close()
	target := fixtureTarget(fixture)
	target.dial = func(context.Context, string, string) (net.Conn, error) {
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			conn := tls.Server(server, &tls.Config{Certificates: fixture.TLS.Certificates, NextProtos: []string{"http/1.1"}})
			if conn.Handshake() == nil {
				_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
			}
		}()
		return client, nil
	}
	authority, proposal := grantFixture(t)
	grant, err := authority.bind(proposal)
	if err != nil || grant.grant == nil {
		t.Fatal("fixture grant was not committed")
	}
	boundary, _, err := authority.beginSend("early-message", "early-source", strings.Repeat("e", 64), *grant.grant)
	if err != nil {
		t.Fatal("original message was not registered")
	}
	request, err := buildFixedRequest(authority.context, "chat", grant.grant, "fixture", authority.now())
	if err != nil {
		t.Fatal(err)
	}
	target.originHost, target.path = "live.douyin.com", "/webcast/room/chat/"
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	work := newSyncHTTPWork(boundary)
	if !authority.attachSyncWork("early-message", boundary, work) {
		t.Fatal("original message did not own its worker")
	}
	work.start(target, request, 2*time.Second, &syncHTTPHooks{beforeApplicationWrite: func() {
		close(entered)
		<-release
	}})
	awaitSignal(t, entered, "application Write barrier")
	select {
	case <-work.done:
		t.Fatal("request joined while the synchronous Write stack remained active")
	default:
	}
	if _, err := authority.finishSend("early-message", boundary); err == nil {
		t.Fatal("active original Write was recorded as terminated")
	}
	if _, err := authority.revoke(helperRevoke{ID: "early-revoke", HelperNonce: proposal.HelperProcessNonce,
		Kind: "authorization", TargetID: proposal.AuthorizationID, GrantID: grant.grant.GrantID}); err != nil {
		t.Fatal("original authorization was not revoked")
	}
	select {
	case <-work.done:
		t.Fatal("revoke incorrectly settled the active original Write")
	default:
	}
	once.Do(func() { close(release) })
	awaitSignal(t, work.done, "joined request")
	result, err := authority.finishSend("early-message", boundary)
	if err != nil || result.state != "unknown" || !result.message.writeAttempted || !result.message.executionEnded {
		t.Fatal("attempted original Write did not remain unknown after join")
	}
}

func TestSyncHTTPLateDialCannotStartTLS(t *testing.T) {
	fixture := newOwnedTLSServer(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer fixture.Close()
	target := fixtureTarget(fixture)
	entered := make(chan struct{})
	release := make(chan struct{})
	peerClosed := make(chan struct{})
	target.dial = func(context.Context, string, string) (net.Conn, error) {
		close(entered)
		<-release
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			defer close(peerClosed)
			var b [1]byte
			if n, _ := server.Read(b[:]); n != 0 {
				t.Error("late connection received TLS bytes")
			}
		}()
		return client, nil
	}
	request, err := http.NewRequest(http.MethodGet, fixture.URL+"/chat", nil)
	if err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	defer once.Do(func() { close(release) })
	boundary := &writeBoundary{current: func() bool { return true }}
	work := newSyncHTTPWork(boundary)
	work.start(target, request, 30*time.Millisecond, nil)
	awaitSignal(t, entered, "dial barrier")
	awaitSignal(t, work.timedOut, "result budget expiration")
	select {
	case <-work.done:
		t.Fatal("pending dial was incorrectly joined")
	default:
	}
	once.Do(func() { close(release) })
	awaitSignal(t, work.done, "late dial cleanup")
	awaitSignal(t, peerClosed, "late connection closure")
	if boundary.wasAttempted() {
		t.Fatal("cancelled late dial reached application Write")
	}
}

func TestOriginalGrantRevokeInterruptsTLSHandshake(t *testing.T) {
	fixture := newOwnedTLSServer(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer fixture.Close()
	target := fixtureTarget(fixture)
	target.originHost, target.path = "live.douyin.com", "/webcast/room/chat/"
	handshakeStarted := make(chan struct{})
	peerDone := make(chan struct{})
	target.dial = func(context.Context, string, string) (net.Conn, error) {
		client, peer := net.Pipe()
		go func() {
			defer peer.Close()
			defer close(peerDone)
			var hello [4096]byte
			if n, _ := peer.Read(hello[:]); n > 0 {
				close(handshakeStarted)
			}
			_, _ = peer.Read(hello[:])
		}()
		return client, nil
	}
	authority, proposal := grantFixture(t)
	grant, err := authority.bind(proposal)
	if err != nil || grant.grant == nil {
		t.Fatal("fixture grant was not committed")
	}
	boundary, _, err := authority.beginSend("tls-message", "tls-source", strings.Repeat("f", 64), *grant.grant)
	if err != nil {
		t.Fatal("original message was not registered")
	}
	request, err := buildFixedRequest(authority.context, "chat", grant.grant, "fixture", authority.now())
	if err != nil {
		t.Fatal("fixed request could not be built")
	}
	work := newSyncHTTPWork(boundary)
	if !authority.attachSyncWork("tls-message", boundary, work) {
		t.Fatal("original message did not own worker")
	}
	work.start(target, request, 2*time.Second, nil)
	awaitSignal(t, handshakeStarted, "TLS handshake")
	if _, err := authority.revoke(helperRevoke{ID: "tls-revoke", HelperNonce: proposal.HelperProcessNonce,
		Kind: "authorization", TargetID: proposal.AuthorizationID, GrantID: grant.grant.GrantID}); err != nil {
		t.Fatal("original authorization was not revoked")
	}
	awaitSignal(t, work.done, "cancelled TLS worker")
	awaitSignal(t, peerDone, "owned TLS peer cleanup")
	result, err := authority.finishSend("tls-message", boundary)
	if err != nil || result.state != "terminal_not_dispatched" || result.message.writeAttempted || !result.message.executionEnded {
		t.Fatal("cancelled TLS operation did not preserve its original terminal facts")
	}
}

func TestOriginalGrantRetainsSlotUntilLateDialJoins(t *testing.T) {
	fixture := newOwnedTLSServer(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer fixture.Close()
	target := fixtureTarget(fixture)
	target.originHost, target.path = "live.douyin.com", "/webcast/room/chat/"
	entered, release, peerDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	target.dial = func(context.Context, string, string) (net.Conn, error) {
		close(entered)
		<-release
		client, peer := net.Pipe()
		go func() {
			defer peer.Close()
			defer close(peerDone)
			var first [1]byte
			if n, _ := peer.Read(first[:]); n != 0 {
				t.Error("late dial reached TLS")
			}
		}()
		return client, nil
	}
	authority, proposal := grantFixture(t)
	grant, err := authority.bind(proposal)
	if err != nil || grant.grant == nil {
		t.Fatal("fixture grant was not committed")
	}
	boundary, _, err := authority.beginSend("late-message", "late-source", strings.Repeat("f", 64), *grant.grant)
	if err != nil {
		t.Fatal("original message was not registered")
	}
	request, err := buildFixedRequest(authority.context, "chat", grant.grant, "fixture", authority.now())
	if err != nil {
		t.Fatal("fixed request could not be built")
	}
	work := newSyncHTTPWork(boundary)
	if !authority.attachSyncWork("late-message", boundary, work) {
		t.Fatal("original message did not own worker")
	}
	work.start(target, request, 30*time.Millisecond, nil)
	awaitSignal(t, entered, "original dial")
	awaitSignal(t, work.timedOut, "original result budget")
	unknown, err := authority.holdNetworkUnknown("late-message", boundary)
	if err != nil || unknown.state != "unknown" || unknown.message.executionEnded {
		t.Fatal("pending dial did not remain unknown and active")
	}
	if _, err := authority.revoke(helperRevoke{ID: "late-revoke", HelperNonce: proposal.HelperProcessNonce,
		Kind: "authorization", TargetID: proposal.AuthorizationID, GrantID: grant.grant.GrantID}); err != nil {
		t.Fatal("original authorization was not revoked")
	}
	if _, err := authority.finishSend("late-message", boundary); err == nil {
		t.Fatal("late dial was incorrectly treated as joined")
	}
	next := proposal
	next.AuthorizationID = "late-next-authorization"
	if _, err := authority.bind(next); err == nil {
		t.Fatal("new authorization bypassed original execution")
	}
	once.Do(func() { close(release) })
	awaitSignal(t, work.done, "original late dial join")
	awaitSignal(t, peerDone, "late socket closure")
	result, err := authority.finishSend("late-message", boundary)
	if err != nil || result.state != "terminal_not_dispatched" || result.message.writeAttempted || !result.message.executionEnded {
		t.Fatal("late dial did not produce its original joined no-write fact")
	}
	if _, err := authority.bind(next); err == nil {
		t.Fatal("original message hold was cleared without reconciliation")
	}
}

func TestSyncHTTPResponseLimitsAndRedirects(t *testing.T) {
	for _, test := range []struct {
		name       string
		status     int
		headerSize int
		bodySize   int
		wantError  bool
	}{
		{"moved permanently", 301, 0, 0, false},
		{"found", 302, 0, 0, false},
		{"temporary redirect", 307, 0, 0, false},
		{"permanent redirect", 308, 0, 0, false},
		{"oversized headers", 200, maxHTTPHeaderBytes + 1024, 0, true},
		{"oversized body", 200, 0, maxResponseBytes + 1, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				if test.headerSize != 0 {
					w.Header().Set("X-Fixture", strings.Repeat("x", test.headerSize))
				}
				w.Header().Set("Location", "/must-not-follow")
				w.WriteHeader(test.status)
				if test.bodySize != 0 {
					_, _ = io.WriteString(w, strings.Repeat("x", test.bodySize))
				}
			}))
			defer server.Close()
			request, err := http.NewRequest(http.MethodGet, server.URL+"/chat", nil)
			if err != nil {
				t.Fatal(err)
			}
			result := runFixtureRequest(t, fixtureTarget(server), request, &writeBoundary{current: func() bool { return true }})
			if (result.err != nil) != test.wantError || requests.Load() != 1 {
				t.Fatalf("unexpected result: error=%v requestCount=%d", result.err, requests.Load())
			}
			if !test.wantError && result.status != test.status {
				t.Fatal("original redirect status was not preserved")
			}
		})
	}
}

func TestSyncHTTPPartialResponseNeverReplays(t *testing.T) {
	var requests atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		connection, buffer, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_, _ = buffer.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nContent-Type: application/json\r\n\r\n{\"status_code\":0}")
		_ = buffer.Flush()
		_ = connection.Close()
	}))
	defer server.Close()
	boundary := &writeBoundary{current: func() bool { return true }}
	request, err := http.NewRequest(http.MethodGet, server.URL+"/chat", nil)
	if err != nil {
		t.Fatal(err)
	}
	result := runFixtureRequest(t, fixtureTarget(server), request, boundary)
	if result.err == nil || requests.Load() != 1 || !boundary.wasAttempted() {
		t.Fatal("partial response did not remain a single attempted operation")
	}
}

func TestSyncHTTPRejectsUnsupportedResponseVersions(t *testing.T) {
	for _, version := range []string{"HTTP/2.0", "HTTP/0.9"} {
		t.Run(version, func(t *testing.T) {
			var requests atomic.Int32
			server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				connection, buffer, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				_, _ = buffer.WriteString(version + " 200 OK\r\nContent-Length: 0\r\n\r\n")
				_ = buffer.Flush()
				_ = connection.Close()
			}))
			defer server.Close()
			request, err := http.NewRequest(http.MethodGet, server.URL+"/chat", nil)
			if err != nil {
				t.Fatal(err)
			}
			boundary := &writeBoundary{current: func() bool { return true }}
			result := runFixtureRequest(t, fixtureTarget(server), request, boundary)
			if result.err == nil || requests.Load() != 1 || !boundary.wasAttempted() {
				t.Fatal("unsupported version was accepted or replayed")
			}
		})
	}
}

func TestOriginalGrantTimeoutKeepsMessageUnknown(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	cleanupEntered, cleanupRelease := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var cleanupOnce sync.Once
	var requests atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		close(entered)
		<-release
		_, _ = io.WriteString(w, `{"status_code":0}`)
	}))
	defer func() {
		once.Do(func() { close(release) })
		cleanupOnce.Do(func() { close(cleanupRelease) })
		server.Close()
	}()
	authority, proposal := grantFixture(t)
	grant, err := authority.bind(proposal)
	if err != nil || grant.grant == nil {
		t.Fatal("fixture grant was not committed")
	}
	boundary, _, err := authority.beginSend("timeout-message", "timeout-source", strings.Repeat("a", 64), *grant.grant)
	if err != nil {
		t.Fatal("original message was not registered")
	}
	request, err := buildFixedRequest(authority.context, "chat", grant.grant, "fixture", authority.now())
	if err != nil {
		t.Fatal("fixed request could not be built")
	}
	target := fixtureTarget(server)
	target.originHost, target.path = "live.douyin.com", "/webcast/room/chat/"
	work := newSyncHTTPWork(boundary)
	if !authority.attachSyncWork("timeout-message", boundary, work) {
		t.Fatal("original message did not own worker")
	}
	work.start(target, request, 100*time.Millisecond, &syncHTTPHooks{beforeCleanup: func() {
		close(cleanupEntered)
		<-cleanupRelease
	}})
	awaitSignal(t, entered, "fixture request")
	awaitSignal(t, work.timedOut, "result budget")
	awaitSignal(t, cleanupEntered, "original cleanup")
	if _, err := authority.holdNetworkUnknown("timeout-message", boundary); err != nil {
		t.Fatal("original timeout did not enter unknown hold")
	}
	once.Do(func() { close(release) })
	cleanupOnce.Do(func() { close(cleanupRelease) })
	awaitSignal(t, work.done, "original timeout worker join")
	result, err := authority.finishSend("timeout-message", boundary)
	if err != nil || result.state != "unknown" || !result.message.executionEnded || !result.message.writeAttempted || requests.Load() != 1 {
		t.Fatal("timed-out original request was incorrectly settled or replayed")
	}
}

func TestSyncHTTPRejectsH2OnlyNegotiationAndProtocolSwitch(t *testing.T) {
	t.Run("h2-only", func(t *testing.T) {
		fixture := newOwnedTLSServer(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		defer fixture.Close()
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		address, ok := listener.Addr().(*net.TCPAddr)
		if !ok || !address.IP.IsLoopback() || address.Port == 3080 || address.Port == 3081 || address.Port == 7390 || address.Port == 8757 {
			t.Fatal("invalid owned fixture listener")
		}
		t.Logf("owned-tls-listener pid=%d port=%d", os.Getpid(), address.Port)
		serverDone := make(chan struct{})
		go func() {
			defer close(serverDone)
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			defer connection.Close()
			server := tls.Server(connection, &tls.Config{Certificates: fixture.TLS.Certificates, NextProtos: []string{"h2"}})
			_ = server.Handshake()
		}()
		request, err := http.NewRequest(http.MethodGet, fixture.URL+"/chat", nil)
		if err != nil {
			t.Fatal(err)
		}
		boundary := &writeBoundary{current: func() bool { return true }}
		target := fixtureTarget(fixture)
		target.address = listener.Addr().String()
		result := runFixtureRequest(t, target, request, boundary)
		awaitSignal(t, serverDone, "h2-only server cleanup")
		if result.err == nil || boundary.wasAttempted() {
			t.Fatalf("h2-only negotiation reached an application write: error=%v attempted=%v", result.err, boundary.wasAttempted())
		}
	})
	t.Run("switching-protocols", func(t *testing.T) {
		var requests atomic.Int32
		server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			requests.Add(1)
			w.Header().Set("Connection", "Upgrade")
			w.Header().Set("Upgrade", "fixture")
			w.WriteHeader(http.StatusSwitchingProtocols)
		}))
		defer server.Close()
		request, err := http.NewRequest(http.MethodGet, server.URL+"/chat", nil)
		if err != nil {
			t.Fatal(err)
		}
		boundary := &writeBoundary{current: func() bool { return true }}
		result := runFixtureRequest(t, fixtureTarget(server), request, boundary)
		if result.err == nil || !boundary.wasAttempted() || requests.Load() != 1 {
			t.Fatal("protocol switch did not remain one attempted, untrusted response")
		}
	})
}

func TestSyncHTTPCountsChunkFramingInTotalLimit(t *testing.T) {
	var requests atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		connection, buffer, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close()
		_, _ = buffer.WriteString("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n")
		chunk := "1;fixture=" + strings.Repeat("x", 100) + "\r\na\r\n"
		for i := 0; i < 25_000; i++ {
			if _, err := buffer.WriteString(chunk); err != nil {
				return
			}
			if err := buffer.Flush(); err != nil {
				return
			}
		}
		_, _ = buffer.WriteString("0\r\n\r\n")
		_ = buffer.Flush()
	}))
	defer server.Close()
	request, err := http.NewRequest(http.MethodGet, server.URL+"/chat", nil)
	if err != nil {
		t.Fatal(err)
	}
	boundary := &writeBoundary{current: func() bool { return true }}
	result := runFixtureRequest(t, fixtureTarget(server), request, boundary)
	if result.err == nil || !boundary.wasAttempted() || requests.Load() != 1 {
		t.Fatal("excess chunk framing did not fail the original single request")
	}
}

func TestOriginalGrantRevokedBeforeSecondSynchronousWrite(t *testing.T) {
	fixture := newOwnedTLSServer(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer fixture.Close()
	authority, proposal := grantFixture(t)
	var material materialInput
	if err := json.Unmarshal(fixtureMaterial(t, authority.now()), &material); err != nil {
		t.Fatal(err)
	}
	material.Cookies[0].Value = strings.Repeat("a", 4000)
	secondCookie := material.Cookies[0]
	secondCookie.Name = "fixture_second"
	secondCookie.Value = strings.Repeat("b", 4000)
	material.Cookies = append(material.Cookies, secondCookie)
	data, err := json.Marshal(material)
	if err != nil {
		t.Fatal(err)
	}
	authContext, err := freezeAuthContext(data, authority.now())
	if err != nil {
		t.Fatal(err)
	}
	authority.context = authContext
	proposal.HelperProcessNonce = authContext.processNonce
	proposal.AuthContextID = authContext.contextID
	proposal.MaterialDigest = authContext.materialDigest
	grant, err := authority.bind(proposal)
	if err != nil || grant.grant == nil {
		t.Fatal("original grant unavailable")
	}
	boundary, _, err := authority.beginSend("multi-write", "multi-source", strings.Repeat("d", 64), *grant.grant)
	if err != nil {
		t.Fatal(err)
	}
	request, err := buildFixedRequest(authContext, "chat", grant.grant, "fixture", authority.now())
	if err != nil {
		t.Fatal(err)
	}
	target := fixtureTarget(fixture)
	target.originHost, target.path = "live.douyin.com", "/webcast/room/chat/"
	peerDone := make(chan struct{})
	target.dial = func(context.Context, string, string) (net.Conn, error) {
		client, peer := net.Pipe()
		go func() {
			defer close(peerDone)
			defer peer.Close()
			server := tls.Server(peer, &tls.Config{Certificates: fixture.TLS.Certificates, NextProtos: []string{"http/1.1"}})
			if server.Handshake() == nil {
				_, _ = io.Copy(io.Discard, server)
			}
		}()
		return client, nil
	}
	work := newSyncHTTPWork(boundary)
	if !authority.attachSyncWork("multi-write", boundary, work) {
		t.Fatal("original worker not attached")
	}
	secondEntered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	var offered, started atomic.Int32
	work.start(target, request, 2*time.Second, &syncHTTPHooks{
		beforeEachWrite: func() {
			if offered.Add(1) == 2 {
				close(secondEntered)
				<-release
			}
		},
		beforeApplicationWrite: func() { started.Add(1) },
	})
	awaitSignal(t, secondEntered, "second synchronous Write boundary")
	if started.Load() != 1 {
		t.Fatal("the original request did not start exactly one Write before the barrier")
	}
	if _, err := authority.revoke(helperRevoke{ID: "multi-revoke", HelperNonce: proposal.HelperProcessNonce,
		Kind: "authorization", TargetID: proposal.AuthorizationID, GrantID: grant.grant.GrantID}); err != nil {
		t.Fatal("original revoke unavailable")
	}
	if _, err := authority.finishSend("multi-write", boundary); err == nil {
		t.Fatal("the blocked Write stack was falsely joined")
	}
	releaseOnce.Do(func() { close(release) })
	awaitSignal(t, work.done, "original multi-write join")
	awaitSignal(t, peerDone, "owned TLS peer cleanup")
	result, err := authority.finishSend("multi-write", boundary)
	if err != nil || result.state != "unknown" || !result.message.writeAttempted || !result.message.executionEnded || started.Load() != 1 {
		t.Fatal("revoked continuation started or the partial original was settled incorrectly")
	}
}
