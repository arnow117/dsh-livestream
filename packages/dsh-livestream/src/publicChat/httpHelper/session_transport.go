package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"

	"github.com/yunsur/douyin-mcp/douyin"
)

// sessionTransport confines the mutable login client's network access and keeps
// server-issued cookies in a private scoped jar. The upstream cookie mapping has
// no domain or path metadata and must never be forwarded as a Cookie header.
type sessionTransport struct {
	inner        douyin.Transport
	jar          http.CookieJar
	mu           sync.Mutex
	cookieWrites int
}

func newSessionTransport(inner douyin.Transport) (*sessionTransport, error) {
	if inner == nil {
		return nil, errors.New("session transport unavailable")
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	return &sessionTransport{inner: inner, jar: jar}, nil
}

// DSHSetGeneratedCookie is called only at the upstream generation sites, not
// when upstream merges a response. Give those locally generated values explicit
// host-only scopes instead of forwarding the upstream unscoped cookie map.
func (s *sessionTransport) DSHSetGeneratedCookie(name, value string) {
	switch name {
	case "s_v_web_id", "bd_ticket_guard_client_data", "bd_ticket_guard_client_web_domain", "bd_ticket_guard_client_data_v2":
	default:
		return
	}
	cookie := &http.Cookie{Name: name, Value: value, Path: "/", Secure: true}
	if len(value) > 4096 || cookie.Valid() != nil {
		return
	}
	if value == "" {
		cookie.MaxAge = -1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, host := range []string{"www.douyin.com", "login.douyin.com", "live.douyin.com"} {
		u := &url.URL{Scheme: "https", Host: host, Path: "/"}
		s.jar.SetCookies(u, []*http.Cookie{cookie})
	}
}

// Only endpoints needed by the QR bootstrap, identity capture and ticket
// preparation are accepted. Chat uses the separate controlled write path.
func sessionRequestURL(raw string) (*url.URL, error) {
	if len(raw) == 0 || len(raw) > 16384 {
		return nil, errors.New("session target denied")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Opaque != "" || u.Port() != "" || u.RawPath != "" || u.Host != u.Hostname() {
		return nil, errors.New("session target denied")
	}
	allowed := false
	switch u.Hostname() {
	case "www.douyin.com":
		switch u.Path {
		case "/", "/ttwid/check/", "/passport/general/login_guiding_strategy/", "/passport/user_info/get_sec_ts/", "/passport/ticket_guard/get_client_cert/", "/aweme/v1/web/user/profile/self/", "/aweme/v1/web/query/user", "/aweme/v1/web/query/user/":
			allowed = true
		}
	case "login.douyin.com":
		switch u.Path {
		case "/ttwid/check/", "/passport/web/get_qrcode/", "/passport/web/check_qrconnect/":
			allowed = true
		}
	case "live.douyin.com":
		switch u.Path {
		case "/webcast/room/chat/", "/service/2/abtest_config/", "/passport/ticket_guard/get_client_cert/":
			allowed = true
		}
	case "ttwid.bytedance.com":
		allowed = u.Path == "/ttwid/union/register/"
	case "mssdk.bytedance.com":
		allowed = u.Path == "/web/r/token" || u.Path == "/web/common"
	}
	if !allowed {
		return nil, errors.New("session target denied")
	}
	return u, nil
}

func (s *sessionTransport) Do(ctx context.Context, method, raw string, headers douyin.Headers, _ string, body []byte) (*douyin.Response, error) {
	u, err := sessionRequestURL(raw)
	validMethod := method == http.MethodGet || method == http.MethodPost
	if err == nil && u.Hostname() == "live.douyin.com" {
		validMethod = (method == http.MethodHead && (u.Path == "/webcast/room/chat/" || u.Path == "/service/2/abtest_config/")) ||
			(method == http.MethodPost && u.Path == "/passport/ticket_guard/get_client_cert/")
	}
	if err != nil || !validMethod {
		return nil, errors.New("session target denied")
	}
	// Authentication is serialized: response cookies cannot race another
	// request selecting a header from the same jar.
	s.mu.Lock()
	defer s.mu.Unlock()
	cookies := s.jar.Cookies(u)
	parts := make([]string, 0, len(cookies))
	for _, cookie := range cookies {
		parts = append(parts, cookie.Name+"="+cookie.Value)
	}
	safeHeaders := append(douyin.Headers(nil), headers...)
	safeHeaders.Del("cookie")
	response, err := s.inner.Do(ctx, method, raw, safeHeaders, strings.Join(parts, "; "), body)
	if err != nil || response == nil {
		return nil, errors.New("session request unavailable")
	}
	if len(response.Cookies) > 128 {
		return nil, errors.New("session cookie limit")
	}
	accepted := make([]*http.Cookie, 0, len(response.Cookies))
	for _, received := range response.Cookies {
		if received == nil || len(received.Name) > 256 || len(received.Value) > 4096 {
			continue
		}
		domain := strings.TrimPrefix(strings.ToLower(received.Domain), ".")
		if domain != "" && domain != u.Hostname() && !strings.HasSuffix(u.Hostname(), "."+domain) {
			continue
		}
		// A parent domain must remain within the same known site, never a
		// public suffix or a domain belonging to another service.
		if domain != "" && domain != "douyin.com" && domain != "bytedance.com" && domain != u.Hostname() {
			continue
		}
		cookie := &http.Cookie{Name: received.Name, Value: received.Value, Domain: received.Domain,
			Path: received.Path, Expires: received.Expires, MaxAge: received.MaxAge,
			Secure: received.Secure, HttpOnly: received.HttpOnly}
		if cookie.Valid() == nil {
			accepted = append(accepted, cookie)
		}
	}
	if s.cookieWrites+len(accepted) > 256 {
		return nil, errors.New("session cookie limit")
	}
	s.cookieWrites += len(accepted)
	s.jar.SetCookies(u, accepted)
	return response, nil
}

func (s *sessionTransport) Get(ctx context.Context, raw string, headers douyin.Headers, cookie string) (*douyin.Response, error) {
	return s.Do(ctx, http.MethodGet, raw, headers, cookie, nil)
}

func (s *sessionTransport) GetNoRedirect(ctx context.Context, raw string, headers douyin.Headers, cookie string) (*douyin.Response, error) {
	return s.Get(ctx, raw, headers, cookie)
}

func (s *sessionTransport) PostJSON(ctx context.Context, raw string, headers douyin.Headers, cookie, contentType string, body []byte) (*douyin.Response, error) {
	copied := append(douyin.Headers(nil), headers...)
	if contentType != "" {
		copied.Set("content-type", contentType)
	}
	return s.Do(ctx, http.MethodPost, raw, copied, cookie, body)
}

// DSHSessionCookies supplies only jar-scoped cookies for the fixed chat origin.
func (s *sessionTransport) DSHSessionCookies() (string, error) {
	u, _ := url.Parse("https://live.douyin.com/webcast/room/chat/")
	s.mu.Lock()
	defer s.mu.Unlock()
	cookies := s.jar.Cookies(u)
	parts := make([]string, 0, len(cookies))
	authenticated := false
	for _, cookie := range cookies {
		if cookie.Name == "sessionid" || cookie.Name == "sessionid_ss" {
			authenticated = cookie.Value != ""
		}
		parts = append(parts, cookie.Name+"="+cookie.Value)
	}
	if !authenticated || len(parts) > 128 {
		return "", errors.New("session cookie unavailable")
	}
	return strings.Join(parts, "; "), nil
}
