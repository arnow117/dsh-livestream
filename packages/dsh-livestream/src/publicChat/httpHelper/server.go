package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

var forbiddenPublicText = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]{1,31}://|www\.|live\.douyin\.com|douyin\.com/user|v\.douyin\.com|\b(data|file|blob):|\battachment\b|附件\s*[:：]|记录\s*[:：]\s*\S+/\S+|[^\s@]+@[^\s@]+\.[^\s@]{2,}|(微信|weixin|wx|vx)\s*(号|id|:|：)?\s*[:：]?\s*\S{2,})`)
var phoneText = regexp.MustCompile(`(^|[^0-9])\+?[0-9][0-9\s-]{5,18}[0-9]($|[^0-9])`)

func validPublicText(text string) bool {
	if !utf8.ValidString(text) || strings.TrimSpace(text) == "" || len(utf16.Encode([]rune(strings.TrimSpace(text)))) > 200 {
		return false
	}
	for _, r := range text {
		if r < 0x20 || (r >= 0x7f && r <= 0x9f) || r == 0x200b || r == 0x200e || r == 0x200f ||
			(r >= 0x202a && r <= 0x202e) || r == 0xfeff || r == 0xfffd {
			return false
		}
	}
	return !forbiddenPublicText.MatchString(text) && !phoneText.MatchString(text)
}

type privateSend struct {
	RequestID   string         `json:"requestId"`
	SourceKey   string         `json:"sourceKey"`
	RequestHash string         `json:"requestHash"`
	SourceKind  string         `json:"sourceKind"`
	Grant       committedGrant `json:"grant"`
	Text        string         `json:"text"`
}

type privateServer struct {
	authority       *helperGrants
	profileTarget   *tlsTarget
	queryTarget     *tlsTarget
	chatTarget      *tlsTarget
	preparedTargets map[string]tlsTarget
	sendHooks       *syncHTTPHooks
	outputMu        sync.Mutex
	workers         sync.WaitGroup
}

func (s *privateServer) target(operation string) (tlsTarget, error) {
	switch operation {
	case "profile_self":
		if s.profileTarget != nil {
			return *s.profileTarget, nil
		}
	case "query_user":
		if s.queryTarget != nil {
			return *s.queryTarget, nil
		}
	case "chat":
		if s.chatTarget != nil {
			return *s.chatTarget, nil
		}
	}
	target, ok := s.preparedTargets[operation]
	if !ok {
		return tlsTarget{}, errors.New("fixed target unavailable")
	}
	return target, nil
}

func recordView(record grantRecord) map[string]any {
	view := map[string]any{"kind": record.kind, "payloadHash": record.hash, "state": record.state}
	if record.target != "" {
		view["targetId"] = record.target
	}
	if record.grant != nil {
		view["grant"] = record.grant
	}
	if q := record.qualification; q != nil {
		view["qualification"] = map[string]any{"captureId": q.captureID, "digest": q.digest,
			"principalUid": q.principalUID, "revision": q.revision, "identityEpoch": q.identityEpoch, "capturedAtMs": q.capturedAtMs}
	}
	if message := record.message; message != nil {
		view["message"] = map[string]any{"requestId": message.requestID, "sourceKey": message.sourceKey,
			"requestHash": message.requestHash, "textDigest": message.textDigest, "acceptedAtMs": message.acceptedAtMs,
			"firstWriteAttemptAtMs": message.firstWriteAttemptAtMs,
			"joinedWitnessId":       message.joinedWitnessID, "joinedAtMs": message.joinedAtMs,
			"factsRevision": len(message.facts), "factsDigest": message.factsDigest, "recoveryControlId": message.latestReconcile,
			"grant": message.grant, "writeAttempted": message.writeAttempted, "executionEnded": message.executionEnded,
			"httpStatus": message.responseStatus, "responseLength": message.responseLength, "responseDigest": message.responseDigest}
	}
	if record.reconcile != nil {
		view["reconcile"] = map[string]any{"request": record.reconcile.request, "receipt": record.reconcile.receipt}
	}
	return view
}

