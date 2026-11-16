package douyin

// msToken exchange.
//
// Chrome's login lifecycle uses two mssdk endpoints:
//   - POST /web/r/token?ms_appid=6383 seeds the initial ~164-byte token from a
//     compact nWID/wID strData report;
//   - POST /web/common rotates the token to a fresh ~172-byte value using the
//     full captured fingerprint (msgType=1) or a msgType=2 behavior heartbeat.

import (
	"context"
	_ "embed"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
)

const (
	msTokenURL  = "https://mssdk.bytedance.com/web/r/token?ms_appid=6383"
	msCommonURL = "https://mssdk.bytedance.com/web/common"
)

//go:embed profiles/mstoken_common_profile.json
var mstokenCommonProfileJSON []byte

// loadCommonProfile parses the embedded profile once on first use.
var loadCommonProfile = sync.OnceValues(func() (*jNode, error) {
	return parseOrderedJSON(mstokenCommonProfileJSON)
})

// mssdkHeaders builds the mssdk request headers.
func mssdkHeaders(storageAccess bool) Headers {
	prof := GetProfile()
	h := Headers{}
	h.Set("sec-ch-ua-platform", prof.SecCHUAPlatform)
	h.Set("referer", "https://www.douyin.com/")
	h.Set("user-agent", prof.UA)
	h.Set("sec-ch-ua", prof.SecCHUA)
	h.Set("content-type", "text/plain;charset=UTF-8")
	h.Set("sec-ch-ua-mobile", "?0")
	h.Set("accept", "*/*")
	h.Set("accept-language", "zh-CN,zh;q=0.9")
	h.Set("cache-control", "no-cache")
	h.Set("origin", "https://www.douyin.com")
	h.Set("pragma", "no-cache")
	h.Set("priority", "u=1, i")
	h.Set("sec-fetch-dest", "empty")
	h.Set("sec-fetch-mode", "cors")
	h.Set("sec-fetch-site", "cross-site")
	if storageAccess {
		h.Set("sec-fetch-storage-access", "active")
	}
	return h
}

var setCookieMsTokenRe = regexp.MustCompile(`msToken=([^;]+)`)

// extractMsToken reads the rotated token from the response header, then falls
// back to the Set-Cookie value.
func extractMsToken(resp *Response) string {
	if v := resp.HeaderGet("x-ms-token"); v != "" {
		return v
	}
	if sc := resp.HeaderGet("Set-Cookie"); sc != "" {
		if m := setCookieMsTokenRe.FindStringSubmatch(sc); m != nil {
			return m[1]
		}
	}
	for _, ck := range resp.Cookies {
		if ck.Name == "msToken" && ck.Value != "" {
			return ck.Value
		}
	}
	return ""
}

// mergeRuntimeCookies merges mssdk Set-Cookie values into the client jar.
func (c *Client) mergeRuntimeCookies(resp *Response) {
	for _, ck := range resp.Cookies {
		if ck.Name == "" || ck.Value == "" {
			continue
		}
		c.Cookie.Set(ck.Name, ck.Value)
	}
}

// cachedMsToken returns the still-fresh cached token, or "".
func (c *Client) cachedMsToken() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.msTokenReal && c.msToken != "" && time.Since(c.msTS) < msTokenTTL {
		return c.msToken
	}
	return ""
}

// RefreshMsToken refreshes the session token: with common=false it hits
// /web/r/token; with common=true it rotates through /web/common. The returned
// token is cached on the client and any Set-Cookie values are merged.
func (c *Client) RefreshMsToken(ctx context.Context, common, commonBehavior, sms bool) (string, error) {
	if common {
		return c.RefreshCommonMsToken(ctx, c.cachedMsToken(), commonBehavior, sms)
	}
	body, err := BuildMsTokenReportBody(6383, 6241, "", fixedCollectTime())
	if err != nil {
		return "", err
	}
	url := msTokenURL
	if cur := c.cachedMsToken(); cur != "" {
		url += "&msToken=" + queryEscapeStrict(cur)
	}
	resp, err := c.HTTP.Do(ctx, fhttp.MethodPost, url, mssdkHeaders(false), "", []byte(body))
	if err != nil {
		return "", err
	}
	c.mergeRuntimeCookies(resp)
	if tok := extractMsToken(resp); tok != "" {
		c.SetMsToken(tok)
		return tok, nil
	}
	return "", nil
}

// RefreshCommonMsToken performs the /web/common token rotation.
func (c *Client) RefreshCommonMsToken(ctx context.Context, current string, behavior, sms bool) (string, error) {
	var envelope string
	var err error
	if behavior {
		envelope, err = buildCommonBehaviorBody()
	} else {
		envelope, err = buildCommonReportBody(6383, 6241, "", fixedCollectTime(), sms)
	}
	if err != nil {
		return "", err
	}
	url := msCommonURL + "?ms_appid=6383"
	if current != "" {
		url += "&msToken=" + queryEscapeStrict(current)
	}
	resp, err := c.HTTP.Do(ctx, fhttp.MethodPost, url, mssdkHeaders(true), "", []byte(envelope))
	if err != nil {
		return "", err
	}
	c.mergeRuntimeCookies(resp)
	if tok := extractMsToken(resp); tok != "" {
		c.SetMsToken(tok)
		return tok, nil
	}
	return "", nil
}

