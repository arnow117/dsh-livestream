package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"

	"github.com/yunsur/douyin-mcp/douyin"
)

type sessionLoginView struct {
	State        string `json:"state"`
	AttemptID    string `json:"attemptId,omitempty"`
	Revision     uint64 `json:"revision"`
	QRDataURL    string `json:"qrDataUrl,omitempty"`
	PrincipalUID string `json:"principalUid,omitempty"`
	BindingRef   string `json:"bindingRef,omitempty"`
	Reason       string `json:"reason,omitempty"`
}

type sessionAuth struct {
	mu         sync.Mutex
	authority  *helperGrants
	factory    func() (*douyin.Client, *sessionTransport, error)
	viewState  sessionLoginView
	generation uint64
	cancelWork context.CancelFunc
	done       chan struct{}
	client     *douyin.Client
	snapshot   *douyin.DSHSessionSnapshot
}

func randomSessionID() (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(data[:]), nil
}

func newUnauthenticatedContext(processNonce string) (*authContext, error) {
	id, err := randomSessionID()
	if err != nil || !validIdentifier(processNonce) {
		return nil, errors.New("session unavailable")
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, errors.New("session unavailable")
	}
	digest := sha256.Sum256(append([]byte("dsh-session-unauthenticated-v1\x00"), random[:]...))
	return &authContext{contextID: id, processNonce: processNonce, materialDigest: hex.EncodeToString(digest[:])}, nil
}

func newSessionAuth(authority *helperGrants, factory func() (*douyin.Client, *sessionTransport, error)) *sessionAuth {
	return &sessionAuth{authority: authority, factory: factory, viewState: sessionLoginView{State: "idle"}}
}

// invalidateLocked is called with both session and authority locks held. It
// seals an original write before changing any authentication reference.
func (s *sessionAuth) invalidateLocked() {
	a := s.authority
	if a.context != nil && a.context.session != nil {
		a.context.session.invalidated.Store(true)
	}
	if a.captureWork != nil {
		a.captureWork.sealLocked()
	}
	if a.captureCancel != nil {
		a.captureCancel()
	}
	if a.captureID != "" {
		a.cancelledCaptures[a.captureID] = true
	}
	if a.active != nil {
		if record, ok := a.records[a.activeRequestID]; ok && record.message != nil && record.message.syncWork != nil {
			record.message.syncWork.sealLocked()
		}
		a.cancelledAuth[a.active.AuthorizationID] = true
		original := a.records[a.active.AuthorizationID]
		original.state = "revoked"
		a.records[a.active.AuthorizationID] = original
		a.active = nil
	}
	a.qualification = nil
	a.captureGeneration++
}

func (s *sessionAuth) view() sessionLoginView {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshInvalidatedLocked()
	return s.viewState
}

// Keep the original protocol identity until its send reply is delivered. The
// next status/start reports invalidation without publishing credentials.
func (s *sessionAuth) refreshInvalidatedLocked() {
	if s.viewState.State != "authenticated" || s.authority == nil {
		return
	}
	s.authority.mu.Lock()
	ctx := s.authority.context
	invalid := ctx == nil || ctx.session == nil || ctx.session.invalidated.Load()
	s.authority.mu.Unlock()
	if invalid {
		s.viewState.State = "failed"
		s.viewState.Reason = "session-unavailable"
		s.viewState.PrincipalUID = ""
		s.viewState.BindingRef = ""
		s.viewState.QRDataURL = ""
	}
}

