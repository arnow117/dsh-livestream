package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/netip"
	"time"
)

// These limits include the HTTP status line, headers, chunk framing and body.
const maxHTTPWireBytes = 2 << 20
const maxHTTPHeaderBytes = 64 << 10

type syncHTTPHooks struct {
	beforeWrite            func()
	beforeEachWrite        func()
	beforeApplicationWrite func()
	beforeCleanup          func()
	afterSupervisorClose   func()
}

type syncGuardedConn struct {
	net.Conn
	work  *syncHTTPWork
	hooks *syncHTTPHooks
}

func (c *syncGuardedConn) Write(p []byte) (int, error) {
	if c.hooks != nil && c.hooks.beforeEachWrite != nil {
		c.hooks.beforeEachWrite()
	}
	b := c.work.boundary
	b.mutex().Lock()
	if b.revoked || b.current == nil || !b.current() || c.work.isSealed() {
		b.mutex().Unlock()
		return 0, errWriteRevoked
	}
	if !b.attempted && b.onFirstAttempt != nil && !b.onFirstAttempt() {
		b.mutex().Unlock()
		return 0, errWriteRevoked
	}
	// This guarded application Write has started. A revoke may acknowledge
	// afterwards, but cannot settle this in-flight call or start a later one.
	b.attempted = true
	b.mutex().Unlock()
	if c.hooks != nil && c.hooks.beforeApplicationWrite != nil {
		c.hooks.beforeApplicationWrite()
	}
	return c.Conn.Write(p)
}

type httpBudgetReader struct {
	reader          io.Reader
	remaining       int64
	headerRemaining int64
	readingHeaders  bool
}

func (r *httpBudgetReader) Read(p []byte) (int, error) {
	limit := r.remaining
	if r.readingHeaders && r.headerRemaining < limit {
		limit = r.headerRemaining
	}
	if limit <= 0 {
		return 0, errors.New("HTTP response exceeds limit")
	}
	if int64(len(p)) > limit {
		p = p[:limit]
	}
	n, err := r.reader.Read(p)
	r.remaining -= int64(n)
	if r.readingHeaders {
		r.headerRemaining -= int64(n)
	}
	return n, err
}

func (w *syncHTTPWork) perform(target tlsTarget, request *http.Request, budget time.Duration, hooks *syncHTTPHooks) syncHTTPResult {
	fail := func(err error) syncHTTPResult { return syncHTTPResult{err: err} }
	if request == nil || request.URL == nil || request.Method != http.MethodGet || request.Body != nil ||
		request.ContentLength != 0 || len(request.TransferEncoding) != 0 || len(request.Trailer) != 0 ||
		httptrace.ContextClientTrace(request.Context()) != nil || request.URL.Scheme != "https" ||
		request.URL.Host != target.originHost || request.URL.Path != target.path || request.URL.RawPath != "" ||
		request.URL.Opaque != "" || request.URL.User != nil || request.URL.Fragment != "" || request.Host != target.originHost {
		return fail(errors.New("request does not match fixed operation"))
	}
	address, err := netip.ParseAddrPort(target.address)
	if err != nil || !address.Addr().IsValid() || address.Addr().IsUnspecified() {
		return fail(errors.New("target is not a prepared numeric address"))
	}
	if w.isSealed() {
		return fail(errWriteRevoked)
	}
	deadline := time.Now().Add(budget)
	var conn net.Conn
	if target.dial != nil {
		conn, err = target.dial(context.Background(), "tcp", target.address)
	} else {
		network := "tcp6"
		if address.Addr().Is4() {
			network = "tcp4"
		}
		conn, err = (&net.Dialer{}).DialTCP(context.Background(), network, netip.AddrPort{}, address)
	}
	if err != nil {
		return fail(err)
	}
	if !w.publishConnection(conn) {
		_ = conn.Close()
		return fail(errWriteRevoked)
	}
	if err = conn.SetDeadline(deadline); err != nil {
		return fail(err)
	}
	config := &tls.Config{}
	if target.config != nil {
		config = target.config.Clone()
	}
	if config.InsecureSkipVerify {
		return fail(errors.New("certificate verification required"))
	}
	config.ServerName = target.serverName
	config.NextProtos = []string{"http/1.1"}
	tlsConn := tls.Client(conn, config)
	if err = tlsConn.Handshake(); err != nil {
		return fail(err)
	}
	protocol := tlsConn.ConnectionState().NegotiatedProtocol
	if w.isSealed() || protocol != "http/1.1" {
		return fail(errors.New("cancelled or invalid application protocol"))
	}
	if hooks != nil && hooks.beforeWrite != nil {
		hooks.beforeWrite()
	}
	request.Close = true
	guarded := &syncGuardedConn{Conn: tlsConn, work: w, hooks: hooks}
	if err = request.Write(guarded); err != nil {
		return fail(err)
	}
	limited := &httpBudgetReader{reader: tlsConn, remaining: maxHTTPWireBytes,
		headerRemaining: maxHTTPHeaderBytes, readingHeaders: true}
	reader := bufio.NewReader(limited)
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		return fail(err)
	}
	limited.readingHeaders = false
	defer response.Body.Close()
	if response.ProtoMajor != 1 || response.ProtoMinor > 1 || response.StatusCode < 200 || response.StatusCode == 101 {
		return fail(errors.New("unsupported HTTP response"))
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return fail(errors.New("HTTP response body unavailable"))
	}
	return syncHTTPResult{status: response.StatusCode, contentType: response.Header.Get("Content-Type"), body: body}
}