// queryEscapeStrict percent-encodes every byte except the unreserved set.
func queryEscapeStrict(s string) string {
	const upperhex = "0123456789ABCDEF"
	var sb strings.Builder
	for i := range len(s) {
		ch := s[i]
		if ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' ||
			ch == '-' || ch == '_' || ch == '.' || ch == '~' {
			sb.WriteByte(ch)
			continue
		}
		sb.WriteByte('%')
		sb.WriteByte(upperhex[ch>>4])
		sb.WriteByte(upperhex[ch&15])
	}
	return sb.String()
}

func envInt(key string) (int, bool) {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return 0, false
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, false
	}
	return n, true
}

// buildCommonReportBody builds the /web/common report body.
func buildCommonReportBody(aid, pageID int, fixedUUID string, collectTime any, sms bool) (string, error) {
	root, err := loadCommonProfile()
	if err != nil {
		return "", err
	}
	profile := root.deepCopy()

	nowMS := time.Now().UnixMilli()
	if v, ok := os.LookupEnv("DY_MSTOKEN_FIXED_TIMESTAMP"); ok && v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			nowMS = n
		}
	}

	var ubCode *int
	if v, ok := envInt("DY_MSTOKEN_UB_CODE"); ok {
		ubCode = &v
	}
	if sms || ubCode != nil {
		uc := 12
		if ubCode != nil {
			uc = *ubCode
		}
		ubCode = &uc
		profile.set("ubCode", jInt(int64(uc)))
	}

	n, ok := profile.get("nWID")
	if !ok || n.kind != 'o' {
		n = jObj()
	} else {
		n = n.deepCopy()
	}
	if ubCode != nil {
		n.set("ubCode", jInt(int64(*ubCode)))
	}
	if canvas, ok := n.get("canvas"); ok && canvas.kind == 'o' {
		canvas.set("crc32", jStr(envOr("DY_MSTOKEN_CANVAS_CRC32", "175CB7A1")))
	}
	audioNode, _ := n.get("audio")
	if audioNode == nil || audioNode.kind != 'o' {
		audioNode = jObj()
		n.set("audio", audioNode)
	}
	acNode, _ := audioNode.get("audioContext")
	if acNode == nil || acNode.kind != 'o' {
		acNode = jObj()
		audioNode.set("audioContext", acNode)
	}
	acNode.set("state", jStr("running"))

	msVersion := "0.0.0.1"
	if mv, ok := n.get("ms_version"); ok && mv.kind == 's' && mv.str != "" {
		msVersion = mv.str
	}
	custom := jObj()
	if rc, ok := n.get("custom"); ok {
		switch rc.kind {
		case 's':
			if parsed, perr := parseOrderedJSON([]byte(rc.str)); perr == nil && parsed.kind == 'o' {
				custom = parsed
			}
		case 'o':
			custom = rc.deepCopy()
		}
	}
	custom.setDefault("version", jStr(msVersion))
	custom.setDefault("fxgDid", jStr(""))
	if fixedUUID == "" {
		fixedUUID = envOr("DY_MSTOKEN_FIXED_UUID", randomUUIDv4())
	}
	custom.set("uuid", jStr(fixedUUID))
	if collectTime == nil {
		if sms {
			collectTime = 23.799999952316284
		} else {
			collectTime = int64(10 + randIntN(90))
		}
	}
	custom.set("collectTime", numFromValue(collectTime))
	n.del("ms_version")
	n.set("custom", jStr(custom.stringCompact()))
	n.set("ms_version", jStr(msVersion))

	wid, ok := profile.get("wID")
	if !ok || wid.kind != 'o' {
		wid = jObj()
	}
	wid.set("msgType", jInt(1))
	wid.set("timestamp", jStr(strconv.FormatInt(nowMS, 10)))
	wid.set("aid", jInt(int64(aid)))
	wid.set("pageId", jInt(int64(pageID)))
	wid.set("nap", jStr(envOr("DY_MSTOKEN_FIXED_NAP", "11311144242322244122")))

	prof := GetProfile()
	g := prof.Geo
	if nav, ok := profile.get("navigator"); ok && nav.kind == 'o' {
		nav.set("appVersion", jStr(strings.Replace(prof.UA, "Mozilla/", "", 1)))
		nav.set("deviceMemory", jStr(prof.DeviceMemory))
		nav.set("hardwareConcurrency", jInt(int64(atoiOr(prof.CpuCoreNum, 0))))
	}
	if webgl, ok := profile.get("webgl"); ok && webgl.kind == 'o' {
		webgl.set("renderer", jStr(prof.WebGLRenderer))
		webgl.set("vendor", jStr(prof.WebGLVendor))
	}
	if nNav, ok := n.get("navigator"); ok && nNav.kind == 'o' {
		nNav.set("userAgent", jStr(prof.UA))
		nNav.set("hardwareConcurrency", jInt(int64(atoiOr(prof.CpuCoreNum, 0))))
	}
	if nScreen, ok := n.get("screen"); ok && nScreen.kind == 'o' {
		nScreen.set("height", jInt(int64(atoiOr(prof.ScreenHeight, 0))))
		nScreen.set("width", jInt(int64(atoiOr(prof.ScreenWidth, 0))))
		nScreen.set("availHeight", jInt(int64(g[5])))
		nScreen.set("availWidth", jInt(int64(g[4])))
		nScreen.set("availTop", jInt(0))
		nScreen.set("availLeft", jInt(0))
	}
	if nWebgl, ok := n.get("webgl"); ok && nWebgl.kind == 'o' {
		nWebgl.set("renderer", jStr(prof.WebGLRenderer))
		nWebgl.set("vendor", jStr(prof.WebGLVendor))
	}
	if screen, ok := profile.get("screen"); ok && screen.kind == 'o' {
		screen.set("innerWidth", jInt(int64(g[0])))
		screen.set("innerHeight", jInt(int64(g[1])))
		screen.set("outerWidth", jInt(int64(g[2])))
		screen.set("outerHeight", jInt(int64(g[3])))
		screen.set("screenX", jInt(int64(prof.ScreenX)))
		screen.set("screenY", jInt(int64(prof.ScreenY)))
		screen.set("availWidth", jInt(int64(g[4])))
		screen.set("availHeight", jInt(int64(g[5])))
		screen.set("sizeWidth", jInt(int64(g[6])))
		screen.set("sizeHeight", jInt(int64(g[7])))
		screen.set("clientWidth", jInt(int64(g[0])))
		screen.set("clientHeight", jInt(int64(g[1])))
	}
	profile.set("nWID", n)
	profile.set("wID", wid)

	plaintext := profile.stringCompact()
	nonce := byte(randIntN(256))
	if v, ok := envInt("DY_MSTOKEN_FIXED_NONCE"); ok {
		nonce = byte(v)
	}
	tsp := nowMS + 10
	if sms {
		tsp = nowMS + 11
	}
	if v, ok := os.LookupEnv("DY_MSTOKEN_FIXED_TSP"); ok && v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			tsp = n
		}
	}
	return mstokenEnvelope(EncodeStrData([]byte(plaintext), nonce), tsp), nil
}

