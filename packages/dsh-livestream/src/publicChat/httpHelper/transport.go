package main

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"sync"
)

var errWriteRevoked = errors.New("write authorization revoked")

// writeBoundary serializes the start of each application Write with revocation.
// The original connection has an absolute deadline, and its owning supervisor
// closes it without holding this mutex.
type writeBoundary struct {
	mu             sync.Mutex
	shared         *sync.Mutex
	revoked        bool
	attempted      bool
	current        func() bool
	onFirstAttempt func() bool
}

func (b *writeBoundary) mutex() *sync.Mutex {
	if b.shared != nil {
		return b.shared
	}
	return &b.mu
}

func (b *writeBoundary) revoke() {
	b.mutex().Lock()
	defer b.mutex().Unlock()
	b.revoked = true
}

func (b *writeBoundary) wasAttempted() bool {
	b.mutex().Lock()
	defer b.mutex().Unlock()
	return b.attempted
}

// tlsTarget is private wiring: production uses only prepared fixed origins
// and system roots; tests may map them to a separately owned TLS fixture.
type tlsTarget struct {
	address    string
	serverName string
	config     *tls.Config
	originHost string
	path       string
	dial       func(context.Context, string, string) (net.Conn, error)
}

func productionTarget(operation string) (tlsTarget, error) {
	var host, path string
	switch operation {
	case "profile_self":
		host, path = "www.douyin.com", "/aweme/v1/web/user/profile/self/"
	case "query_user":
		host, path = "www.douyin.com", "/aweme/v1/web/query/user/"
	case "chat":
		host, path = "live.douyin.com", "/webcast/room/chat/"
	default:
		return tlsTarget{}, errors.New("unknown fixed operation")
	}
	return tlsTarget{address: net.JoinHostPort(host, "443"), serverName: host, originHost: host, path: path}, nil
}
