package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	"github.com/yunsur/douyin-mcp/douyin"
)

type sessionFixtureTransport struct {
	calls    int
	cookies  []string
	response *douyin.Response
}

func (f *sessionFixtureTransport) Do(_ context.Context, _ string, _ string, _ douyin.Headers, cookie string, _ []byte) (*douyin.Response, error) {
	f.calls++
	f.cookies = append(f.cookies, cookie)
	if f.response == nil {
		return nil, errors.New("missing fixture")
	}
	return f.response, nil
}
func (f *sessionFixtureTransport) Get(ctx context.Context, url string, h douyin.Headers, cookie string) (*douyin.Response, error) {
	return f.Do(ctx, "GET", url, h, cookie, nil)
}
func (f *sessionFixtureTransport) PostJSON(ctx context.Context, url string, h douyin.Headers, cookie, _ string, body []byte) (*douyin.Response, error) {
	return f.Do(ctx, "POST", url, h, cookie, body)
}

func TestSessionTransportScopedCookiesAndTargets(t *testing.T) {
	fixture := &sessionFixtureTransport{response: &douyin.Response{StatusCode: 200, Cookies: []*fhttp.Cookie{
		{Name: "session_synthetic", Value: "only-login", Path: "/passport/", Secure: true},
		{Name: "bad_domain", Value: "ignore", Domain: "evil.example", Path: "/", Secure: true},
	}}}
	transport, err := newSessionTransport(fixture)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := transport.Get(ctx, "https://login.douyin.com/passport/web/get_qrcode/", nil, "injected=secret"); err != nil {
		t.Fatal(err)
	}
	fixture.response = &douyin.Response{StatusCode: 200}
	if _, err := transport.Get(ctx, "https://login.douyin.com/passport/web/check_qrconnect/", nil, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(fixture.cookies[1], "session_synthetic=only-login") || strings.Contains(fixture.cookies[1], "bad_domain") || strings.Contains(fixture.cookies[0], "injected") {
		t.Fatalf("cookie scope not enforced: %#v", fixture.cookies)
	}
	if _, err := transport.Get(ctx, "https://www.douyin.com/", nil, ""); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(fixture.cookies[2], "session_synthetic") {
		t.Fatal("host-only cookie crossed host")
	}
	for _, target := range []string{"https://evil.example/passport/web/get_qrcode/", "http://login.douyin.com/passport/web/get_qrcode/", "https://login.douyin.com.evil.example/passport/web/get_qrcode/", "https://login.douyin.com:444/passport/web/get_qrcode/", "https://login.douyin.com/unrelated"} {
		before := fixture.calls
		if _, err := transport.Get(ctx, target, nil, ""); err == nil || fixture.calls != before {
			t.Fatalf("target was not rejected before transport: %s", target)
		}
	}
}

func TestSessionGeneratedCookiesHaveExplicitScopes(t *testing.T) {
	fixture := &sessionFixtureTransport{response: &douyin.Response{StatusCode: 200}}
	client, transport, err := newSessionClient(fixture)
	if err != nil || client == nil {
		t.Fatal("session client unavailable")
	}
	transport.DSHSetGeneratedCookie("bd_ticket_guard_client_data", "synthetic-generated")
	transport.DSHSetGeneratedCookie("bd_ticket_guard_client_data_v2", "synthetic-stale")
	transport.DSHSetGeneratedCookie("bd_ticket_guard_client_data_v2", "")
	transport.DSHSetGeneratedCookie("sessionid", "synthetic-forbidden")
	ctx := context.Background()
	for _, target := range []string{"https://www.douyin.com/", "https://login.douyin.com/passport/web/get_qrcode/", "https://mssdk.bytedance.com/web/r/token"} {
		if _, err := transport.Get(ctx, target, nil, ""); err != nil {
			t.Fatal(err)
		}
	}
	for _, header := range fixture.cookies[:2] {
		if !strings.Contains(header, "s_v_web_id=") || !strings.Contains(header, "bd_ticket_guard_client_data=synthetic-generated") || strings.Contains(header, "synthetic-stale") || strings.Contains(header, "synthetic-forbidden") {
			t.Fatal("generated cookie scope or deletion failed")
		}
	}
	if fixture.cookies[2] != "" {
		t.Fatal("generated cookie crossed to unrelated site")
	}
}

// fixtureDialGuard is the only dial function supplied to test fixtures.
// It rejects non-loopback addresses before any network operation.
func fixtureDialGuard(network, address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if (network != "tcp" && network != "tcp4" && network != "tcp6") || ip == nil || !ip.IsLoopback() {
		return errors.New("fixture target denied")
	}
	return nil
}

func TestSessionFixtureGuardRejectsExternal(t *testing.T) {
	if err := fixtureDialGuard("tcp", "203.0.113.1:443"); err == nil {
		t.Fatal("external target accepted")
	}
	if err := fixtureDialGuard("tcp", "127.0.0.1:1234"); err != nil {
		t.Fatal(err)
	}
}

type sessionLoginFixture struct {
	paths      []string
	queryUID   string
	profileUID string
	qrImage    string
	serverCert string
	waitOnce   bool
	blockPoll  bool
	entered    chan struct{}
	qrPolls    int
}

func (f *sessionLoginFixture) Do(ctx context.Context, _ string, raw string, _ douyin.Headers, _ string, _ []byte) (*douyin.Response, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	f.paths = append(f.paths, u.Host+u.Path)
	response := &douyin.Response{StatusCode: 200, Header: fhttp.Header{}, Body: []byte(`{"data":{}}`)}
	switch u.Host + u.Path {
	case "live.douyin.com/webcast/room/chat/", "live.douyin.com/service/2/abtest_config/":
		response.Header.Set("X-Ware-Csrf-Token", "a,synthetic-csrf,c,d,e")
	case "live.douyin.com/passport/ticket_guard/get_client_cert/":
		encoded, _ := json.Marshal(map[string]any{"message": "success", "data": map[string]string{"server_cert": f.serverCert}})
		response.Body = encoded
	case "mssdk.bytedance.com/web/r/token":
		response.Header.Set("x-ms-token", "synthetic-ms-token")
	case "www.douyin.com/aweme/v1/web/query/user":
		response.Body = []byte(`{"id":"synthetic-webid"}`)
	case "www.douyin.com/aweme/v1/web/query/user/":
		uid := f.queryUID
		if uid == "" {
			uid = "18446744073709551615"
		}
		response.Body = []byte(`{"user_uid":` + uid + `}`)
	case "www.douyin.com/aweme/v1/web/user/profile/self/":
		uid := f.profileUID
		if uid == "" {
			uid = "18446744073709551615"
		}
		response.Body = []byte(`{"user":{"uid":` + uid + `}}`)
	case "login.douyin.com/passport/web/get_qrcode/":
		response.Body = []byte(`{"data":{"token":"synthetic-qr-token","qrcode":"` + f.qrImage + `"}}`)
	case "login.douyin.com/passport/web/check_qrconnect/":
		if f.blockPoll {
			close(f.entered)
			<-ctx.Done()
			return nil, ctx.Err()
		}
		f.qrPolls++
		if f.waitOnce && f.qrPolls == 1 {
			response.Body = []byte(`{"data":{"status":"new"}}`)
			break
		}
		response.Body = []byte(`{"data":{"status":"confirmed","redirect_url":"https://www.douyin.com/"}}`)
		response.Header.Set("bd-ticket-guard-server-data", base64.StdEncoding.EncodeToString([]byte(`{"ticket":"synthetic-ticket","ts_sign":"ts.synthetic"}`)))
		response.Cookies = []*fhttp.Cookie{{Name: "sessionid", Value: "synthetic-session", Domain: ".douyin.com", Path: "/", Secure: true}}
	}
	return response, nil
}
func (f *sessionLoginFixture) Get(ctx context.Context, raw string, headers douyin.Headers, cookie string) (*douyin.Response, error) {
	return f.Do(ctx, "GET", raw, headers, cookie, nil)
}
func (f *sessionLoginFixture) PostJSON(ctx context.Context, raw string, headers douyin.Headers, cookie, _ string, body []byte) (*douyin.Response, error) {
	return f.Do(ctx, "POST", raw, headers, cookie, body)
}

func TestSessionLoginRetainsClientAndRejectsChallenge(t *testing.T) {
	fixture := &sessionLoginFixture{}
	client, _, err := newSessionClient(fixture)
	if err != nil {
		t.Fatal(err)
	}
	var qrEvents int
	returned, err := client.LoginByQRCode(context.Background(), 2, func(map[string]any) { qrEvents++ })
	if err != nil {
		t.Fatal(err)
	}
	if returned != client || qrEvents != 1 {
		t.Fatal("login did not retain the original client")
	}
	for _, path := range fixture.paths {
		if strings.Contains(path, "challenge") {
			t.Fatal("unexpected challenge request")
		}
	}
}

func TestSessionFreshIdentitiesMatchLosslessly(t *testing.T) {
	fixture := &sessionLoginFixture{}
	client, _, err := newSessionClient(fixture)
	if err != nil {
		t.Fatal(err)
	}
	client.SetMsToken("synthetic-ms-token")
	uid, err := captureSessionIdentity(context.Background(), client)
	if err != nil || uid != "18446744073709551615" {
		t.Fatalf("fresh identity: uid=%s err=%v", uid, err)
	}
	fixture.queryUID = "42"
	if _, err := captureSessionIdentity(context.Background(), client); err == nil {
		t.Fatal("conflicting identities accepted")
	}
}

func TestSessionLoginAndCaptureSameClient(t *testing.T) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	fixture := &sessionLoginFixture{qrImage: base64.StdEncoding.EncodeToString(buf.Bytes())}
	client, _, err := newSessionClient(fixture)
	if err != nil {
		t.Fatal(err)
	}
	var qr string
	uid, err := loginAndCaptureSession(context.Background(), client, func(image string) { qr = image })
	if err != nil || uid != "18446744073709551615" || !strings.HasPrefix(qr, "data:image/png;base64,") {
		t.Fatalf("synthetic login failed: uid=%s err=%v", uid, err)
	}
}