func (s *privateServer) reply(writer io.Writer, frame privateFrame, status string, payload any) {
	context := s.authority.context
	response := map[string]any{"protocol": privateProtocol, "seq": frame.Seq, "kind": frame.Kind,
		"operationId": frame.OperationID, "payloadHash": frame.PayloadHash,
		"helperNonce": context.processNonce, "authContextId": context.contextID,
		"authContextRevision": s.authority.revision, "materialDigest": context.materialDigest,
		"status": status, "payload": payload}
	s.outputMu.Lock()
	defer s.outputMu.Unlock()
	_ = writePrivateFrame(writer, response)
}

func (s *privateServer) validReferences(frame privateFrame) bool {
	context := s.authority.context
	return context != nil && frame.ExpectedHelperNonce == context.processNonce && frame.AuthContextID == context.contextID &&
		frame.AuthContextRevision == s.authority.revision && frame.MaterialDigest == context.materialDigest
}

func (s *privateServer) runProfile(writer io.Writer, frame privateFrame, request profileRequest) {
	profileTarget, err := s.target("profile_self")
	if err != nil {
		s.reply(writer, frame, "unavailable", nil)
		return
	}
	queryTarget, err := s.target("query_user")
	if err != nil {
		s.reply(writer, frame, "unavailable", nil)
		return
	}
	record, err := s.authority.captureProfile(request, profileTarget, queryTarget)
	if err != nil {
		s.reply(writer, frame, "unavailable", nil)
		return
	}
	s.reply(writer, frame, record.state, recordView(record))
}

func (s *privateServer) runSend(writer io.Writer, frame privateFrame, request privateSend) {
	if (request.SourceKind != "manual" && request.SourceKind != "auto") ||
		(request.SourceKind == "auto" && request.SourceKey == "") || !validPublicText(request.Text) {
		s.reply(writer, frame, "unavailable", nil)
		return
	}
	textDigest := sha256.Sum256([]byte(request.Text))
	boundary, record, err := s.authority.beginSendWithFacts(request.RequestID, request.SourceKey, frame.PayloadHash,
		request.RequestHash, hex.EncodeToString(textDigest[:]), request.Grant)
	if err != nil {
		s.reply(writer, frame, "unavailable", nil)
		return
	}
	if boundary == nil {
		s.reply(writer, frame, record.state, recordView(record))
		return
	}
	work := newSyncHTTPWork(boundary)
	if !s.authority.attachSyncWork(request.RequestID, boundary, work) {
		s.reply(writer, frame, "unavailable", nil)
		return
	}
	work.startPrepared(func() (tlsTarget, *http.Request, error) {
		requestWire, err := buildFixedRequest(s.authority.context, "chat", &request.Grant, request.Text, s.authority.now())
		if err != nil {
			return tlsTarget{}, nil, err
		}
		target, err := s.target("chat")
		return target, requestWire, err
	}, 15*time.Second, s.sendHooks)
	select {
	case <-work.done:
	case <-work.timedOut:
		record, _ = s.authority.holdNetworkUnknown(request.RequestID, boundary)
		s.reply(writer, frame, record.state, recordView(record))
		// A timed-out dial can still be running. Its original worker retains the
		// slot until it and its owned supervisor have actually joined.
		<-work.done
		_, _ = s.authority.finishSendWithResponse(request.RequestID, boundary, nil)
		return
	}
	var evidence *responseEvidence
	if work.result.err == nil {
		body := work.result.body
		digest := sha256.Sum256(body)
		evidence = &responseEvidence{status: work.result.status, length: len(body), digest: hex.EncodeToString(digest[:]),
			success: isAPIReportedSuccess(work.result.status, work.result.contentType, body)}
	}
	record, _ = s.authority.finishSendWithResponse(request.RequestID, boundary, evidence)
	s.reply(writer, frame, record.state, recordView(record))
}

