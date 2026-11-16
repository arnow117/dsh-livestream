package douyin

// Small helpers.

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"math/rand/v2"
	"os"
	"regexp"
	"strings"
	"time"
)

func randFloat() float64 { return rand.Float64() }

// Cookies is an ordered cookie mapping that also preserves Chromium's rare
// no-equals ("bare") tokens exactly as captured.
type Cookies struct {
	keys      []string
	values    map[string]string
	rawTokens []string
}

// NewCookies returns an empty cookie map.
func NewCookies() *Cookies {
	return &Cookies{values: map[string]string{}}
}

// Set assigns a cookie value.
func (c *Cookies) Set(name, value string) {
	if _, ok := c.values[name]; !ok {
		c.keys = append(c.keys, name)
	}
	c.values[name] = value
}

// Get returns a cookie value.
func (c *Cookies) Get(name string) string { return c.values[name] }

// Has reports whether a cookie exists.
func (c *Cookies) Has(name string) bool {
	_, ok := c.values[name]
	return ok
}

// Del removes a cookie.
func (c *Cookies) Del(name string) {
	if _, ok := c.values[name]; !ok {
		return
	}
	delete(c.values, name)
	for i, k := range c.keys {
		if k == name {
			c.keys = append(c.keys[:i], c.keys[i+1:]...)
			break
		}
	}
}

// Names returns the ordered cookie names.
func (c *Cookies) Names() []string { return c.keys }

// String serializes to a Cookie header value.
func (c *Cookies) String() string {
	raw := map[string]bool{}
	for _, t := range c.rawTokens {
		raw[t] = true
	}
	parts := make([]string, 0, len(c.keys)+len(c.rawTokens))
	for _, name := range c.keys {
		if raw[name] {
			parts = append(parts, name)
			continue
		}
		parts = append(parts, name+"="+c.values[name])
	}
	for _, t := range c.rawTokens {
		if !c.Has(t) {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, "; ")
}

// MergeSetCookies records Set-Cookie responses into the mapping.
func (c *Cookies) MergeSetCookies(vals map[string]string) {
	for k, v := range vals {
		if v == "" {
			continue
		}
		c.Set(k, v)
	}
}

// TransCookies parses a Cookie header value into a Cookies mapping.
// Empty fragments are skipped; bare tokens are preserved on the sidecar.
func TransCookies(cookieStr string) *Cookies {
	res := NewCookies()
	for item := range strings.SplitSeq(cookieStr, ";") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		name, value, found := strings.Cut(item, "=")
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if !found {
			res.rawTokens = append(res.rawTokens, name)
			continue
		}
		res.Set(name, value)
	}
	return res
}

// MD5Hex returns the lowercase hex MD5 of s.
func MD5Hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

const svWebIDCharset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// GenerateSVWebID produces a verify_<ts36>_<uuid-ish> s_v_web_id.
func GenerateSVWebID() string {
	if fixed := os.Getenv("DY_FIXED_SV_WEB_ID"); fixed != "" {
		return fixed
	}
	if fixed := os.Getenv("DY_FIXED_WEB_ID"); fixed != "" {
		return fixed
	}
	n := time.Now().UnixMilli()
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	ts36 := ""
	for n > 0 {
		ts36 = string(digits[n%36]) + ts36
		n /= 36
	}
	rnd := func(k int) string {
		var sb strings.Builder
		for range k {
			sb.WriteByte(svWebIDCharset[rand.IntN(len(svWebIDCharset))])
		}
		return sb.String()
	}
	groups := []string{rnd(8), rnd(4), "4" + rnd(3), string("89ab"[rand.IntN(4)]) + rnd(3), rnd(12)}
	return "verify_" + ts36 + "_" + strings.Join(groups, "_")
}

// GenerateMsToken returns a random 107-char msToken (fallback when the
// dynamic mssdk exchange is unavailable).
func GenerateMsToken() string {
	const base = "ABCDEFGHIGKLMNOPQRSTUVWXYZabcdefghigklmnopqrstuvwxyz0123456789="
	var sb strings.Builder
	for range 107 {
		sb.WriteByte(base[rand.IntN(len(base))])
	}
	return sb.String()
}

// GenerateFakeWebID returns a random 19-digit numeric webid.
func GenerateFakeWebID() string {
	var sb strings.Builder
	for range 19 {
		sb.WriteByte(byte('0' + rand.IntN(10)))
	}
	return sb.String()
}

// GenerateMillisecond returns the current epoch time in milliseconds.
func GenerateMillisecond() int64 { return time.Now().UnixMilli() }

// ParseAwemeID extracts an aweme_id and the canonical /video/ referer from a
// work URL (supports /video/, /note/, /slides/ and modal_id=). A bare numeric
// id is accepted as a convenience for API/MCP callers.
func ParseAwemeID(url string) (string, string, error) {
	trimmed := strings.TrimSpace(url)
	if trimmed != "" && isAllDigits(trimmed) {
		return trimmed, "https://www.douyin.com/video/" + trimmed, nil
	}
	awemeID := ""
	if m := regexpAwemePath.FindStringSubmatch(url); m != nil {
		awemeID = m[1]
	} else if m := regexpModalID.FindStringSubmatch(url); m != nil {
		awemeID = m[1]
	}
	if awemeID == "" {
		return "", "", fmt.Errorf("无法从链接中解析 aweme_id: %s", url)
	}
	return awemeID, "https://www.douyin.com/video/" + awemeID, nil
}

func isAllDigits(s string) bool {
	for i := range len(s) {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

var (
	regexpAwemePath = regexp.MustCompile(`/(?:video|note|slides)/(\d+)`)
	regexpModalID   = regexp.MustCompile(`modal_id=(\d+)`)
)