func (s *sessionAuth) start() (sessionLoginView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshInvalidatedLocked()
	if s.authority == nil || s.factory == nil {
		return sessionLoginView{}, errors.New("session unavailable")
	}
	if s.viewState.State == "starting" || s.viewState.State == "waiting" || s.viewState.State == "confirmation_required" || s.viewState.State == "authenticated" {
		return s.viewState, nil
	}
	if s.done != nil {
		select {
		case <-s.done:
		default:
			return sessionLoginView{}, errors.New("session busy")
		}
	}
	a := s.authority
	a.mu.Lock()
	s.invalidateLocked()
	if a.inFlight || a.captureBusy {
		a.mu.Unlock()
		return sessionLoginView{}, errors.New("session busy")
	}
	if a.context == nil {
		a.mu.Unlock()
		return sessionLoginView{}, errors.New("session unavailable")
	}
	placeholder, err := newUnauthenticatedContext(a.context.processNonce)
	if err != nil {
		a.mu.Unlock()
		return sessionLoginView{}, err
	}
	a.revision++
	a.context = placeholder
	a.deployment.principalUID = ""
	revision := a.revision
	room := a.deployment.roomID
	a.mu.Unlock()
	id, err := randomSessionID()
	if err != nil {
		return sessionLoginView{}, errors.New("session unavailable")
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.generation++
	generation := s.generation
	s.cancelWork = cancel
	s.done = make(chan struct{})
	s.client, s.snapshot = nil, nil
	s.viewState = sessionLoginView{State: "starting", AttemptID: id, Revision: revision}
	go s.run(ctx, generation, id, room, s.done)
	return s.viewState, nil
}

func (s *sessionAuth) run(ctx context.Context, generation uint64, id, room string, done chan struct{}) {
	defer close(done)
	client, _, err := s.factory()
	var uid string
	var snapshot *douyin.DSHSessionSnapshot
	if err == nil {
		uid, err = loginAndCaptureSession(ctx, client, func(image string) {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.generation == generation && ctx.Err() == nil {
				s.viewState.State = "waiting"
				s.viewState.QRDataURL = image
			}
		})
	}
	if err == nil {
		snapshot, err = client.PrepareSessionAuth(ctx, room)
	}
	var binding string
	if err == nil {
		binding, err = randomSessionID()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation != generation || s.viewState.AttemptID != id || ctx.Err() != nil {
		return
	}
	s.viewState.QRDataURL = ""
	if err != nil {
		if errors.Is(err, errSessionExpired) {
			s.viewState.State, s.viewState.Reason = "expired", "login-expired"
		} else {
			s.viewState.State, s.viewState.Reason = "failed", "session-unavailable"
		}
		return
	}
	s.client, s.snapshot = client, snapshot
	s.viewState.State, s.viewState.PrincipalUID, s.viewState.BindingRef = "confirmation_required", uid, binding
}

func (s *sessionAuth) confirm(bindingRef string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.viewState.State != "confirmation_required" || bindingRef == "" || bindingRef != s.viewState.BindingRef || s.client == nil || !s.snapshot.Current(s.client) {
		return errors.New("session confirmation unavailable")
	}
	a := s.authority
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.inFlight || a.captureBusy || a.context == nil {
		return errors.New("session busy")
	}
	id, err := randomSessionID()
	if err != nil {
		return errors.New("session unavailable")
	}
	a.revision++
	a.context = &authContext{session: &sessionAuthContext{client: s.client, snapshot: s.snapshot}, contextID: id,
		processNonce: a.context.processNonce, materialDigest: s.snapshot.Digest()}
	a.deployment.principalUID = s.viewState.PrincipalUID
	s.viewState.State, s.viewState.BindingRef, s.viewState.Revision = "authenticated", "", a.revision
	return nil
}

func (s *sessionAuth) cancel(attemptID string, revision uint64) error {
	s.mu.Lock()
	if attemptID == "" || attemptID != s.viewState.AttemptID || revision != s.viewState.Revision {
		s.mu.Unlock()
		return errors.New("session attempt unavailable")
	}
	s.authority.mu.Lock()
	s.invalidateLocked()
	s.authority.revision++
	s.viewState.Revision = s.authority.revision
	if !s.authority.inFlight && !s.authority.captureBusy && s.authority.context != nil {
		placeholder, err := newUnauthenticatedContext(s.authority.context.processNonce)
		if err == nil {
			s.authority.context = placeholder
			s.authority.deployment.principalUID = ""
		}
	}
	s.authority.mu.Unlock()
	s.generation++
	if s.cancelWork != nil {
		s.cancelWork()
	}
	done := s.done
	s.viewState.State, s.viewState.QRDataURL, s.viewState.BindingRef, s.viewState.PrincipalUID = "cancelled", "", "", ""
	s.client, s.snapshot = nil, nil
	s.mu.Unlock()
	if done != nil {
		<-done
	}
	return nil
}

func (s *sessionAuth) wait(id string) error {
	s.mu.Lock()
	if id != s.viewState.AttemptID || s.done == nil {
		s.mu.Unlock()
		return errors.New("session attempt unavailable")
	}
	done := s.done
	s.mu.Unlock()
	<-done
	return nil
}

func (s *sessionAuth) shutdown() {
	s.mu.Lock()
	if s.authority != nil {
		s.authority.mu.Lock()
		s.invalidateLocked()
		s.authority.mu.Unlock()
	}
	s.generation++
	if s.cancelWork != nil {
		s.cancelWork()
	}
	done := s.done
	s.client, s.snapshot = nil, nil
	s.mu.Unlock()
	if done != nil {
		<-done
	}
}