func TestSessionSameClientBuildsScopedChat(t *testing.T) {
	_, public, err := douyin.GenerateECKeypair()
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	fixture := &sessionLoginFixture{qrImage: base64.StdEncoding.EncodeToString(buf.Bytes()), serverCert: public}
	client, _, err := newSessionClient(fixture)
	if err != nil {
		t.Fatal(err)
	}
	uid, err := loginAndCaptureSession(context.Background(), client, func(string) {})
	if err != nil || uid == "" {
		t.Fatal("synthetic login or identity failed")
	}
	snapshot, err := client.PrepareSessionAuth(context.Background(), "12345")
	if err != nil {
		t.Fatal(err)
	}
	request, err := client.BuildSessionChat(snapshot, "12345", "987654321", "synthetic reply")
	if err != nil {
		t.Fatal(err)
	}
	if request.URL.Query().Get("room_id") != "987654321" || request.Header.Get("Referer") != "https://live.douyin.com/12345" || !strings.Contains(request.Header.Get("Cookie"), "sessionid=synthetic-session") || request.Header.Get("x-secsdk-csrf-token") != "synthetic-csrf" {
		t.Fatal("chat request did not retain the expected scoped session or room IDs")
	}
	if _, err := client.BuildSessionChat(snapshot, "54321", "987654321", "synthetic reply"); err == nil {
		t.Fatal("mismatched web room accepted")
	}
}

