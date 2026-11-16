package douyin

// x-secsdk-web-signature.
// A subset of www.douyin.com GET/POST APIs reject unsigned queries.

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const webSignConst = "A96D855A08C0A9707F8BEF0D9A527E4E"

var protectedPathsGet = map[string]bool{
	"/aweme/v1/web/aweme/detail/":         true,
	"/aweme/v1/web/aweme/post/":           true,
	"/aweme/v1/web/aweme/favorite/":       true,
	"/aweme/v1/web/aweme/listcollection/": true,
	"/aweme/v1/web/mix/aweme/":            true,
	"/aweme/v1/web/tab/feed/":             true,
	"/aweme/v1/web/mix/list/":             true,
	"/aweme/v1/web/music/aweme/":          true,
	"/aweme/v1/web/music/list/":           true,
	"/aweme/v1/web/mix/detail/":           true,
	"/aweme/v1/web/mix/listcollection/":   true,
	"/aweme/v1/web/music/detail/":         true,
	"/aweme/v1/web/collects/list/":        true,
	"/aweme/v1/web/collects/video/list/":  true,
}

var protectedPathsPost = map[string]bool{
	"/aweme/v1/web/aweme/detail/":         true,
	"/aweme/v1/web/aweme/post/":           true,
	"/aweme/v1/web/aweme/favorite/":       true,
	"/aweme/v1/web/aweme/listcollection/": true,
	"/aweme/v1/web/mix/aweme/":            true,
	"/aweme/v1/web/tab/feed/":             true,
}

// IsProtectedPath reports whether an API path requires web-signature signing.
func IsProtectedPath(path, method string) bool {
	if strings.EqualFold(method, "POST") {
		return protectedPathsPost[path]
	}
	return protectedPathsGet[path]
}

// encodeComponent mirrors JS encodeURIComponent for the characters that
// appear in Douyin queries.
func encodeComponent(v string) string {
	return quoteComponent(v)
}

func quoteComponent(s string) string {
	const upperhex = "0123456789ABCDEF"
	var sb strings.Builder
	for i := range len(s) {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
			c == '-' || c == '_' || c == '.' || c == '~' || c == '!' || c == '*' ||
			c == '\'' || c == '(' || c == ')' {
			sb.WriteByte(c)
			continue
		}
		sb.WriteByte('%')
		sb.WriteByte(upperhex[c>>4])
		sb.WriteByte(upperhex[c&15])
	}
	return sb.String()
}

// CanonicalQuery normalizes a query per the SDK rules (order preserved, values
// decoded then re-encoded, keys decoded only).
func CanonicalQuery(query string) string {
	parts := make([]string, 0)
	for pair := range strings.SplitSeq(query, "&") {
		if pair == "" {
			continue
		}
		key, value, found := strings.Cut(pair, "=")
		if !found {
			value = ""
		}
		key = decodePlus(key)
		value = decodePlus(value)
		parts = append(parts, key+"="+encodeComponent(value))
	}
	return strings.Join(parts, "&")
}

func decodePlus(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	out, err := url.QueryUnescape(s)
	if err != nil {
		return s
	}
	return out
}

func splitSigned(url string) (string, string) {
	base, query, found := strings.Cut(url, "?")
	if !found {
		return base, ""
	}
	kept := make([]string, 0)
	for pair := range strings.SplitSeq(query, "&") {
		if pair == "" {
			continue
		}
		name, _, _ := strings.Cut(pair, "=")
		if name == "timestamp" || name == "x-secsdk-web-signature" {
			continue
		}
		kept = append(kept, pair)
	}
	return base, strings.Join(kept, "&")
}

// SignWeb returns (ts, signature, signedQuery) for a URL.
func SignWeb(rawURL string, ts int64, uifid string) (int64, string, string) {
	if ts == 0 {
		ts = time.Now().Unix()
	}
	_, rawQuery := splitSigned(rawURL)
	canon := CanonicalQuery(rawQuery)

	hasUifid := false
	for pair := range strings.SplitSeq(canon, "&") {
		if pair == "" {
			continue
		}
		if strings.HasPrefix(pair, "uifid=") {
			hasUifid = true
			break
		}
	}
	if !hasUifid && uifid != "" {
		if canon != "" {
			canon = canon + "&uifid=" + encodeComponent(uifid)
		} else {
			canon = "uifid=" + encodeComponent(uifid)
		}
	}
	var signedQuery string
	if canon != "" {
		signedQuery = fmt.Sprintf("%s&timestamp=%d", canon, ts)
	} else {
		signedQuery = fmt.Sprintf("timestamp=%d", ts)
	}

	uifidValue := ""
	for pair := range strings.SplitSeq(signedQuery, "&") {
		if v, ok := strings.CutPrefix(pair, "uifid="); ok {
			uifidValue = decodePlus(v)
			break
		}
	}
	if uifidValue == "" {
		uifidValue = uifid
	}
	plain := fmt.Sprintf("%s_%d_%s_%s", uifidValue, ts, webSignConst, signedQuery)
	sum := md5.Sum([]byte(plain))
	return ts, hex.EncodeToString(sum[:]), signedQuery
}

// SignWebURL returns the fully signed URL that must be sent verbatim.
func SignWebURL(rawURL string, ts int64, uifid string) string {
	base, _ := splitSigned(rawURL)
	ts, sig, signedQuery := SignWeb(rawURL, ts, uifid)
	return fmt.Sprintf("%s?%s&x-secsdk-web-signature=%s", base, signedQuery, sig)
}
