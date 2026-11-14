package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func materialFixtureValue(t *testing.T, now time.Time) materialInput {
	t.Helper()
	var value materialInput
	if err := json.Unmarshal(fixtureMaterial(t, now), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func marshalMaterial(t *testing.T, value materialInput) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestMaterialRejectsInvalidScopeEncodingAndCookieConflicts(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	cases := []struct {
		name string
		edit func(*materialInput)
	}{
		{"expired", func(m *materialInput) { m.ExpiresAtMs = now.UnixMilli() }},
		{"csrf-expired", func(m *materialInput) { m.CSRFExpiresMs = now.UnixMilli() }},
		{"csrf-origin", func(m *materialInput) { m.CSRFOrigin = "https://invalid.example" }},
		{"csrf-path", func(m *materialInput) { m.CSRFPath = "/wrong" }},
		{"geometry", func(m *materialInput) { m.Geo = nil }},
		{"screen", func(m *materialInput) { m.ScreenWidth = 0 }},
		{"mode", func(m *materialInput) { m.BDMode = "other" }},
		{"missing-agent", func(m *materialInput) { m.UserAgent = "" }},
		{"control-character", func(m *materialInput) { m.CSRFToken = "bad\nvalue" }},
		{"missing-key", func(m *materialInput) { m.PrivateKey = "" }},
		{"invalid-key", func(m *materialInput) { m.PrivateKey = "invalid" }},
		{"no-cookie", func(m *materialInput) { m.Cookies = nil }},
		{"unexpected-cert", func(m *materialInput) { m.ServerCert = "unexpected" }},
		{"missing-hmac-cert", func(m *materialInput) { m.BDMode = "hmac"; m.ServerCert = "" }},
		{"invalid-hmac-cert", func(m *materialInput) { m.BDMode = "hmac"; m.ServerCert = "pub.AA==" }},
		{"bad-pem-cert", func(m *materialInput) {
			m.BDMode = "hmac"
			m.ServerCert = "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----"
		}},
	}
	for _, name := range []string{"UIFID", "s_v_web_id", "msToken"} {
		name := name
		cases = append(cases, struct {
			name string
			edit func(*materialInput)
		}{"conflict-" + name, func(m *materialInput) {
			c := validCookie(name, "different")
			c.ExpiresAtMs = now.Add(time.Minute).UnixMilli()
			m.Cookies = append(m.Cookies, c)
		}})
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value := materialFixtureValue(t, now)
			tc.edit(&value)
			if _, err := freezeAuthContext(marshalMaterial(t, value), now); err == nil {
				t.Fatal("invalid material accepted")
			}
		})
	}
	invalid := [][]byte{nil, {0xff}, []byte(`{"x":1,"x":2}`), []byte(`{"unknown":true}`), []byte(`{} {}`), []byte(`"\ud800"`), make([]byte, maxMaterialBytes+1)}
	for _, data := range invalid {
		if _, err := freezeAuthContext(data, now); err == nil {
			t.Fatal("invalid encoding or schema accepted")
		}
	}
	var absent *authContext
	if absent.validAt(now) {
		t.Fatal("nil context accepted")
	}
}

func TestMaterialHMACCertificateAndExpiry(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	server, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	point := elliptic.Marshal(elliptic.P256(), server.X, server.Y)
	value := materialFixtureValue(t, now)
	value.BDMode = "hmac"
	value.ServerCert = "pub." + base64.StdEncoding.EncodeToString(point)
	context, err := freezeAuthContext(marshalMaterial(t, value), now)
	if err != nil || len(context.ecdhKey) != 32 || !context.validAt(now) {
		t.Fatal("valid synthetic HMAC material was rejected")
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: now.Add(-time.Minute), NotAfter: now.Add(30 * time.Second), KeyUsage: x509.KeyUsageKeyAgreement}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &server.PublicKey, server)
	if err != nil {
		t.Fatal(err)
	}
	value.ServerCert = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	context, err = freezeAuthContext(marshalMaterial(t, value), now)
	if err != nil || !context.validAt(now) || context.validAt(now.Add(30*time.Second)) {
		t.Fatal("certificate validity was not enforced")
	}
	if _, err := freezeAuthContext(marshalMaterial(t, value), now.Add(31*time.Second)); err == nil {
		t.Fatal("expired certificate was accepted")
	}
	value.ServerCert += "unexpected"
	if _, err := freezeAuthContext(marshalMaterial(t, value), now); err == nil {
		t.Fatal("certificate trailing bytes were accepted")
	}
}

func TestPrivateDeploymentDescriptorAndSchema(t *testing.T) {
	valid := privateDeployment{BuildDigest: strings.Repeat("a", 64), InstanceID: "fixture-instance", SenderProcessNonce: "fixture-sender",
		AccountRecordID: "fixture-record", PrincipalUID: "42", RoomID: "101", AuthContextRevision: 1}
	data, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	path := filepath.Join(root, "deployment")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := loadPrivateDeployment(file)
	if err != nil || got != valid {
		t.Fatal("valid private deployment rejected")
	}
	if _, err := loadPrivateDeployment(file); err == nil {
		t.Fatal("nonzero offset accepted")
	}
	file.Close()
	writable, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := loadPrivateDeployment(writable); err == nil {
		t.Fatal("writable descriptor accepted")
	}
	writable.Close()
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	file, err = os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := loadPrivateDeployment(file); err == nil {
		t.Fatal("public permissions accepted")
	}
	file.Close()
	for _, candidate := range [][]byte{[]byte(`{}`), []byte(`{"unknown":1}`), append(data, []byte(`{}`)...), make([]byte, maxFrameBytes+1)} {
		if err := os.WriteFile(path, candidate, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0600); err != nil {
			t.Fatal(err)
		}
		file, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		_, err = loadPrivateDeployment(file)
		file.Close()
		if err == nil {
			t.Fatal("malformed deployment accepted")
		}
	}
}

func TestMaterialDescriptorRejectsUnsafeHandles(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	if _, err := materialFromFD(nil, now); err == nil {
		t.Fatal("nil descriptor accepted")
	}
	root := t.TempDir()
	path := filepath.Join(root, "material")
	if err := os.WriteFile(path, fixtureMaterial(t, now), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(path, filepath.Join(root, "second-link")); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := materialFromFD(file, now); err == nil {
		t.Fatal("multiply linked material accepted")
	}
	file.Close()
	if err := os.Remove(filepath.Join(root, "second-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte{0xff}, 0600); err != nil {
		t.Fatal(err)
	}
	file, err = os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := materialFromFD(file, now); err == nil {
		t.Fatal("invalid material encoding accepted")
	}
}