func TestSessionResponseAuthenticationChangeStopsFutureWrites(t *testing.T) {
	for _, scenario := range []struct {
		name, header, value string
		wantRequests        int32
	}{
		{name: "unchanged", wantRequests: 2},
		{name: "cookie-deleted", header: "Set-Cookie", value: "sessionid=; Max-Age=0; Path=/; Secure", wantRequests: 1},
		{name: "cookie-rotated", header: "Set-Cookie", value: "sessionid=synthetic-rotated; Path=/; Secure", wantRequests: 1},
		{name: "ticket-changed", header: "bd-ticket-guard-sec-ts", value: "synthetic-ticket-change", wantRequests: 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			_, public, err := douyin.GenerateECKeypair()
			if err != nil {
				t.Fatal(err)
			}
			var imageData bytes.Buffer
			if err := png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
				t.Fatal(err)
			}
			fixture := &sessionLoginFixture{qrImage: base64.StdEncoding.EncodeToString(imageData.Bytes()), serverCert: public}
			client, _, err := newSessionClient(fixture)
			if err != nil {
				t.Fatal(err)
			}
			uid, err := loginAndCaptureSession(context.Background(), client, func(string) {})
			if err != nil {
				t.Fatal(err)
			}
			snapshot, err := client.PrepareSessionAuth(context.Background(), "12345")
			if err != nil {
				t.Fatal(err)
			}
			authority, proposal := grantFixture(t)
			authority.context.session = &sessionAuthContext{client: client, snapshot: snapshot}
			authority.context.materialDigest = snapshot.Digest()
			authority.deployment.principalUID, authority.deployment.roomID = uid, "12345"
			authority.qualification.principalUID = uid
			proposal.PrincipalUID, proposal.RoomID, proposal.PlatformRoomID = uid, "12345", "987654321"
			proposal.TransportKind, proposal.MaterialDigest = "session_http", snapshot.Digest()
			committed, err := authority.bind(proposal)
			if err != nil || committed.grant == nil {
				t.Fatal("grant unavailable")
			}
			var requests atomic.Int32
			server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				count := requests.Add(1)
				w.Header().Set("Content-Type", "application/json")
				if count == 1 && scenario.header != "" {
					w.Header().Add(scenario.header, scenario.value)
				}
				_, _ = io.WriteString(w, `{"status_code":0}`)
			}))
			defer server.Close()
			target := fixtureTarget(server)
			target.originHost, target.path = "live.douyin.com", "/webcast/room/chat/"
			target.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
				if err := fixtureDialGuard(network, address); err != nil {
					return nil, err
				}
				return (&net.Dialer{}).DialContext(ctx, network, address)
			}
			auth := newSessionAuth(authority, func() (*douyin.Client, *sessionTransport, error) { return newSessionClient(fixture) })
			auth.viewState = sessionLoginView{State: "authenticated", AttemptID: "fixture-attempt", Revision: authority.revision, PrincipalUID: uid}
			private := &privateServer{authority: authority, session: auth, chatTarget: &target}
			send := privateSend{RequestID: "first", SourceKey: "source-first", RequestHash: strings.Repeat("d", 64),
				SourceKind: "manual", Grant: *committed.grant, Text: "synthetic reply"}
			hash, _ := canonicalHash(send)
			frame := privateFrame{Seq: 1, Kind: "send", OperationID: send.RequestID, PayloadHash: hash}
			var response bytes.Buffer
			private.runSend(&response, frame, send)
			if bytes.Contains(response.Bytes(), []byte(scenario.value)) && scenario.value != "" {
				t.Fatal("private frame exposed response authentication")
			}
			var envelope struct {
				AuthContextID       string `json:"authContextId"`
				AuthContextRevision uint64 `json:"authContextRevision"`
				MaterialDigest      string `json:"materialDigest"`
			}
			if json.Unmarshal(response.Bytes()[4:], &envelope) != nil || envelope.AuthContextID != proposal.AuthContextID ||
				envelope.AuthContextRevision != proposal.AuthContextRevision || envelope.MaterialDigest != proposal.MaterialDigest {
				t.Fatal("original reply authentication identity changed")
			}
			first := readFixtureReply(t, &response)
			if first.Status != "api_reported_success" || requests.Load() != 1 {
				t.Fatal("original outcome changed")
			}
			var view struct {
				Message struct {
					RequestID       string         `json:"requestId"`
					Grant           committedGrant `json:"grant"`
					JoinedWitnessID string         `json:"joinedWitnessId"`
				} `json:"message"`
			}
			if json.Unmarshal(first.Payload, &view) != nil || view.Message.RequestID != send.RequestID || view.Message.Grant != send.Grant || view.Message.JoinedWitnessID == "" {
				t.Fatal("original receipt identity changed")
			}
			if scenario.header != "" && auth.view().State != "failed" {
				t.Fatal("changed authentication remained visibly authenticated")
			}
			send.RequestID, send.SourceKey = "second", "source-second"
			hash, _ = canonicalHash(send)
			frame.Seq, frame.OperationID, frame.PayloadHash = 2, send.RequestID, hash
			private.runSend(&response, frame, send)
			second := readFixtureReply(t, &response)
			if requests.Load() != scenario.wantRequests || (scenario.header != "" && second.Status != "unavailable") {
				t.Fatal("future write not appropriately held")
			}
		})
	}
}

