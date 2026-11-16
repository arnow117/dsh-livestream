package douyin

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"
)

// DSHSessionSnapshot is deliberately opaque: credentials stay inside this
// process and are not serialized as the legacy material format.
type DSHSessionSnapshot struct {
	owner                                                          *Client
	room, ticket, tsSign, privateKey, token, csrf, cookies, digest string
	key                                                            []byte
}

func (s *DSHSessionSnapshot) Digest() string {
	if s == nil {
		return ""
	}
	return s.digest
}

func decimalRoom(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// PrepareSessionAuth obtains the exact live-origin CSRF and ticket certificate
// using this same client. It does not infer server-side expiry or scopes.
func (c *Client) PrepareSessionAuth(ctx context.Context, webRID string) (*DSHSessionSnapshot, error) {
	if c == nil || !decimalRoom(webRID) || c.Ticket == "" || c.TsSign == "" || c.PrivateKey == "" || c.MsToken() == "" {
		return nil, errors.New("session authentication unavailable")
	}
	csrf := c.CSRFToken(ctx, liveBase, "/webcast/room/chat/")
	if csrf == "" {
		return nil, errors.New("session csrf unavailable")
	}
	certificate, _, err := c.FetchServerCert(ctx, 6383, liveBase)
	if err != nil || certificate == "" {
		return nil, errors.New("session certificate unavailable")
	}
	key, err := DeriveECDHKey(c.PrivateKey, certificate)
	if err != nil || len(key) == 0 {
		return nil, errors.New("session certificate unavailable")
	}
	source, ok := c.HTTP.(interface{ DSHSessionCookies() (string, error) })
	if !ok {
		return nil, errors.New("session cookie unavailable")
	}
	cookies, err := source.DSHSessionCookies()
	if err != nil || cookies == "" {
		return nil, errors.New("session cookie unavailable")
	}
	token := c.MsToken()
	if token == "" {
		return nil, errors.New("session token unavailable")
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, errors.New("session unavailable")
	}
	h := sha256.New()
	h.Write([]byte("dsh-session-http-v1\x00"))
	h.Write(nonce[:])
	for _, item := range []string{webRID, c.Ticket, c.TsSign, c.PrivateKey, token, csrf, cookies, certificate} {
		h.Write([]byte{0})
		h.Write([]byte(item))
	}
	return &DSHSessionSnapshot{owner: c, room: webRID, ticket: c.Ticket, tsSign: c.TsSign, privateKey: c.PrivateKey,
		token: token, csrf: csrf, cookies: cookies, key: append([]byte(nil), key...), digest: hex.EncodeToString(h.Sum(nil))}, nil
}

// Current fails closed when any in-memory authentication component changes.
func (s *DSHSessionSnapshot) Current(c *Client) bool {
	if s == nil || c == nil || s.owner != c || c.Ticket != s.ticket || c.TsSign != s.tsSign || c.PrivateKey != s.privateKey || c.MsToken() != s.token {
		return false
	}
	source, ok := c.HTTP.(interface{ DSHSessionCookies() (string, error) })
	if !ok {
		return false
	}
	cookies, err := source.DSHSessionCookies()
	return err == nil && cookies == s.cookies
}

// BuildSessionChat only constructs a request. The caller must execute it via
// the existing single-write boundary and revalidate the grant before Write.
func (c *Client) BuildSessionChat(s *DSHSessionSnapshot, webRID, platformRoomID, text string) (*http.Request, error) {
	if c == nil || s == nil || s.owner != c || s.room != webRID || !decimalRoom(webRID) || !decimalRoom(platformRoomID) || text == "" || len(text) > 4096 ||
		c.Ticket != s.ticket || c.TsSign != s.tsSign || c.PrivateKey != s.privateKey || c.MsToken() != s.token {
		return nil, errors.New("session authentication changed")
	}
	source, ok := c.HTTP.(interface{ DSHSessionCookies() (string, error) })
	if !ok {
		return nil, errors.New("session cookie unavailable")
	}
	cookies, err := source.DSHSessionCookies()
	if err != nil || cookies != s.cookies {
		return nil, errors.New("session authentication changed")
	}
	profile := GetProfile()
	params := NewParams()
	for _, item := range [][2]string{
		{"aid", "6383"}, {"app_name", "douyin_web"}, {"live_id", "1"}, {"device_platform", "web"},
		{"language", "zh-CN"}, {"enter_from", "link_share"}, {"cookie_enabled", "true"},
		{"screen_width", profile.ScreenWidth}, {"screen_height", profile.ScreenHeight},
		{"browser_language", "zh-CN"}, {"browser_platform", "Win32"}, {"browser_name", profile.BrowserName},
		{"browser_version", profile.BrowserVersion}, {"room_id", platformRoomID}, {"content", text},
		{"type", "0"}, {"msToken", s.token},
	} {
		params.Add(item[0], item[1])
	}
	params.WithABogusHost(c, nil, liveSubHost)
	req, err := http.NewRequest(http.MethodGet, liveBase+"/webcast/room/chat/?"+params.SpliceURL(), nil)
	if err != nil {
		return nil, errors.New("session request unavailable")
	}
	data, mode, err := GenerateBDTicketClientData("/webcast/room/chat/", s.ticket, s.tsSign, s.privateKey, s.key, time.Now().Unix(), nil)
	if err != nil || mode != "hmac" {
		return nil, errors.New("session signing unavailable")
	}
	publicKey := GenerateReeKey(s.privateKey)
	if publicKey == "" || strings.ContainsAny(s.csrf, "\r\n") {
		return nil, errors.New("session signing unavailable")
	}
	req.Header.Set("User-Agent", profile.UA)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cookie", s.cookies)
	req.Header.Set("Origin", liveBase)
	req.Header.Set("Referer", liveBase+"/"+webRID)
	req.Header.Set("x-secsdk-csrf-token", s.csrf)
	req.Header.Set("bd-ticket-guard-client-data", data)
	req.Header.Set("bd-ticket-guard-ree-public-key", publicKey)
	req.Header.Set("bd-ticket-guard-version", "2")
	req.Header.Set("bd-ticket-guard-web-version", TicketGuardVersion(s.tsSign))
	req.Header.Set("bd-ticket-guard-web-sign-type", "1")
	return req, nil
}
