package main

import (
	"encoding/hex"
	"math/rand/v2"
	"testing"
)

func TestSM3KnownVector(t *testing.T) {
	got := hex.EncodeToString(sm3Hash([]byte("abc")))
	if got != "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0" {
		t.Fatal("SM3 vector mismatch")
	}
}

func TestSigningRequiresExplicitModeAndSource(t *testing.T) {
	if _, _, err := GenerateBDTicketClientData("/fixed", "ticket", "sign", "", "hmac", nil, 1, nil); err == nil {
		t.Fatal("missing HMAC material was accepted")
	}
	if _, _, err := GenerateBDTicketClientData("/fixed", "ticket", "sign", "", "unexpected", []byte("key"), 1, nil); err == nil {
		t.Fatal("unknown signing mode was accepted")
	}
	if _, _, err := GenerateBDTicketClientData("/fixed", "ticket", "sign", "", "hmac", []byte("key"), 0, nil); err == nil {
		t.Fatal("missing timestamp was accepted")
	}
	random := rand.New(rand.NewPCG(1, 2))
	signer := newAbogusSigner("fixture", [8]int{}, "fixture", random, func() int64 { return 1721836800001 })
	if signer == nil || signer.SignQuery("x=1", "", "untrusted.example") != "" {
		t.Fatal("unknown host was not rejected")
	}
}
