package main

import (
	"net"
	"net/http"
	"sync"
	"time"
)

type syncHTTPResult struct {
	status      int
	contentType string
	body        []byte
	err         error
}

// syncHTTPWork owns both the request worker and its socket-closing supervisor.
// done is closed only after the worker has completed its cleanup and joined
// that supervisor. A timeout seals the operation but is not a join.
type syncHTTPWork struct {
	boundary *writeBoundary
	mu       sync.Mutex
	sealed   bool
	conn     net.Conn
	stop     chan struct{}
	stopOnce sync.Once
	timedOut chan struct{}
	done     chan struct{}
	result   syncHTTPResult
}

func newSyncHTTPWork(boundary *writeBoundary) *syncHTTPWork {
	return &syncHTTPWork{
		boundary: boundary,
		stop:     make(chan struct{}),
		timedOut: make(chan struct{}),
		done:     make(chan struct{}),
	}
}

// sealLocked requires the boundary mutex. Closing the socket is delegated to
// the supervisor, which never holds the boundary mutex during Close.
func (w *syncHTTPWork) sealLocked() {
	w.mu.Lock()
	w.sealed = true
	w.mu.Unlock()
	w.stopOnce.Do(func() { close(w.stop) })
}

func (w *syncHTTPWork) cancel() {
	w.boundary.mutex().Lock()
	w.sealLocked()
	w.boundary.mutex().Unlock()
}

func (w *syncHTTPWork) publishConnection(conn net.Conn) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.sealed || w.conn != nil {
		return false
	}
	w.conn = conn
	return true
}

func (w *syncHTTPWork) isSealed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.sealed
}

func (w *syncHTTPWork) closeOwnedConnection() {
	w.mu.Lock()
	conn := w.conn
	w.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

// start is called only after the original operation has been registered.
// Test hooks remain internal wiring and are never read from a request or env.
func (w *syncHTTPWork) start(target tlsTarget, request *http.Request, budget time.Duration, hooks *syncHTTPHooks) {
	w.startPrepared(func() (tlsTarget, *http.Request, error) { return target, request, nil }, budget, hooks)
}

// prepare is an internal fixed-request builder, not caller-supplied wire data.
// Its complete execution and the supervisor are owned by the same worker.
func (w *syncHTTPWork) startPrepared(prepare func() (tlsTarget, *http.Request, error), budget time.Duration, hooks *syncHTTPHooks) {
	go func() {
		runWorker := func() {
			supervisorDone := make(chan struct{})
			go func() {
				defer close(supervisorDone)
				timer := time.NewTimer(budget)
				defer timer.Stop()
				select {
				case <-timer.C:
					w.cancel()
					close(w.timedOut)
				case <-w.stop:
				}
				w.closeOwnedConnection()
				if hooks != nil && hooks.afterSupervisorClose != nil {
					hooks.afterSupervisorClose()
				}
			}()
			if w.isSealed() {
				w.result = syncHTTPResult{err: errWriteRevoked}
			} else if target, request, err := prepare(); err != nil {
				w.result = syncHTTPResult{err: err}
			} else {
				w.result = w.perform(target, request, budget, hooks)
			}
			if hooks != nil && hooks.beforeCleanup != nil {
				hooks.beforeCleanup()
			}
			w.cancel()
			<-supervisorDone
		}
		runWorker()
		close(w.done)
	}()
}
