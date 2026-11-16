package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yunsur/douyin-mcp/douyin"
)

// TestSessionFixtureServer is a test-binary entry, never production main. It
// uses synthetic auth and an owned TLS loopback target for the real helper.
func TestSessionFixtureServer(t *testing.T) {
	if os.Getenv("DSH_SESSION_FIXTURE") != "1" {
		t.Skip("test fixture entry only")
	}
	qrPath, countPath := os.Getenv("DSH_QR_FIXTURE"), os.Getenv("DSH_CHAT_COUNT_FILE")
	if !filepath.IsAbs(qrPath) || !filepath.IsAbs(countPath) {
		t.Fatal("fixture paths unavailable")
	}
	qr, err := os.ReadFile(qrPath)
	if err != nil || len(qr) == 0 || len(qr) > 32768 {
		t.Fatal("fixture QR unavailable")
	}
	_, certificate, err := douyin.GenerateECKeypair()
	if err != nil {
		t.Fatal(err)
	}
	uid := os.Getenv("DSH_SYNTHETIC_UID")
	if uid != "" && uid != "43" {
		t.Fatal("fixture UID unavailable")
	}
	fixture := &sessionLoginFixture{qrImage: base64.StdEncoding.EncodeToString(qr), serverCert: certificate,
		waitOnce: true, queryUID: uid, profileUID: uid}
	contextID, err := newUnauthenticatedContext("fixture-helper")
	if err != nil {
		t.Fatal(err)
	}
	fixed := helperFixedDeployment{buildDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		instanceID: "fixture-instance", senderNonce: os.Getenv("DSH_SENDER_NONCE"), accountRecordID: "fixture-account", roomID: "12345"}
	revision := uint64(1)
	if fixed.senderNonce == "" {
		file := os.NewFile(4, "synthetic-deployment")
		if file == nil {
			t.Fatal("fixture deployment unavailable")
		}
		data, readErr := readPrivateDeployment(file)
		_ = file.Close()
		deployment, decodeErr := decodeSessionPrivateDeployment(data)
		if readErr != nil || decodeErr != nil || deployment.RoomID != "12345" {
			t.Fatal("fixture deployment unavailable")
		}
		fixed = helperFixedDeployment{buildDigest: deployment.BuildDigest, instanceID: deployment.InstanceID,
			senderNonce: deployment.SenderProcessNonce, accountRecordID: deployment.AccountRecordID, roomID: deployment.RoomID}
		revision = deployment.AuthContextRevision
	}
	if !validIdentifier(fixed.senderNonce) {
		t.Fatal("fixture nonce unavailable")
	}
	authority := newHelperGrants(contextID, fixed, revision, time.Now, 1024)
	auth := newSessionAuth(authority, func() (*douyin.Client, *sessionTransport, error) { return newSessionClient(fixture) })
	auth.viewState.Revision = revision
	var count atomic.Int32
	tlsServer := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := count.Add(1)
		valid := r.URL.Path == "/webcast/room/chat/" && r.URL.Query().Get("room_id") == "987654321" &&
			r.Header.Get("Referer") == "https://live.douyin.com/12345" && r.Header.Get("x-secsdk-csrf-token") == "synthetic-csrf"
		evidence, _ := json.Marshal(map[string]any{"chatCount": n, "valid": valid})
		_ = os.WriteFile(countPath, evidence, 0o600)
		if os.Getenv("DSH_DROP_SYNTHETIC_RESPONSE") == "1" {
			connection, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = connection.Close()
			}
			return
		}
		if os.Getenv("DSH_AUTH_CHANGE_FIXTURE") == "1" {
			time.Sleep(300 * time.Millisecond)
			w.Header().Add("Set-Cookie", "synthetic=rotated; Path=/")
		}
		w.Header().Set("Content-Type", "application/json")
		if !valid {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, `{"status_code":0}`)
	}))
	target := fixtureTarget(tlsServer)
	target.originHost, target.path = "live.douyin.com", "/webcast/room/chat/"
	target.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		if err := fixtureDialGuard(network, address); err != nil {
			return nil, err
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	server := &privateServer{authority: authority, session: auth, chatTarget: &target,
		profileTarget: &target, queryTarget: &target}
	err = server.serve(os.Stdin, os.Stdout)
	tlsServer.Close()
	if err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}
