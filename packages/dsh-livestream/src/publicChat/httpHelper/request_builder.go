package main

import (
	cryptorand "crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"strconv"
	"time"
)

func signerForRequest(context *authContext, now time.Time) (*AbogusSigner, error) {
	if context == nil || !context.validAt(now) || context.material.Geo == nil {
		return nil, errors.New("authentication context unavailable")
	}
	var seed [16]byte
	if _, err := cryptorand.Read(seed[:]); err != nil {
		return nil, errors.New("random source unavailable")
	}
	random := rand.New(rand.NewPCG(binary.BigEndian.Uint64(seed[:8]), binary.BigEndian.Uint64(seed[8:])))
	signer := newAbogusSigner(context.material.UserAgent, *context.material.Geo, context.material.Platform, random, func() int64 {
		return now.UnixMilli()
	})
	if signer == nil {
		return nil, errors.New("signer unavailable")
	}
	return signer, nil
}

func platformParameters(material materialInput) *Params {
	p := NewParams()
	for _, item := range [][2]string{
		{"device_platform", "webapp"}, {"aid", "6383"}, {"channel", "channel_pc_web"},
		{"update_version_code", "170400"}, {"pc_client_type", "1"}, {"pc_libra_divert", "Windows"},
		{"support_h265", "1"}, {"support_dash", "1"}, {"cpu_core_num", material.CPUCoreNum},
		{"version_code", "170400"}, {"version_name", "17.4.0"}, {"cookie_enabled", "true"},
		{"screen_width", strconv.Itoa(material.ScreenWidth)}, {"screen_height", strconv.Itoa(material.ScreenHeight)},
		{"browser_language", material.BrowserLanguage}, {"browser_platform", material.Platform},
		{"browser_name", material.BrowserName}, {"browser_version", material.BrowserVersion},
		{"browser_online", "true"}, {"engine_name", material.EngineName}, {"engine_version", material.EngineVersion},
		{"os_name", material.OSName}, {"os_version", material.OSVersion}, {"device_memory", material.DeviceMemory},
		{"platform", "PC"}, {"downlink", "10"}, {"effective_type", "4g"}, {"round_trip_time", "0"},
	} {
		p.Add(item[0], item[1])
	}
	return p
}

func buildFixedRequest(context *authContext, operation string, grant *committedGrant, text string, now time.Time) (*http.Request, error) {
	target, err := productionTarget(operation)
	if err != nil {
		return nil, err
	}
	signer, err := signerForRequest(context, now)
	if err != nil {
		return nil, err
	}
	material := context.material
	var params *Params
	var referer string
	if operation == "chat" {
		if grant == nil || !validWebRoomID(grant.RoomID) || !validDecimal(grant.PlatformRoomID) || text == "" ||
			grant.HelperProcessNonce != context.processNonce || grant.AuthContextID != context.contextID ||
			grant.MaterialDigest != context.materialDigest {
			return nil, errors.New("invalid fixed target")
		}
		params = NewParams()
		for _, item := range [][2]string{
			{"aid", "6383"}, {"app_name", "douyin_web"}, {"live_id", "1"}, {"device_platform", "web"},
			{"language", material.BrowserLanguage}, {"enter_from", "link_share"}, {"cookie_enabled", "true"},
			{"screen_width", strconv.Itoa(material.ScreenWidth)}, {"screen_height", strconv.Itoa(material.ScreenHeight)},
			{"browser_language", material.BrowserLanguage}, {"browser_platform", material.Platform},
			{"browser_name", material.BrowserName}, {"browser_version", material.BrowserVersion},
			{"room_id", grant.PlatformRoomID}, {"content", text}, {"type", "0"}, {"msToken", material.MsToken},
		} {
			params.Add(item[0], item[1])
		}
		referer = "https://live.douyin.com/" + grant.RoomID
	} else {
		params = platformParameters(material)
		if operation == "query_user" {
			// This key precedes the platform parameters in the fixed source.
			prefixed := NewParams().Add("publish_video_strategy_type", "2")
			params = prefixed.Merge(params)
			referer = "https://www.douyin.com/"
		} else {
			referer = "https://www.douyin.com/user/self"
		}
		if operation == "query_user" {
			params.Add("uifid", material.UIFID).Add("webid", material.WebID)
		} else {
			params.Add("webid", material.WebID).Add("uifid", material.UIFID)
		}
		params.Add("verifyFp", material.VerifyFP).Add("fp", material.VerifyFP)
		if operation == "profile_self" {
			params.Add("msToken", material.MsToken)
		}
	}
	signature := signer.SignQuery(params.SpliceURL(), "", target.originHost)
	if signature == "" {
		return nil, errors.New("signature unavailable")
	}
	params.Add("a_bogus", signature)
	request, err := http.NewRequest(http.MethodGet, "https://"+target.originHost+target.path+"?"+params.SpliceURL(), nil)
	if err != nil {
		return nil, errors.New("invalid request")
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", material.UserAgent)
	request.Header.Set("Cookie", context.cookies.header)
	request.Header.Set("Referer", referer)
	if operation == "chat" {
		clientData, mode, err := GenerateBDTicketClientData(target.path, material.Ticket, material.TsSign,
			material.PrivateKey, material.BDMode, context.ecdhKey, now.Unix(), nil)
		if err != nil {
			return nil, errors.New("ticket signature unavailable")
		}
		publicKey := GenerateReeKey(material.PrivateKey)
		if publicKey == "" {
			return nil, errors.New("public key unavailable")
		}
		request.Header.Set("Origin", "https://live.douyin.com")
		request.Header.Set("x-secsdk-csrf-token", material.CSRFToken)
		request.Header.Set("bd-ticket-guard-client-data", clientData)
		request.Header.Set("bd-ticket-guard-ree-public-key", publicKey)
		request.Header.Set("bd-ticket-guard-version", "2")
		request.Header.Set("bd-ticket-guard-web-version", TicketGuardVersion(material.TsSign))
		if mode == "hmac" {
			request.Header.Set("bd-ticket-guard-web-sign-type", "1")
		} else if mode == "ecdsa" {
			request.Header.Set("bd-ticket-guard-web-sign-type", "0")
		} else {
			return nil, fmt.Errorf("invalid signing mode")
		}
	}
	return request, nil
}
