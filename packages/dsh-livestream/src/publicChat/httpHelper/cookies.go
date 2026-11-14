package main

import (
	"errors"
	"net/http"
	"sort"
	"strings"
)

// cookieMaterial includes the scope evidence required before a header can be
// used. A plain name/value header is deliberately not an acceptable input.
type cookieMaterial struct {
	Name        string `json:"name"`
	Value       string `json:"value"`
	Domain      string `json:"domain"`
	Path        string `json:"path"`
	Secure      *bool  `json:"secure"`
	HTTPOnly    *bool  `json:"httpOnly"`
	SameSite    string `json:"sameSite"`
	ExpiresAtMs int64  `json:"expiresAtMs"`
	HostOnly    *bool  `json:"hostOnly"`
	Partitioned *bool  `json:"partitioned"`
}

// frozenCookies owns a copy of its input. No caller can replace or append to
// the retained slice, and responses are never applied to this representation.
type frozenCookies struct {
	entries []cookieMaterial
	header  string
}

// validAt must be checked at qualification and on every write boundary, not
// just when the source material is installed.
func (c *frozenCookies) validAt(nowMs int64) bool {
	if c == nil || nowMs <= 0 || len(c.entries) == 0 {
		return false
	}
	for _, entry := range c.entries {
		if entry.ExpiresAtMs <= nowMs {
			return false
		}
	}
	return true
}

func freezeCookies(input []cookieMaterial, nowMs int64) (*frozenCookies, error) {
	if nowMs <= 0 || len(input) == 0 || len(input) > 128 {
		return nil, errors.New("invalid cookie material")
	}
	entries := append([]cookieMaterial(nil), input...)
	seen := make(map[string]struct{}, len(entries))
	for _, item := range entries {
		if item.Domain != ".douyin.com" || item.Path != "/" || item.Secure == nil || !*item.Secure ||
			item.HTTPOnly == nil || item.HostOnly == nil || *item.HostOnly ||
			item.Partitioned == nil || *item.Partitioned || item.ExpiresAtMs <= nowMs ||
			(item.SameSite != "Strict" && item.SameSite != "Lax" && item.SameSite != "None") {
			return nil, errors.New("invalid cookie scope")
		}
		if len(item.Name) > 256 || len(item.Value) > 4096 || strings.ContainsAny(item.Value, ";,\"\\") {
			return nil, errors.New("invalid cookie value")
		}
		cookie := &http.Cookie{Name: item.Name, Value: item.Value}
		if err := cookie.Valid(); err != nil {
			return nil, errors.New("invalid cookie value")
		}
		if _, exists := seen[item.Name]; exists {
			return nil, errors.New("duplicate cookie name")
		}
		seen[item.Name] = struct{}{}
	}
	for i := range entries {
		secure, httpOnly := *entries[i].Secure, *entries[i].HTTPOnly
		hostOnly, partitioned := *entries[i].HostOnly, *entries[i].Partitioned
		entries[i].Secure, entries[i].HTTPOnly = &secure, &httpOnly
		entries[i].HostOnly, entries[i].Partitioned = &hostOnly, &partitioned
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	parts := make([]string, len(entries))
	for i, item := range entries {
		parts[i] = item.Name + "=" + item.Value
	}
	header := strings.Join(parts, "; ")
	if len(header) > 16384 {
		return nil, errors.New("cookie material exceeds limit")
	}
	return &frozenCookies{entries: entries, header: header}, nil
}
