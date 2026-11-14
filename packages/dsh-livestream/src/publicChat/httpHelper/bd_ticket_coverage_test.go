package main

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"
)

func makeSigningFixture(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return key, string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
}

func TestSigningFormatsECDHAndTicketPayload(t *testing.T) {
	client, clientPEM := makeSigningFixture(t)
	server, _ := makeSigningFixture(t)
	point := elliptic.Marshal(elliptic.P256(), server.X, server.Y)
	serverPub := "pub." + base64.StdEncoding.EncodeToString(point)
	expectedSharedX, _ := elliptic.P256().ScalarMult(server.X, server.Y, client.D.FillBytes(make([]byte, 32)))
	wantKey := hkdfSHA256(expectedSharedX.FillBytes(make([]byte, 32)), 32, nil, nil)

	pkcs8, err := x509.MarshalPKCS8PrivateKey(client)
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]string{
		"sec1":  clientPEM,
		"pkcs8": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8})),
		"raw":   hex.EncodeToString(client.D.FillBytes(make([]byte, 32))),
	}
	for name, encoded := range keys {
		t.Run(name, func(t *testing.T) {
			derived, err := DeriveECDHKey(encoded, serverPub)
			if err != nil || !hmac.Equal(derived, wantKey) {
				t.Fatalf("ECDH derivation mismatch: %v", err)
			}
			pub, err := base64.StdEncoding.DecodeString(GenerateReeKey(encoded))
			if err != nil || !hmac.Equal(pub, elliptic.Marshal(elliptic.P256(), client.X, client.Y)) {
				t.Fatal("public key does not match fixture")
			}
			signature, err := GetReqSign("fixture-message", encoded)
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := base64.StdEncoding.DecodeString(signature)
			digest := sha256.Sum256([]byte("fixture-message"))
			if err != nil || !ecdsa.VerifyASN1(&client.PublicKey, digest[:], decoded) {
				t.Fatal("signature failed independent verification")
			}
		})
	}

	now := time.Now().UTC()
	certificate := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Minute), KeyUsage: x509.KeyUsageKeyAgreement}
	certDER, err := x509.CreateCertificate(rand.Reader, certificate, certificate, &server.PublicKey, server)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}))
	certKey, err := DeriveECDHKey(clientPEM, certPEM)
	if err != nil || !hmac.Equal(certKey, wantKey) {
		t.Fatalf("certificate ECDH mismatch: %v", err)
	}

	trust := 3
	for _, mode := range []string{"ecdsa", "hmac"} {
		t.Run("payload-"+mode, func(t *testing.T) {
			var material []byte
			if mode == "hmac" {
				material = wantKey
			}
			encoded, actualMode, err := GenerateBDTicketClientData("/fixed", "fixture-ticket", "ts.1.fixture", clientPEM, mode, material, 42, &trust)
			if err != nil || actualMode != mode {
				t.Fatalf("ticket payload: mode=%q error=%v", actualMode, err)
			}
			payloadBytes, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				t.Fatal(err)
			}
			var payload struct {
				TsSign    string `json:"ts_sign"`
				Content   string `json:"req_content"`
				Signature string `json:"req_sign"`
				Timestamp int64  `json:"timestamp"`
				Trust     int    `json:"t_trust"`
			}
			if err := json.Unmarshal(payloadBytes, &payload); err != nil {
				t.Fatal(err)
			}
			if payload.TsSign != "ts.1.fixture" || payload.Content != "ticket,path,timestamp" || payload.Timestamp != 42 || payload.Trust != 3 {
				t.Fatal("unexpected ticket fields")
			}
			sig, err := base64.StdEncoding.DecodeString(payload.Signature)
			if err != nil {
				t.Fatal(err)
			}
			message := []byte("ticket=fixture-ticket&path=/fixed&timestamp=42")
			if mode == "hmac" {
				mac := hmac.New(sha256.New, wantKey)
				mac.Write(message)
				if !hmac.Equal(sig, mac.Sum(nil)) {
					t.Fatal("ticket HMAC mismatch")
				}
			} else {
				digest := sha256.Sum256(message)
				if !ecdsa.VerifyASN1(&client.PublicKey, digest[:], sig) {
					t.Fatal("ticket signature mismatch")
				}
			}
		})
	}
	if TicketGuardVersion("ts.1.fixture") != "1" || TicketGuardVersion("other") != "2" {
		t.Fatal("ticket guard version mismatch")
	}
}

func TestSigningRejectsMalformedKeysAndServerMaterial(t *testing.T) {
	_, good := makeSigningFixture(t)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	otherDER, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	other := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: otherDER}))
	for _, key := range []string{"", "not-hex", strings.Repeat("00", 32), "-----BEGIN INVALID-----\n", good + "unexpected", other} {
		if _, err := loadSigningKey(key); err == nil {
			t.Fatal("invalid signing key accepted")
		}
		if GenerateReeKey(key) != "" {
			t.Fatal("invalid key produced a public key")
		}
		if _, err := GetReqSign("fixture", key); err == nil {
			t.Fatal("invalid key produced a signature")
		}
	}
	for _, cert := range []string{"pub.%%%", "pub." + base64.StdEncoding.EncodeToString([]byte{4, 1}), "%%%%", base64.StdEncoding.EncodeToString([]byte("no point")), base64.StdEncoding.EncodeToString(append(p256SPKIPrefix, 1))} {
		if _, err := DeriveECDHKey(good, cert); err == nil {
			t.Fatal("invalid server material accepted")
		}
	}
	if _, err := DeriveECDHKey("not-hex", "pub.AA=="); err == nil {
		t.Fatal("invalid private key accepted")
	}
	if _, err := ecdh.P256().NewPublicKey([]byte{4, 1}); err == nil {
		t.Fatal("fixture point unexpectedly valid")
	}
	if _, _, err := GenerateBDTicketClientData("/fixed", "fixture", "sign", "bad", "ecdsa", nil, 1, nil); err == nil {
		t.Fatal("invalid ECDSA key accepted")
	}
}

func TestHKDFAndCanonicalHMACVectors(t *testing.T) {
	ikm := []byte(strings.Repeat("\x0b", 22))
	salt, _ := hex.DecodeString("000102030405060708090a0b0c")
	info, _ := hex.DecodeString("f0f1f2f3f4f5f6f7f8f9")
	want := "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
	if got := hex.EncodeToString(hkdfSHA256(ikm, 42, salt, info)); got != want {
		t.Fatal("RFC 5869 HKDF vector mismatch")
	}
	key := []byte("synthetic-key")
	message := `{"a":1}`
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(message))
	if GetReqSignHMAC(map[string]int{"a": 1}, key) != base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
		t.Fatal("JSON HMAC mismatch")
	}
	if jsonCompact(v2any(message)) != message || v2any("not-json") != "not-json" {
		t.Fatal("JSON normalization mismatch")
	}
	if jsonCompact(make(chan int)) != "" {
		t.Fatal("unencodable JSON did not fail closed")
	}
}