func (s *privateServer) dispatch(writer io.Writer, frame privateFrame) {
	if frame.Kind == "hello" {
		var empty struct{}
		if decodeFrameStrict(frame.Payload, &empty) != nil {
			s.reply(writer, frame, "unavailable", nil)
			return
		}
		for _, operation := range []string{"profile_self", "query_user", "chat"} {
			if _, err := s.target(operation); err != nil {
				s.reply(writer, frame, "unavailable", nil)
				return
			}
		}
		s.reply(writer, frame, "ready", map[string]any{"capabilities": []string{
			"private-framing-v1", "frozen-http-auth-v1", "no-replay-http1-v1", "unknown-recovery-v1",
		}})
		return
	}
	if !s.validReferences(frame) {
		s.reply(writer, frame, "unavailable", nil)
		return
	}
	hash, err := canonicalHash(frame.Payload)
	if err != nil || hash != frame.PayloadHash {
		s.reply(writer, frame, "unavailable", nil)
		return
	}
	switch frame.Kind {
	case "profile":
		var request profileRequest
		if decodeFrameStrict(frame.Payload, &request) != nil || request.CaptureID != frame.OperationID || request.HelperNonce != frame.ExpectedHelperNonce {
			break
		}
		s.workers.Add(1)
		go func() { defer s.workers.Done(); s.runProfile(writer, frame, request) }()
		return
	case "bindGrant":
		var proposal grantProposal
		if !factFields(frame.Payload, proposalJSONKeys...) || decodeFrameStrict(frame.Payload, &proposal) != nil ||
			proposal.AuthorizationID != frame.OperationID || proposalDigest(proposal) != hash {
			break
		}
		record, err := s.authority.bind(proposal)
		if err == nil {
			s.reply(writer, frame, record.state, recordView(record))
			return
		}
	case "revoke":
		var request helperRevoke
		if decodeFrameStrict(frame.Payload, &request) != nil || request.ID != frame.OperationID || request.HelperNonce != frame.ExpectedHelperNonce {
			break
		}
		record, err := s.authority.revoke(request)
		if err == nil {
			s.reply(writer, frame, record.state, recordView(record))
			return
		}
	case "query":
		var empty struct{}
		if decodeFrameStrict(frame.Payload, &empty) != nil {
			break
		}
		s.authority.mu.Lock()
		record, found := s.authority.records[frame.OperationID]
		if found && record.kind == "message_reconcile" && record.state == "pending_join" && record.reconcile != nil {
			record, err = s.authority.reconcileMessageLocked(record.reconcile.request, record.hash)
			found = err == nil
		}
		record = cloneGrantRecord(record)
		s.authority.mu.Unlock()
		if found {
			s.reply(writer, frame, record.state, recordView(record))
		} else {
			s.reply(writer, frame, "not_found", nil)
		}
		return
	case "reconcileMessage":
		var request helperMessageReconcile
		if !exactReconcileJSON(frame.Payload) || decodeFrameStrict(frame.Payload, &request) != nil || request.ControlID != frame.OperationID {
			break
		}
		record, err := s.authority.reconcileMessage(request, frame.PayloadHash)
		if err == nil {
			s.reply(writer, frame, record.state, recordView(record))
			return
		}
	case "send":
		var request privateSend
		if !exactSendJSON(frame.Payload) || decodeFrameStrict(frame.Payload, &request) != nil || request.RequestID != frame.OperationID {
			break
		}
		s.workers.Add(1)
		go func() { defer s.workers.Done(); s.runSend(writer, frame, request) }()
		return
	}
	s.reply(writer, frame, "unavailable", nil)
}

func (s *privateServer) serve(reader io.Reader, writer io.Writer) error {
	defer s.workers.Wait()
	if s.authority == nil || s.authority.context == nil {
		return errors.New("unavailable")
	}
	var lastSequence uint64
	for {
		frame, err := readPrivateFrame(reader)
		if err == io.EOF {
			return nil
		}
		if err != nil || frame.Seq <= lastSequence {
			return errors.New("invalid frame")
		}
		lastSequence = frame.Seq
		s.dispatch(writer, frame)
	}
}
