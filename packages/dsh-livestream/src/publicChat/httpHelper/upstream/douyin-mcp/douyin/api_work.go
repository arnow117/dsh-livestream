package douyin

// Works (video detail) plus the shared helpers the web API files use.
//
// Every request mirrors the browser's URL, parameter order, headers and
// signing exactly; parameters marked as load-bearing are reproduced verbatim.

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// --- shared helpers --------------------------------------------------------

// duUserID extracts the trailing path segment of a user URL, dropping any
// query string.
func duUserID(userURL string) string {
	s := userURL
	if i := strings.LastIndex(s, "/"); i >= 0 {
		s = s[i+1:]
	}
	if before, _, ok := strings.Cut(s, "?"); ok {
		s = before
	}
	return s
}

// duUserURL expands a bare sec_user_id (or 抖音号) into the canonical profile
// URL. Endpoints that take a user identifier use it for the Referer header
// (and the webid bootstrap page), and Douyin answers a non-URL Referer with
// `{"status_code":0,"status_msg":"blocked","user":{}}` — so callers may pass
// either a URL or a bare id, but the request must always carry the URL form.
func duUserURL(user string) string {
	if strings.HasPrefix(user, "http://") || strings.HasPrefix(user, "https://") {
		return user
	}
	return douyinBase + "/user/" + duUserID(user)
}

// duStr renders a decoded JSON scalar for the identifier fields we hand back
// into queries.
func duStr(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return ""
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case bool:
		if t {
			return "true"
		}
		return "false"
	}
	return ""
}

// duSlice returns v as []any, or nil.
func duSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

// duMap returns v as map[string]any, or nil.
func duMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// duHasMore reports whether res["has_more"] == 1 (JSON numbers decode as
// float64 in Go).
func duHasMore(res map[string]any) bool {
	return toInt64(res["has_more"]) == 1
}

// duQuote mirrors urllib.parse.quote(s) with its default safe='/'.
func duQuote(s string) string {
	const upperhex = "0123456789ABCDEF"
	var sb strings.Builder
	for i := range len(s) {
		ch := s[i]
		if ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' ||
			ch == '-' || ch == '_' || ch == '.' || ch == '~' || ch == '/' {
			sb.WriteByte(ch)
			continue
		}
		sb.WriteByte('%')
		sb.WriteByte(upperhex[ch>>4])
		sb.WriteByte(upperhex[ch&15])
	}
	return sb.String()
}

// duUUID4 returns a random UUID-v4 for the search referer `aid` value.
func duUUID4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// duGetJSON performs a GET whose query is form-urlencoded (quote_plus). These
// endpoints are never sent through signed_url(), so the query is re-encoded on
// the wire even though a_bogus was computed over the splice_url form.
func (c *Client) duGetJSON(ctx context.Context, base string, p *Params, h Headers) (map[string]any, error) {
	send := func() (*Response, error) {
		return c.HTTP.Get(ctx, BuildURL(base, standardEncodeQuery(p)), h, c.CookieStr())
	}
	resp, err := send()
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		resp, err = c.acRetry(ctx, resp, send)
		if err != nil {
			return nil, err
		}
		c.absorbCookies(resp)
		if err := CheckRisk(resp); err != nil {
			return nil, err
		}
	}
	return decodeJSONObject(resp.Body)
}

// duPostFormJSON performs a form POST with a form-urlencoded body, then
// CheckRisk + decode.
func (c *Client) duPostFormJSON(ctx context.Context, base string, p *Params, h Headers, body *Params) (map[string]any, error) {
	encoded := ""
	if body != nil && body.Len() > 0 {
		encoded = standardEncodeQuery(body)
	}
	resp, err := c.HTTP.PostJSON(ctx, BuildURL(base, standardEncodeQuery(p)), h, c.CookieStr(), "", []byte(encoded))
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	return decodeJSONObject(resp.Body)
}

// duCompactJSON renders compact JSON (no spaces, unescaped non-ASCII) for the
// `text_extra` body field.
func duCompactJSON(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "[]"
	}
	return strings.TrimRight(sb.String(), "\n")
}

// --- work detail -----------------------------------------------------------

// GetWorkInfo returns a work's detail (`/aweme/v1/web/aweme/detail/`).
func (c *Client) GetWorkInfo(ctx context.Context, workURL string) (map[string]any, error) {
	const api = "/aweme/v1/web/aweme/detail/"
	awemeID, refer, err := ParseAwemeID(workURL)
	if err != nil {
		return nil, err
	}
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("aweme_id", awemeID)
	// 实录里 aweme_id 之后紧跟这两个，缺了会少字段.
	p.Add("request_source", "600")
	p.Add("origin_type", "video_page")
	// 公共组与浏览器同源接口一致；version_code 必须回到 190500/19.5.0.
	p.WithPlatform("50", "190500", "19.5.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	// aweme/detail 的 verifyFp/fp 在 msToken **之前**.
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	// 该接口在 secsdk webSign 策略表里，末尾还要带 timestamp + 签名.
	return c.GetJSONSigned(ctx, douyinBase+api, p, headers)
}
