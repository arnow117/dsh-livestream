package main

import (
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCancelledHandshakeContinuationCannotWriteOrJoinEarly(t *testing.T) {
	var requests atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	defer server.Close()
	request, err := http.NewRequest(http.MethodGet, server.URL+"/chat", nil)
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	boundary := &writeBoundary{current: func() bool { return true }}
	work := newSyncHTTPWork(boundary)
	work.start(fixtureTarget(server), request, 2*time.Second, &syncHTTPHooks{beforeWrite: func() {
		close(entered)
		<-release
	}})
	awaitSignal(t, entered, "post-handshake continuation")
	work.cancel()
	select {
	case <-work.done:
		t.Fatal("continuation was not joined")
	default:
	}
	once.Do(func() { close(release) })
	awaitSignal(t, work.done, "cancelled continuation")
	if boundary.wasAttempted() || requests.Load() != 0 {
		t.Fatal("cancelled continuation reached application Write")
	}
}
