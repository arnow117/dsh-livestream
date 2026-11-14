package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func fixtureMaterial(t *testing.T, now time.Time) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	geometry := [8]int{1, 2, 3, 4, 5, 6, 7, 8}
	cookie := validCookie("fixture", "value")
	cookie.ExpiresAtMs = now.Add(time.Minute).UnixMilli()
	material := materialInput{
		Cookies: []cookieMaterial{cookie}, UserAgent: "fixture", BrowserName: "fixture", BrowserVersion: "1",
		BrowserLanguage: "fixture", EngineName: "fixture", EngineVersion: "1", OSName: "fixture", OSVersion: "1", CPUCoreNum: "1", DeviceMemory: "1",
		Platform: "fixture", ScreenWidth: 1, ScreenHeight: 1, Geo: &geometry,
		MsToken: "fixture", WebID: "fixture", VerifyFP: "fixture", UIFID: "fixture", Ticket: "fixture", TsSign: "fixture",
		PrivateKey: string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})),
		BDMode:     "ecdsa",
		CSRFToken:  "fixture", CSRFOrigin: "https://live.douyin.com", CSRFPath: "/webcast/room/chat/",
		CSRFExpiresMs: now.Add(2 * time.Minute).UnixMilli(), ExpiresAtMs: now.Add(3 * time.Minute).UnixMilli(),
	}
	data, err := json.Marshal(material)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestAuthContextFrozenAndExpires(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	data := fixtureMaterial(t, now)
	context, err := freezeAuthContext(data, now)
	if err != nil {
		t.Fatal(err)
	}
	for i := range data {
		data[i] = 0
	}
	if !context.validAt(now) || context.validAt(now.Add(time.Minute)) || context.contextID == context.processNonce {
		t.Fatal("invalid frozen context lifecycle")
	}
}

func TestMaterialDescriptorMustBeReadOnly(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	path := filepath.Join(t.TempDir(), "material")
	if err := os.WriteFile(path, fixtureMaterial(t, now), 0600); err != nil {
		t.Fatal(err)
	}
	writable, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = materialFromFD(writable, now); err == nil {
		t.Fatal("writable descriptor accepted")
	}
	writable.Close()
	readOnly, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer readOnly.Close()
	if _, err = materialFromFD(readOnly, now); err != nil {
		t.Fatal(err)
	}
	if _, err = materialFromFD(readOnly, now); err == nil {
		t.Fatal("material descriptor with nonzero offset accepted")
	}
}
