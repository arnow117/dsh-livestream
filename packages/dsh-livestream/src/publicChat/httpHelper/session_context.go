package main

import (
	"sync/atomic"

	"github.com/yunsur/douyin-mcp/douyin"
)

// sessionAuthContext remains owned by the same private helper as the client.
// Invalidation is monotonic and is checked at the original write boundary.
type sessionAuthContext struct {
	client      *douyin.Client
	snapshot    *douyin.DSHSessionSnapshot
	invalidated atomic.Bool
}

func (s *sessionAuthContext) valid() bool {
	return s != nil && !s.invalidated.Load() && s.snapshot != nil && s.snapshot.Current(s.client)
}

func (c *authContext) transportKind() string {
	if c != nil && c.session != nil {
		return "session_http"
	}
	return "frozen_http"
}