func TestSessionSameClientThroughOriginalWriteBoundary(t *testing.T) {
	_, public, err := douyin.GenerateECKeypair()
	if err != nil {
		t.Fatal(err)
	}
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	fixture := &sessionLoginFixture{qrImage: base64.StdEncoding.EncodeToString(pngData.Bytes()), serverCert: public}
	client, _, err := newSessionClient(fixture)
	if err != nil {
		t.Fatal(err)
	}
	uid, err := loginAndCaptureSession(context.Background(), client, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := client.PrepareSessionAuth(context.Background(), "12345")
	if err != nil {
		t.Fatal(err)
	}
	authority, proposal := grantFixture(t)
	authority.context.session = &sessionAuthContext{client: client, snapshot: snapshot}
	authority.context.materialDigest = snapshot.Digest()
	authority.deployment.principalUID, authority.deployment.roomID = uid, "12345"
	authority.qualification.principalUID = uid
	proposal.PrincipalUID, proposal.RoomID, proposal.PlatformRoomID = uid, "12345", "987654321"
	proposal.TransportKind, proposal.MaterialDigest = "session_http", snapshot.Digest()
	committed, err := authority.bind(proposal)
	if err != nil || committed.grant == nil {
		t.Fatal("session grant was not committed")
	}
	boundary, _, err := authority.beginSend("session-request", "session-source", strings.Repeat("d", 64), *committed.grant)
	if err != nil || boundary == nil {
		t.Fatal("session send not registered")
	}
	request, err := buildFixedRequest(authority.context, "chat", committed.grant, "synthetic reply", authority.now())
	if err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Query().Get("room_id") != "987654321" || r.Header.Get("Referer") != "https://live.douyin.com/12345" {
			t.Error("incorrect room binding")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status_code":0}`)
	}))
	defer server.Close()
	target := fixtureTarget(server)
	target.originHost, target.path = "live.douyin.com", "/webcast/room/chat/"
	var denied atomic.Int32
	target.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		if err := fixtureDialGuard(network, address); err != nil {
			denied.Add(1)
			return nil, err
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	if _, err := target.dial(context.Background(), "tcp", "203.0.113.1:443"); err == nil || denied.Load() != 1 {
		t.Fatal("external dial was not rejected")
	}
	work := newSyncHTTPWork(boundary)
	if !authority.attachSyncWork("session-request", boundary, work) {
		t.Fatal("work was not attached")
	}
	work.start(target, request, 2*time.Second, nil)
	awaitSignal(t, work.done, "session request")
	if work.result.err != nil || requests.Load() != 1 || !boundary.wasAttempted() {
		t.Fatalf("expected one controlled write: %v", work.result.err)
	}
	if _, err := authority.finishSend("session-request", boundary); err != nil {
		t.Fatal(err)
	}
}

