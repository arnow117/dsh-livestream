package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

type fixtureReply struct {
	Status  string          `json:"status"`
	Payload json.RawMessage `json:"payload"`
}

func fixtureExchange(t *testing.T, input io.Writer, output io.Reader, authority *helperGrants,
	sequence uint64, kind, operationID string, payload any) fixtureReply {
	t.Helper()
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := canonicalHash(payload)
	if err != nil {
		t.Fatal(err)
	}
	frame := privateFrame{Protocol: privateProtocol, Seq: sequence, Kind: kind, OperationID: operationID,
		PayloadHash: hash, ExpectedHelperNonce: authority.context.processNonce, AuthContextID: authority.context.contextID,
		AuthContextRevision: authority.revision, MaterialDigest: authority.context.materialDigest, Payload: data}
	if err := writePrivateFrame(input, frame); err != nil {
		t.Fatal(err)
	}
	var prefix [4]byte
	if _, err := io.ReadFull(output, prefix[:]); err != nil {
		t.Fatal(err)
	}
	size := binary.BigEndian.Uint32(prefix[:])
	if size == 0 || size > maxFrameBytes {
		t.Fatal("invalid fixture response size")
	}
	data = make([]byte, size)
	if _, err := io.ReadFull(output, data); err != nil {
		t.Fatal(err)
	}
	var reply fixtureReply
	if err := json.Unmarshal(data, &reply); err != nil {
		t.Fatal(err)
	}
	return reply
}

func TestPrivateServerGrantAndTLSFixture(t *testing.T) {
	var chats atomic.Int32
	tlsServer := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/aweme/v1/web/user/profile/self/":
			_, _ = io.WriteString(w, `{"status_code":0,"user":{"uid":"42"}}`)
		case "/aweme/v1/web/query/user/":
			_, _ = io.WriteString(w, `{"status_code":0,"user_uid":42}`)
		case "/webcast/room/chat/":
			chats.Add(1)
			_, _ = io.WriteString(w, `{"status_code":0}`)
		default:
			t.Error("unexpected fixture path")
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer tlsServer.Close()
	authority, proposal := grantFixture(t)
	authority.qualification = nil
	profileTarget := fixtureTarget(tlsServer)
	profileTarget.originHost, profileTarget.path = "www.douyin.com", "/aweme/v1/web/user/profile/self/"
	queryTarget := profileTarget
	queryTarget.path = "/aweme/v1/web/query/user/"
	chatTarget := fixtureTarget(tlsServer)
	chatTarget.originHost, chatTarget.path = "live.douyin.com", "/webcast/room/chat/"
	server := &privateServer{authority: authority, profileTarget: &profileTarget, queryTarget: &queryTarget, chatTarget: &chatTarget}
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := server.serve(inputReader, outputWriter)
		outputWriter.Close()
		done <- err
	}()
	defer outputReader.Close()
	defer inputReader.Close()
	profile := profileRequest{CaptureID: proposal.CaptureID, HelperNonce: proposal.HelperProcessNonce,
		QualificationRevision: 1, IdentityEpoch: 1}
	profileReply := fixtureExchange(t, inputWriter, outputReader, authority, 1, "profile", profile.CaptureID, profile)
	if profileReply.Status != "qualified" || chats.Load() != 0 {
		t.Fatal("qualification alone did not stay non-sending")
	}
	var profileResult struct {
		Qualification struct {
			Digest string `json:"digest"`
		} `json:"qualification"`
	}
	if err := json.Unmarshal(profileReply.Payload, &profileResult); err != nil || profileResult.Qualification.Digest == "" {
		t.Fatal("qualification proof missing")
	}
	proposal.QualificationDigest = profileResult.Qualification.Digest
	bindReply := fixtureExchange(t, inputWriter, outputReader, authority, 2, "bindGrant", proposal.AuthorizationID, proposal)
	var bindResult struct {
		Grant committedGrant `json:"grant"`
	}
	if bindReply.Status != "authorized" || json.Unmarshal(bindReply.Payload, &bindResult) != nil || bindResult.Grant.GrantID == "" || chats.Load() != 0 {
		t.Fatal("grant commit or pre-ACK boundary failed")
	}
	send := privateSend{RequestID: "message", SourceKey: "source", RequestHash: strings.Repeat("d", 64), SourceKind: "manual", Grant: bindResult.Grant, Text: "fixture"}
	sequence := uint64(3)
	for index, text := range []string{"//example.invalid/a", "看这里//example.invalid/a", "//[::1]/a", "\n问候", "问候\t", "\ufeff问候"} {
		invalid := send
		invalid.RequestID = "unsafe-message-" + strconv.Itoa(index)
		invalid.SourceKey = "unsafe-source-" + strconv.Itoa(index)
		invalid.Text = text
		reply := fixtureExchange(t, inputWriter, outputReader, authority, sequence, "send", invalid.RequestID, invalid)
		sequence++
		if reply.Status != "unavailable" || chats.Load() != 0 {
			t.Fatalf("unsafe text %q reached the chat target", text)
		}
	}
	send.Text = "  微信\u00a0好  "
	sendReply := fixtureExchange(t, inputWriter, outputReader, authority, sequence, "send", send.RequestID, send)
	sequence++
	if sendReply.Status != "api_reported_success" || chats.Load() != 1 {
		t.Fatal("fixture send did not report the verified response")
	}
	revoke := helperRevoke{ID: "revoke", HelperNonce: proposal.HelperProcessNonce, Kind: "authorization",
		TargetID: proposal.AuthorizationID, GrantID: bindResult.Grant.GrantID}
	if reply := fixtureExchange(t, inputWriter, outputReader, authority, sequence, "revoke", revoke.ID, revoke); reply.Status != "revoked" {
		t.Fatal("revoke did not acknowledge")
	}
	sequence++
	send.RequestID, send.SourceKey = "message-2", "source-2"
	if reply := fixtureExchange(t, inputWriter, outputReader, authority, sequence, "send", send.RequestID, send); reply.Status != "unavailable" || chats.Load() != 1 {
		t.Fatal("revoked grant reached fixture")
	}
	inputWriter.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestPublicTextPolicyRejectsObviousSecrets(t *testing.T) {
	for _, value := range []string{"", "https://example.com", "//example.invalid/a", "//[::1]/a", "123456789", "a@example.com", "微信:abc", "abc\nxyz", "\n问候", "问候\r", "\t问候", "问候\ufeff", strings.Repeat("x", 201)} {
		if validPublicText(value) {
			t.Fatal("unsafe fixture text accepted")
		}
	}
	if !validPublicText("欢迎来到直播间") {
		t.Fatal("ordinary fixture text rejected")
	}
	for _, value := range []string{"微信\u00a0好", "//\u3000提示", "douyin.com/uſer"} {
		if !validPublicText(value) {
			t.Errorf("ordinary Unicode fixture text %q rejected", value)
		}
	}
	for _, value := range []string{"mywww.example/a", "123\u3000456789", "vx\u00a0name", "Kx://文字", "ſmtp://文字", "HTTP://example.invalid"} {
		if validPublicText(value) {
			t.Errorf("unsafe Unicode fixture text %q accepted", value)
		}
	}
}