// buildCommonBehaviorBody builds the /web/common behavior report body.
func buildCommonBehaviorBody() (string, error) {
	nowMS := time.Now().UnixMilli()
	if v, ok := os.LookupEnv("DY_MSTOKEN_FIXED_TIMESTAMP"); ok && v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			nowMS = n
		}
	}
	prof := GetProfile()
	g := prof.Geo

	plaintext := jObj()
	wid := jObj()
	wid.set("msgType", jInt(2))
	wid.set("privacyMode", jInt(0))
	wid.set("timestamp", jStr(strconv.FormatInt(nowMS, 10)))
	plaintext.set("wID", wid)
	behavior := jObj()
	behavior.set("beMove", jArr())
	behavior.set("beClick", jArr())
	behavior.set("beClickEnd", jArr())
	behavior.set("beKeyboard", jArr())
	behavior.set("windowState", jArr())
	behavior.set("gyro", jArr())
	behavior.set("focus", jArr())
	screen := jObj()
	screen.set("innerWidth", jInt(int64(g[0])))
	screen.set("innerHeight", jInt(int64(g[1])))
	screen.set("outerWidth", jInt(int64(g[2])))
	screen.set("outerHeight", jInt(int64(g[3])))
	screen.set("screenX", jInt(int64(prof.ScreenX)))
	screen.set("screenY", jInt(int64(prof.ScreenY)))
	screen.set("pageXOffset", jInt(0))
	screen.set("pageYOffset", jInt(0))
	screen.set("availWidth", jInt(int64(g[4])))
	screen.set("availHeight", jInt(int64(g[5])))
	screen.set("sizeWidth", jInt(int64(g[6])))
	screen.set("sizeHeight", jInt(int64(g[7])))
	screen.set("clientWidth", jInt(int64(g[0])))
	screen.set("clientHeight", jInt(int64(g[1])))
	screen.set("colorDepth", jInt(24))
	screen.set("pixelDepth", jInt(24))
	screen.set("orientaionType", jStr("landscape-primary"))
	screen.set("orientaionAngle", jInt(0))
	behavior.set("screen", screen)
	plaintext.set("behavior", behavior)

	nonce := byte(randIntN(256))
	if v, ok := envInt("DY_MSTOKEN_FIXED_NONCE"); ok {
		nonce = byte(v)
	}
	tsp := nowMS + 3
	if v, ok := os.LookupEnv("DY_MSTOKEN_FIXED_TSP"); ok && v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			tsp = n
		}
	}
	return mstokenEnvelope(EncodeStrData([]byte(plaintext.stringCompact()), nonce), tsp), nil
}

func atoiOr(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}