func TestSessionAttemptRequiresExplicitConfirmation(t *testing.T) {
	_, public, err := douyin.GenerateECKeypair()
	if err != nil {
		t.Fatal(err)
	}
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	fixture := &sessionLoginFixture{qrImage: base64.StdEncoding.EncodeToString(pngData.Bytes()), serverCert: public}
	initial, err := newUnauthenticatedContext("process-nonce")
	if err != nil {
		t.Fatal(err)
	}
	authority := newHelperGrants(initial, helperFixedDeployment{roomID: "12345"}, 0, time.Now, 32)
	auth := newSessionAuth(authority, func() (*douyin.Client, *sessionTransport, error) { return newSessionClient(fixture) })
	view, err := auth.start()
	if err != nil || view.AttemptID == "" {
		t.Fatal("start failed")
	}
	if err := auth.wait(view.AttemptID); err != nil {
		t.Fatal(err)
	}
	before := auth.view()
	if before.State != "confirmation_required" || before.BindingRef == "" || authority.context.session != nil {
		t.Fatal("login should require explicit confirmation")
	}
	if err := auth.confirm("wrong-ref"); err == nil || authority.context.session != nil {
		t.Fatal("invalid confirmation accepted")
	}
	if err := auth.confirm(before.BindingRef); err != nil || authority.context.session == nil || authority.deployment.principalUID != "18446744073709551615" {
		t.Fatal("valid confirmation failed")
	}
	if authority.active != nil {
		t.Fatal("confirmation granted permission to send")
	}
	record, err := authority.captureProfile(profileRequest{CaptureID: "fresh-capture", HelperNonce: "process-nonce", QualificationRevision: 1, IdentityEpoch: 1}, tlsTarget{}, tlsTarget{})
	if err != nil || record.state != "qualified" || record.qualification.principalUID != "18446744073709551615" {
		t.Fatal("fresh session qualification failed")
	}
	current := auth.view()
	if err := auth.cancel(current.AttemptID, current.Revision); err != nil || authority.context.validAt(time.Now()) {
		t.Fatal("logout failed to invalidate the session")
	}
}

