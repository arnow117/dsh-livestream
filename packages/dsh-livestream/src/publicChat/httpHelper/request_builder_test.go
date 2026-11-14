package main

import (
	"strings"
	"testing"
	"time"
)

func TestFixedRequestsUseSameFrozenContextAndSeparateRoomIDs(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	context, err := freezeAuthContext(fixtureMaterial(t, now), now)
	if err != nil {
		t.Fatal(err)
	}
	profile, err := buildFixedRequest(context, "profile_self", nil, "", now)
	if err != nil {
		t.Fatal(err)
	}
	query, err := buildFixedRequest(context, "query_user", nil, "", now)
	if err != nil {
		t.Fatal(err)
	}
	grant := &committedGrant{grantProposal: grantProposal{RoomID: "101", PlatformRoomID: "202",
		HelperProcessNonce: context.processNonce, AuthContextID: context.contextID, MaterialDigest: context.materialDigest}}
	chat, err := buildFixedRequest(context, "chat", grant, "fixture text", now)
	if err != nil {
		t.Fatal(err)
	}
	if profile.Header.Get("Cookie") != query.Header.Get("Cookie") || profile.Header.Get("Cookie") != chat.Header.Get("Cookie") ||
		chat.URL.Query().Get("room_id") != "202" || chat.Header.Get("Referer") != "https://live.douyin.com/101" ||
		!strings.Contains(chat.URL.RawQuery, "a_bogus=") || chat.Header.Get("bd-ticket-guard-client-data") == "" {
		t.Fatal("fixed request did not retain its frozen context or room binding")
	}
	grant.AuthContextID = "replacement"
	if _, err := buildFixedRequest(context, "chat", grant, "fixture text", now); err == nil {
		t.Fatal("mismatched authentication context accepted")
	}
	if _, err := buildFixedRequest(context, "profile_self", nil, "", now.Add(time.Minute)); err == nil {
		t.Fatal("expired frozen material accepted")
	}
}