func TestSessionPrivateProtocolRequiresConfirmation(t *testing.T) {
	_, public, err := douyin.GenerateECKeypair()
	if err != nil {
		t.Fatal(err)
	}
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	fixture := &sessionLoginFixture{qrImage: base64.StdEncoding.EncodeToString(pngData.Bytes()), serverCert: public}
	initial, err := newUnauthenticatedContext("protocol-process")
	if err != nil {
		t.Fatal(err)
	}
	authority := newHelperGrants(initial, helperFixedDeployment{roomID: "12345"}, 0, time.Now, 32)
	auth := newSessionAuth(authority, func() (*douyin.Client, *sessionTransport, error) { return newSessionClient(fixture) })
	server := &privateServer{authority: authority, session: auth}
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	finished := make(chan error, 1)
	go func() { finished <- server.serve(inputReader, outputWriter) }()
	defer func() { inputWriter.Close(); <-finished; outputReader.Close(); outputWriter.Close() }()
	exchange := func(seq uint64, kind string, payload any) fixtureReply {
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		hash, err := canonicalHash(payload)
		if err != nil {
			t.Fatal(err)
		}
		authority.mu.Lock()
		frame := privateFrame{Protocol: sessionPrivateProtocol, Seq: seq, Kind: kind, OperationID: kind, PayloadHash: hash,
			ExpectedHelperNonce: authority.context.processNonce, AuthContextID: authority.context.contextID,
			AuthContextRevision: authority.revision, MaterialDigest: authority.context.materialDigest, Payload: data}
		authority.mu.Unlock()
		if err := writePrivateFrame(inputWriter, frame); err != nil {
			t.Fatal(err)
		}
		var prefix [4]byte
		if _, err := io.ReadFull(outputReader, prefix[:]); err != nil {
			t.Fatal(err)
		}
		body := make([]byte, binary.BigEndian.Uint32(prefix[:]))
		if _, err := io.ReadFull(outputReader, body); err != nil {
			t.Fatal(err)
		}
		var reply fixtureReply
		if err := json.Unmarshal(body, &reply); err != nil {
			t.Fatal(err)
		}
		return reply
	}
	if got := exchange(1, "hello", map[string]any{}); got.Status != "available" {
		t.Fatal("session hello must not claim authenticated readiness")
	}
	started := exchange(2, "login-start", map[string]any{})
	if started.Status != "accepted" {
		t.Fatal("login start unavailable")
	}
	var view sessionLoginView
	if err := json.Unmarshal(started.Payload, &view); err != nil {
		t.Fatal(err)
	}
	if err := auth.wait(view.AttemptID); err != nil {
		t.Fatal(err)
	}
	status := exchange(3, "login-status", map[string]any{})
	if err := json.Unmarshal(status.Payload, &view); err != nil || view.State != "confirmation_required" {
		t.Fatal("missing session confirmation")
	}
	confirmed := exchange(4, "confirm-session", map[string]any{"bindingRef": view.BindingRef})
	if confirmed.Status != "authenticated" || authority.active != nil {
		t.Fatal("confirmation failed or granted send permission")
	}
}

func TestSessionCancellationJoinsAndRejectsStaleAttempt(t *testing.T) {
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	fixture := &sessionLoginFixture{qrImage: base64.StdEncoding.EncodeToString(pngData.Bytes()), blockPoll: true, entered: make(chan struct{})}
	initial, err := newUnauthenticatedContext("cancel-helper")
	if err != nil {
		t.Fatal(err)
	}
	authority := newHelperGrants(initial, helperFixedDeployment{roomID: "12345"}, 0, time.Now, 32)
	auth := newSessionAuth(authority, func() (*douyin.Client, *sessionTransport, error) { return newSessionClient(fixture) })
	view, err := auth.start()
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-fixture.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("login fixture did not start")
	}
	current := auth.view()
	if current.State != "waiting" || current.QRDataURL == "" {
		t.Fatal("QR status unavailable")
	}
	if err := auth.cancel(view.AttemptID, view.Revision); err != nil {
		t.Fatal(err)
	}
	if auth.view().State != "cancelled" || authority.context.session != nil {
		t.Fatal("cancel did not join or clear session")
	}
	if err := auth.confirm("old-binding"); err == nil {
		t.Fatal("stale confirmation accepted")
	}
	if err := auth.cancel(view.AttemptID, view.Revision); err == nil {
		t.Fatal("stale cancellation accepted")
	}
}

func TestSessionExpiredContextNeverPublishesIdentity(t *testing.T) {
	fixture := &sessionLoginFixture{}
	client, _, err := newSessionClient(fixture)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := loginAndCaptureSession(ctx, client, func(string) { t.Error("expired attempt published QR") }); !errors.Is(err, errSessionExpired) {
		t.Fatal("expired attempt was not rejected")
	}
}
