package douyin

// Douyin web login (QR + phone/SMS).
//
// Pure HTTP, no browser: the session bootstraps its own anonymous cookies and
// P-256 ticket-guard key, runs www/ttwid -> login_guiding_strategy -> get_sec_ts
// -> login/ttwid/check -> challenge, then either polls a QR code or sends an
// SMS code through /passport/web/send_code/ and /passport/web/sms_login/.
//
// Signatures generated locally: a_bogus, X-Bogus, x-secsdk-web-signature,
// bd-ticket-guard (ECDH/HKDF/ECDSA/HMAC), x-tt-session-dtrait, mssdk msToken,
// fpk2 (MD5 of the UA) and fpk1 (FingerprintJS digest + AES from the captured
// device profile). Known gap: __ac_signature needs the page acrawler VMP and
// must be supplied via DY_AC_SIGNATURE / DY_AC_NONCE when a challenge appears.

import (
	"context"
	"crypto/hmac"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
)

const (
	loginBase   = "https://login.douyin.com"
	passportAPI = loginBase + "/passport/web/"
	homeBase    = "https://www.douyin.com"

	passportAppKey = "163e7ce78d58971a41f5b969996d85c2"
	// qrPollInterval mirrors the browser's measured 5.14s inter-POST cadence.
	qrPollInterval = 5200 * time.Millisecond
	qrTTL          = 55 * time.Second
	throttleGiveUp = 120 * time.Second
)

var passportSDKHead = [][2]string{
	{"passport_jssdk_version", "3.4.4"},
	{"passport_jssdk_type", "normal"},
	{"is_from_ttaccountsdk", "1"},
}

var passportSDKTail = map[string]string{
	"p_ui": "2.4.4", "p_ca": "4.0.26", "p_ca_real": "1.0.0.892",
	"account_sdk_source": "web", "p_js_v": "3.4.4", "p_js_t": "pro",
	"p_zt": "3.3.17", "p_ver": "1.1.3", "p_ver_real": "0",
	"p_bd": "1.0.1.19-fix.01",
}

var wwwOnlyCookies = map[string]bool{
	"s_v_web_id": true, "__ac_nonce": true, "__ac_signature": true,
	"x-web-secsdk-uid": true, "dy_swidth": true, "dy_sheight": true,
	"device_web_cpu_core": true, "device_web_memory_size": true,
	"architecture": true, "fpk1": true, "fpk2": true,
}

// Cookie serialization orders, taken from a live Chrome capture.
// Order is part of the wire fingerprint.
var challengeOrder = []string{
	"enter_pc_once", "UIFID_TEMP", "is_support_rtm_web_ts", "hevc_supported",
	"stream_recommend_feed_params", "odin_tt", "home_can_add_dy_2_desktop",
	"IsDouyinActive", "strategyABtestKey",
	"passport_csrf_token", "passport_csrf_token_default", "ttwid",
	"biz_trace_id",
}

var ttwidOrder = []string{
	"enter_pc_once", "UIFID_TEMP", "odin_tt", "is_support_rtm_web_ts",
	"hevc_supported", "IsDouyinActive", "home_can_add_dy_2_desktop",
	"stream_recommend_feed_params", "strategyABtestKey", "ttwid",
	"is_dash_user", "biz_trace_id", "passport_csrf_token",
	"passport_csrf_token_default",
}

var wwwTtwidOrder = []string{
	"__ac_nonce", "__ac_signature", "ttwid", "enter_pc_once", "UIFID_TEMP",
	"x-web-secsdk-uid", "s_v_web_id", "odin_tt", "douyin.com",
	"device_web_cpu_core", "device_web_memory_size", "architecture",
	"is_support_rtm_web_ts", "hevc_supported", "IsDouyinActive",
	"home_can_add_dy_2_desktop", "dy_swidth", "dy_sheight",
	"stream_recommend_feed_params", "strategyABtestKey",
}

var wwwGuidingOrder = []string{
	"__ac_nonce", "__ac_signature", "enter_pc_once", "UIFID_TEMP",
	"x-web-secsdk-uid", "s_v_web_id", "odin_tt", "douyin.com",
	"device_web_cpu_core", "device_web_memory_size", "architecture",
	"is_support_rtm_web_ts", "hevc_supported", "IsDouyinActive",
	"home_can_add_dy_2_desktop", "dy_swidth", "dy_sheight",
	"stream_recommend_feed_params", "strategyABtestKey", "ttwid",
	"is_dash_user", "biz_trace_id",
}

var wwwBootstrapOrder = []string{
	"__ac_nonce", "__ac_signature", "enter_pc_once", "UIFID_TEMP",
	"x-web-secsdk-uid", "s_v_web_id", "odin_tt", "douyin.com",
	"device_web_cpu_core", "device_web_memory_size", "architecture",
	"is_support_rtm_web_ts", "hevc_supported", "IsDouyinActive",
	"home_can_add_dy_2_desktop", "dy_swidth", "dy_sheight",
	"stream_recommend_feed_params", "strategyABtestKey", "ttwid",
	"is_dash_user", "biz_trace_id", "passport_csrf_token",
	"passport_csrf_token_default",
}

var qrOrder = []string{
	"enter_pc_once", "UIFID_TEMP", "odin_tt", "is_support_rtm_web_ts",
	"hevc_supported", "IsDouyinActive", "home_can_add_dy_2_desktop",
	"stream_recommend_feed_params", "strategyABtestKey", "is_dash_user",
	"passport_csrf_token", "passport_csrf_token_default", "ttwid", "biz_trace_id",
	"__security_mc_1_s_sdk_crypt_sdk", "bd_ticket_guard_regenerate_keys_time",
	"bd_ticket_guard_client_data", "bd_ticket_guard_client_web_domain",
	"bd_ticket_guard_client_data_v2", "sdk_source_info", "bit_env",
	"gulu_source_res", "passport_auth_mix_state",
}

var smsCurrentOrder = []string{
	"enter_pc_once", "UIFID_TEMP", "odin_tt", "is_support_rtm_web_ts",
	"hevc_supported", "IsDouyinActive", "home_can_add_dy_2_desktop",
	"stream_recommend_feed_params", "strategyABtestKey", "is_dash_user",
	"passport_csrf_token", "passport_csrf_token_default", "ttwid",
	"biz_trace_id", "__security_mc_1_s_sdk_crypt_sdk",
	"bd_ticket_guard_regenerate_keys_time", "bd_ticket_guard_client_data",
	"bd_ticket_guard_client_web_domain", "bd_ticket_guard_client_data_v2",
	"sdk_source_info", "bit_env", "gulu_source_res",
	"passport_auth_mix_state",
}

// ---------------------------------------------------------------------------
// per-client login session state
// ---------------------------------------------------------------------------

type loginState struct {
	mu             sync.Mutex
	verifyPortrait string
	tSuffix        string
	tQuery         string
	tCookie        string
	sdkSourceInfo  string
	secTS          string
	msPinned       bool
	smsSentAt      time.Time
	mobileTicket   string
	qrRefreshReady bool
	bootstrapped   bool
}

func (c *Client) loginState() *loginState {
	c.loginStateMu.Lock()
	defer c.loginStateMu.Unlock()
	if c.loginSession == nil {
		c.loginSession = &loginState{}
	}
	return c.loginSession
}

// HasLoginMaterials reports whether a client holds a complete logged-in
// credential set (ticket + private key + a session cookie).
func HasLoginMaterials(c *Client) bool {
	if c == nil {
		return false
	}
	if c.Ticket == "" || c.PrivateKey == "" {
		return false
	}
	return c.Cookie.Get("sessionid") != "" || c.Cookie.Get("sessionid_ss") != ""
}

// ImportWebProtect loads ticket / ts_sign / client_cert (from the login
// response's perepare_auth payload) and the EC private key onto the client.
//
// The web_protect payload is double JSON-encoded: its "data" field is itself
// a JSON string.
func (c *Client) ImportWebProtect(webProtect, keys string) error {
	if webProtect != "" {
		var outer struct {
			Data string `json:"data"`
		}
		if err := json.Unmarshal([]byte(webProtect), &outer); err != nil {
			return fmt.Errorf("解析 web_protect 外层失败: %w", err)
		}
		var inner struct {
			Ticket     string `json:"ticket"`
			TsSign     string `json:"ts_sign"`
			ClientCert string `json:"client_cert"`
		}
		if err := json.Unmarshal([]byte(outer.Data), &inner); err != nil {
			return fmt.Errorf("解析 web_protect 内层失败: %w", err)
		}
		c.Ticket = inner.Ticket
		c.TsSign = inner.TsSign
		c.ClientCert = inner.ClientCert
	}
	if keys != "" {
		var outer struct {
			Data string `json:"data"`
		}
		if err := json.Unmarshal([]byte(keys), &outer); err != nil {
			return fmt.Errorf("解析 keys 外层失败: %w", err)
		}
		var inner struct {
			ECPrivateKey string `json:"ec_privateKey"`
		}
		if err := json.Unmarshal([]byte(outer.Data), &inner); err != nil {
			return fmt.Errorf("解析 keys 内层失败: %w", err)
		}
		c.PrivateKey = inner.ECPrivateKey
	}
	return nil
}

// CaptureTicketGuard performs the bd-ticket-guard get_client_cert exchange and,
// when a sec_ts has already been harvested, refreshes
// bd_ticket_guard_client_data_v2 on the session.
func (c *Client) CaptureTicketGuard(ctx context.Context) error {
	if c.PrivateKey == "" {
		return fmt.Errorf("capture ticket guard 需要 EC private key")
	}
	if c.Cookie.Get("bd_ticket_guard_client_data") == "" {
		c.dshSetGeneratedCookie("bd_ticket_guard_client_data", BuildClientDataCookie(c.PrivateKey))
		c.dshSetGeneratedCookie("bd_ticket_guard_client_web_domain", "2")
	}
	cert, _, err := c.FetchServerCert(ctx, 6383, homeBase)
	if err != nil {
		return err
	}
	st := c.loginState()
	if st.secTS != "" {
		return c.addClientDataV2(ctx, cert)
	}
	return nil
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := crand.Read(b); err != nil {
		for i := range b {
			b[i] = byte(time.Now().UnixNano() >> (i % 8 * 8))
		}
	}
	return hex.EncodeToString(b)
}

func hmacSHABytes(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}

func asString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%v", t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	}
	return ""
}

func generatePassportAuthMixState(length int) string {
	const alphabet = "1234567890qwertyuiopasdfghjklzxcvbnm"
	var sb strings.Builder
	for range length {
		sb.WriteByte(alphabet[randIntN(len(alphabet))])
	}
	return sb.String()
}

// sdkTS returns the passport `ts`: today's UTC 12:00 in seconds.
func sdkTS() string {
	now := time.Now().UTC()
	noon := time.Date(now.Year(), now.Month(), now.Day(), 12, 0, 0, 0, time.UTC)
	return fmt.Sprintf("%d", noon.Unix())
}

// aidSign reproduces login_api._aid_sign.
func aidSign(path, ts, aid string) string {
	prk := hmacSHABytes([]byte(ts), []byte(passportAppKey))
	okm := hmacSHABytes(prk, []byte{0x01})
	msg := fmt.Sprintf("aid=%s&path=%s&ts=%s", aid, path, ts)
	return hex.EncodeToString(hmacSHABytes(okm, []byte(msg)))
}

// passportSign reproduces login_api._passport_sign.
func passportSign(query *Params, data *Params) (string, string) {
	signable := map[string]string{}
	for _, k := range query.Keys() {
		if k == "sign" || k == "qs" || k == "msToken" || k == "a_bogus" {
			continue
		}
		v, _ := query.Get(k)
		signable[k] = v
	}
	keys := slices.Sorted(maps.Keys(signable))
	if len(keys) > 10 {
		keys = keys[:10]
	}
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+signable[k])
	}
	qstr := strings.Join(parts, "&")
	var bstr string
	if data != nil && data.Len() > 0 {
		bk := slices.Sorted(slices.Values(data.Keys()))
		bp := make([]string, 0, len(bk))
		for _, k := range bk {
			v, _ := data.Get(k)
			bp = append(bp, k+"="+v)
		}
		bstr = strings.Join(bp, "&")
	}
	plain := fmt.Sprintf("%s&%s&app_key=%s", qstr, bstr, passportAppKey)
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:]), PassportEncrypt(strings.Join(keys, ","))
}

// sdkSourceInfo reproduces login_api._sdk_source_info.
func (c *Client) sdkSourceInfo() string {
	st := c.loginState()
	st.mu.Lock()
	if st.sdkSourceInfo != "" {
		v := st.sdkSourceInfo
		st.mu.Unlock()
		return v
	}
	st.mu.Unlock()

	p := GetProfile()
	g := p.Geo
	nowMS := float64(time.Now().UnixMilli())
	timeOrigin := roundFloat(nowMS-randomUniform(3000, 60000), 1)

	info := jObj()
	info.set("hardwareConcurrency", jInt(int64(atoiOr(p.CpuCoreNum, 0))))
	info.set("webdriver", jBool(false))
	info.set("chromedriver", jBool(false))
	info.set("shelldriver", jBool(false))
	info.set("plugins", jInt(5))
	info.set("innerHeight", jInt(int64(g[1])))
	info.set("innerWidth", jInt(int64(g[0])))
	info.set("outerHeight", jInt(int64(g[3])))
	info.set("outerWidth", jInt(int64(g[2])))
	webgl := jObj()
	webgl.set("vendor", jStr(p.WebGLVendor))
	webgl.set("renderer", jStr(p.WebGLRenderer))
	info.set("webgl", webgl)
	automation := jObj()
	automation.set("s", jStr("00000000"))
	automation.set("c", jStr("0000"))
	automation.set("p", jStr("0000000"))
	automation.set("s1", jStr("00000000"))
	automation.set("c1", jStr("0000"))
	automation.set("p1", jStr("0"))
	info.set("automation", automation)
	perf := jObj()
	perf.set("timeOrigin", numFromValue(timeOrigin))
	perf.set("usedJSHeapSize", jInt(472537551))
	nav := jObj()
	nav.set("decodedBodySize", jInt(968454))
	nav.set("entryType", jStr("navigation"))
	nav.set("initiatorType", jStr("navigation"))
	nav.set("name", jStr(envOr("DY_PASSPORT_FIXED_PAGE_URL", homeBase+"/?recommend=1")))
	nav.set("renderBlockingStatus", jStr("non-blocking"))
	nav.set("serverTiming", jStr("cdn-cache,edge,origin,inner,tt_agw"))
	nav.set("guleStart", numFromValue(610.8999999761581))
	nav.set("guleDuration", jStr("none"))
	perf.set("navigationTiming", nav)
	info.set("performance", perf)
	browser := jObj()
	browser.set("t", jStr(c.browserT("query")))
	browser.set("bit_protocol", jStr("false"))
	browser.set("bit_helper", jBool(false))
	info.set("browser", browser)

	value := PassportEncrypt(info.stringCompact())
	st.mu.Lock()
	st.sdkSourceInfo = value
	st.mu.Unlock()
	return value
}

func randomUniform(a, b float64) float64 { return a + randFloat()*(b-a) }

// browserT reproduces login_api._browser_t: 4 random digits + a session-stable
// 9-digit suffix shared between the query and cookie probes.
func (c *Client) browserT(role string) string {
	if role != "cookie" {
		role = "query"
	}
	envKey := "DY_PASSPORT_FIXED_BROWSER_T_QUERY"
	if role == "cookie" {
		envKey = "DY_PASSPORT_FIXED_BROWSER_T_COOKIE"
	}
	if fixed := envOr(envKey, envOr("DY_PASSPORT_FIXED_BROWSER_T", "")); fixed != "" {
		return fixed
	}
	st := c.loginState()
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.tSuffix == "" {
		st.tSuffix = fmt.Sprintf("%09d", randIntN(1_000_000_000))
	}
	switch role {
	case "cookie":
		if st.tCookie == "" {
			st.tCookie = fmt.Sprintf("%04d%s", randIntN(10000), st.tSuffix)
		}
		return st.tCookie
	default:
		if st.tQuery == "" {
			st.tQuery = fmt.Sprintf("%04d%s", randIntN(10000), st.tSuffix)
		}
		return st.tQuery
	}
}

// sdkParams reproduces login_api._sdk_params.
func (c *Client) sdkParams(extra [][2]string, data *Params, deviceFP, withPUi, withRequestHost, withMsToken bool) *Params {
	p := NewParams()
	for _, kv := range passportSDKHead {
		p.Add(kv[0], kv[1])
	}
	p.Add("aid", "6383")
	p.Add("language", "zh")
	p.Add("account_app_language", "zh-CN")
	p.Add("ts", sdkTS())
	for _, kv := range extra {
		p.Add(kv[0], kv[1])
	}
	if withPUi {
		p.Add("p_ui", passportSDKTail["p_ui"])
	}
	if deviceFP {
		p.Add("p_ca", passportSDKTail["p_ca"])
		p.Add("p_ca_real", passportSDKTail["p_ca_real"])
		fp := c.Cookie.Get("s_v_web_id")
		if fp == "" {
			fp = GenerateSVWebID()
			c.Cookie.Set("s_v_web_id", fp)
		}
		p.Add("fp", fp)
		p.Add("verifyFp", fp)
	}
	p.Add("account_sdk_source", passportSDKTail["account_sdk_source"])
	p.Add("account_sdk_source_info", c.sdkSourceInfo())
	for _, k := range []string{"p_js_v", "p_js_t", "p_zt", "p_ver", "p_ver_real"} {
		p.Add(k, passportSDKTail[k])
	}
	if withRequestHost {
		p.Add("request_host", escapeQuery(homeBase, ""))
	}
	p.Add("p_bd", passportSDKTail["p_bd"])
	p.Add("p_ts", fmt.Sprintf("%d", time.Now().UnixMilli()))
	p.Add("p_no", envOr("DY_PASSPORT_FIXED_P_NO", randomHex(32)))
	trace := c.Cookie.Get("biz_trace_id")
	if trace == "" {
		trace = envOr("DY_PASSPORT_FIXED_BIZ_TRACE_ID", randomHex(4))
		c.Cookie.Set("biz_trace_id", trace)
	}
	p.Add("biz_trace_id", trace)
	p.Add("device_platform", "web_app")
	sign, qs := passportSign(p, data)
	p.Add("sign", sign)
	p.Add("qs", qs)
	if withMsToken {
		p.Add("msToken", c.MsToken())
	}
	return p
}

var passportHeaderOrderQR = []string{
	"web-sdk-version", "sec-ch-ua-platform", "x-tt-session-dtrait", "referer",
	"sec-ch-ua", "x-tt-passport-aid-sign", "sec-ch-ua-mobile",
	"x-tt-passport-csrf-token", "x-tt-passport-trace-id", "user-agent",
	"accept", "content-type", "x-tt-passport-verify-portrait",
	"accept-language", "origin", "priority", "sec-fetch-dest",
	"sec-fetch-mode", "sec-fetch-site",
}

var passportHeaderOrder = []string{
	"web-sdk-version", "x-tt-session-dtrait", "referer",
	"x-tt-passport-aid-sign", "x-tt-passport-csrf-token",
	"x-tt-passport-trace-id", "user-agent", "accept", "content-type",
	"x-tt-passport-verify-portrait", "accept-encoding", "accept-language",
	"content-length", "origin", "priority",
	"sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
}

// passportHeaders reproduces login_api._passport_headers.
func (c *Client) passportHeaders(form bool, api string, bodyLength int, wireAE bool) Headers {
	prof := GetProfile()
	qr := strings.HasSuffix(api, "/passport/web/challenge/") ||
		strings.HasSuffix(api, "/passport/web/get_qrcode/") ||
		strings.HasSuffix(api, "/passport/web/check_qrconnect/")

	m := map[string]string{}
	m["web-sdk-version"] = "1"
	if qr {
		m["sec-ch-ua-platform"] = prof.SecCHUAPlatform
	}
	if api != "" {
		if dtrait, err := c.SessionDtraitHeader(api, 6383, homeBase, false); err == nil && dtrait != "" {
			m["x-tt-session-dtrait"] = dtrait
		}
	}
	m["referer"] = homeBase + "/"
	if qr {
		m["sec-ch-ua"] = prof.SecCHUA
	}
	if api != "" {
		m["x-tt-passport-aid-sign"] = aidSign(api, sdkTS(), "6383")
	}
	csrf := c.Cookie.Get("passport_csrf_token")
	if csrf == "" {
		csrf = c.Cookie.Get("passport_csrf_token_default")
	}
	m["x-tt-passport-csrf-token"] = csrf
	if trace := c.Cookie.Get("biz_trace_id"); trace != "" {
		m["x-tt-passport-trace-id"] = trace
	}
	m["user-agent"] = prof.UA
	m["accept"] = "application/json, text/javascript"
	if form {
		m["content-type"] = "application/x-www-form-urlencoded"
	}
	if v := c.verifyPortrait(); v != "" {
		m["x-tt-passport-verify-portrait"] = v
	}
	if wireAE {
		m["accept-encoding"] = "gzip, deflate, br, zstd"
	}
	m["accept-language"] = "zh-CN,zh;q=0.9"
	if bodyLength > 0 {
		m["content-length"] = fmt.Sprintf("%d", bodyLength)
	}
	m["origin"] = homeBase
	m["priority"] = "u=1, i"
	m["sec-fetch-dest"] = "empty"
	m["sec-fetch-mode"] = "cors"
	m["sec-fetch-site"] = "same-site"
	if qr {
		m["sec-ch-ua-mobile"] = "?0"
	}
	order := passportHeaderOrder
	if qr {
		order = passportHeaderOrderQR
	}
	out := Headers{}
	for _, name := range order {
		if v, ok := m[name]; ok {
			out.Set(name, v)
		}
	}
	return out
}

func (c *Client) verifyPortrait() string {
	st := c.loginState()
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.verifyPortrait == "" {
		st.verifyPortrait = envOr("DY_PASSPORT_FIXED_VERIFY_PORTRAIT", randomUUIDv4()+".login")
	}
	return st.verifyPortrait
}

// scopedCookieHeader mirrors login_api.scoped_cookies + cookie_header.
func (c *Client) scopedCookieHeader(order []string, host string) string {
	inOrder := map[string]bool{}
	parts := make([]string, 0, len(order)+8)
	for _, name := range order {
		inOrder[name] = true
		if v := c.Cookie.Get(name); v != "" {
			parts = append(parts, name+"="+v)
		}
	}
	loginScoped := host == "login" || host == "sms" || host == "sms_login" || host == "phone_sso"
	for _, name := range c.Cookie.Names() {
		if inOrder[name] {
			continue
		}
		v := c.Cookie.Get(name)
		if v == "" {
			continue
		}
		if loginScoped && (wwwOnlyCookies[name] || name == "my_rd") {
			continue
		}
		parts = append(parts, name+"="+v)
	}
	return strings.Join(parts, "; ")
}

// ---------------------------------------------------------------------------
// request plumbing
// ---------------------------------------------------------------------------

func (c *Client) passportRequest(ctx context.Context, method, fullURL string, headers Headers, cookieHeader string, body []byte) (*Response, error) {
	return c.HTTP.Do(ctx, method, fullURL, headers, cookieHeader, body)
}

// raiseIfBlocked translates passport risk-control error codes.
func raiseIfBlocked(api string, res map[string]any) error {
	data, _ := res["data"].(map[string]any)
	code := toInt64(data["error_code"])
	if code == 0 {
		return nil
	}
	desc := ""
	if d, ok := data["description"].(string); ok {
		desc = d
	} else if d, ok := res["message"].(string); ok {
		desc = d
	}
	if code == 4031 {
		return fmt.Errorf("%s 返回 4031「网站存在安全风险」（域或 passport 版本不对）。原始描述：%s", api, desc)
	}
	return fmt.Errorf("%s 失败 error_code=%d %s", api, code, desc)
}

// harvestSecTS stores bd-ticket-guard-sec-ts and optionally refreshes v2.
func (c *Client) harvestSecTS(ctx context.Context, resp *Response, refreshV2 bool) {
	v := resp.HeaderGet("bd-ticket-guard-sec-ts")
	if v == "" {
		return
	}
	st := c.loginState()
	st.mu.Lock()
	changed := v != st.secTS
	if changed {
		st.secTS = v
	}
	st.mu.Unlock()
	if changed && refreshV2 {
		_ = c.addClientDataV2(ctx, "")
	}
}

// addClientDataV2 builds bd_ticket_guard_client_data_v2 from the harvested
// sec_ts and the server certificate.
func (c *Client) addClientDataV2(ctx context.Context, serverCert string) error {
	st := c.loginState()
	st.mu.Lock()
	secTS := st.secTS
	st.mu.Unlock()
	if secTS == "" {
		return fmt.Errorf("缺少 sec_ts")
	}
	if serverCert == "" {
		cert, _, err := c.FetchServerCert(ctx, 6383, homeBase)
		if err != nil {
			return err
		}
		serverCert = cert
	}
	v2, err := BuildClientDataV2Cookie(c.PrivateKey, secTS, serverCert, c.TsSign)
	if err != nil {
		return err
	}
	c.dshSetGeneratedCookie("bd_ticket_guard_client_data_v2", v2)
	return nil
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

// bootstrapLogin prepares the anonymous session and runs the passport
// challenge chain, mirroring DYLoginApi.bootstrap_auth (non-strict).
func (c *Client) bootstrapLogin(ctx context.Context) error {
	st := c.loginState()
	st.mu.Lock()
	if st.bootstrapped {
		st.mu.Unlock()
		return nil
	}
	st.mu.Unlock()

	if c.PrivateKey == "" {
		priv, _, err := GenerateECKeypair()
		if err != nil {
			return err
		}
		c.PrivateKey = priv
	}
	c.dshSetGeneratedCookie("bd_ticket_guard_client_data", BuildClientDataCookie(c.PrivateKey))
	c.dshSetGeneratedCookie("bd_ticket_guard_client_web_domain", "2")

	// 1. Landing document (source of __ac_nonce / UIFID_TEMP).
	_ = c.fetchWwwBootstrap(ctx)
	// 2. Register ttwid when the landing response did not provide one.
	if c.Cookie.Get("ttwid") == "" {
		_ = c.registerTtwid(ctx)
	}
	c.Cookie.Del("msToken")
	if !c.Cookie.Has("s_v_web_id") {
		c.dshSetGeneratedCookie("s_v_web_id", GenerateSVWebID())
	}
	if c.Cookie.Get("biz_trace_id") == "" {
		c.Cookie.Set("biz_trace_id", envOr("DY_PASSPORT_FIXED_BIZ_TRACE_ID", randomHex(4)))
	}
	c.addPageCookies()
	_ = c.verifyPortrait()

	// 3. www/ttwid/check -> login_guiding_strategy
	_ = c.checkTtwidWww(ctx)
	_, _ = c.loginGuidingStrategy(ctx)
	// 4. get_sec_ts (sec_ts harvest, v2 deferred)
	_, _ = c.getSecTS(ctx)
	// 5. login-domain ttwid/check
	_ = c.checkTtwid(ctx)
	c.Cookie.Del("bd_ticket_guard_client_data_v2")
	if sink, ok := c.HTTP.(interface{ DSHSetGeneratedCookie(string, string) }); ok {
		sink.DSHSetGeneratedCookie("bd_ticket_guard_client_data_v2", "")
	}
	// 6. Seed a real msToken binding this session's ttwid.
	if token, err := c.RefreshMsToken(ctx, false, false, false); err != nil || token == "" {
		return fmt.Errorf("session token unavailable")
	}
	// Interactive challenges are never solved or replayed by this helper.
	// 8. bd_ticket_guard_client_data_v2
	_ = c.addClientDataV2(ctx, "")

	st.mu.Lock()
	st.bootstrapped = true
	st.mu.Unlock()
	return nil
}

func (c *Client) registerTtwid(ctx context.Context) error {
	body := `{"region":"cn","aid":1768,"needFid":false,"service":"www.douyin.com",` +
		`"migrate_info":{"ticket":"","source":"node"},"cbUrlProtocol":"https","union":true}`
	headers := Headers{}
	headers.Set("content-type", "application/json")
	headers.Set("user-agent", GetProfile().UA)
	resp, err := c.HTTP.Do(ctx, fhttp.MethodPost, "https://ttwid.bytedance.com/ttwid/union/register/", headers, "", []byte(body))
	if err != nil {
		return err
	}
	for _, ck := range resp.Cookies {
		if ck.Name == "ttwid" && ck.Value != "" {
			c.Cookie.Set("ttwid", ck.Value)
		}
	}
	return nil
}

func (c *Client) fetchWwwBootstrap(ctx context.Context) error {
	prof := GetProfile()
	path := envOr("DY_PASSPORT_BOOTSTRAP_PATH", "/?recommend=1")
	headers := Headers{}
	headers.Set("upgrade-insecure-requests", "1")
	headers.Set("user-agent", prof.UA)
	headers.Set("sec-ch-ua", prof.SecCHUA)
	headers.Set("sec-ch-ua-mobile", "?0")
	headers.Set("sec-ch-ua-platform", prof.SecCHUAPlatform)
	headers.Set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7")
	headers.Set("accept-language", "zh-CN,zh;q=0.9")
	headers.Set("priority", "u=0, i")
	headers.Set("sec-fetch-dest", "document")
	headers.Set("sec-fetch-mode", "navigate")
	headers.Set("sec-fetch-site", "none")
	headers.Set("sec-fetch-user", "?1")
	if strings.HasPrefix(path, "/?") {
		headers.Set("referer", homeBase+path)
	}
	resp, err := c.HTTP.Do(ctx, fhttp.MethodGet, homeBase+path, headers, "", nil)
	if err != nil {
		return err
	}
	mergeLoginCookies(c, resp)
	return nil
}

func (c *Client) checkTtwidWww(ctx context.Context) error {
	prof := GetProfile()
	headers := Headers{}
	headers.Set("referer", homeBase+"/jingxuan")
	headers.Set("user-agent", prof.UA)
	headers.Set("accept", "application/json, text/plain, */*")
	headers.Set("x-secsdk-csrf-token", "DOWNGRADE")
	headers.Set("content-type", "application/json")
	headers.Set("accept-language", "zh-CN,zh;q=0.9")
	headers.Set("origin", homeBase)
	headers.Set("priority", "u=1, i")
	headers.Set("sec-fetch-dest", "empty")
	headers.Set("sec-fetch-mode", "cors")
	headers.Set("sec-fetch-site", "same-origin")
	body := `{"aid":6383,"service":"www.douyin.com"}`
	cookie := c.scopedCookieHeader(wwwTtwidOrder, "www_ttwid")
	resp, err := c.HTTP.Do(ctx, fhttp.MethodPost, homeBase+"/ttwid/check/", headers, cookie, []byte(body))
	if err != nil {
		return err
	}
	got := mergeLoginCookies(c, resp)
	if t := got["ttwid"]; t != "" {
		c.Cookie.Set("ttwid", t)
	}
	return nil
}

func (c *Client) loginGuidingStrategy(ctx context.Context) (map[string]any, error) {
	path := "/passport/general/login_guiding_strategy/"
	p := c.sdkParams(nil, nil, false, false, true, true)
	p.WithABogusHost(c, nil, "www.douyin.com")
	prof := GetProfile()
	headers := Headers{}
	csrf := c.Cookie.Get("passport_csrf_token")
	if csrf == "" {
		csrf = c.Cookie.Get("passport_csrf_token_default")
	}
	headers.Set("x-tt-passport-csrf-token", csrf)
	headers.Set("referer", homeBase+"/jingxuan")
	headers.Set("user-agent", prof.UA)
	headers.Set("accept", "application/json, text/javascript")
	headers.Set("x-tt-passport-aid-sign", aidSign(path, sdkTS(), "6383"))
	headers.Set("x-tt-passport-trace-id", c.Cookie.Get("biz_trace_id"))
	headers.Set("accept-language", "zh-CN,zh;q=0.9")
	headers.Set("origin", homeBase)
	headers.Set("priority", "u=1, i")
	headers.Set("sec-fetch-dest", "empty")
	headers.Set("sec-fetch-mode", "cors")
	headers.Set("sec-fetch-site", "same-origin")
	cookie := c.scopedCookieHeader(wwwGuidingOrder, "www_guiding")
	resp, err := c.HTTP.Get(ctx, BuildURL(homeBase+path, p.ToString()), headers, cookie)
	if err != nil {
		return nil, err
	}
	mergeLoginCookies(c, resp)
	res, err := decodeJSONObject(resp.Body)
	if err != nil {
		return nil, err
	}
	if err := raiseIfBlocked("login_guiding_strategy/", res); err != nil {
		return res, err
	}
	return res, nil
}

func (c *Client) getSecTS(ctx context.Context) (map[string]any, error) {
	prof := GetProfile()
	p := NewParams()
	p.Add("aid", "6383")
	p.Add("is_from_ttaccountsdk", "1")
	p.Add("msToken", c.MsToken())
	query := standardEncodeQuery(p)
	p.Add("a_bogus", c.Signer.SignQuery(query, "", "www.douyin.com"))
	url := BuildURL(homeBase+"/passport/user_info/get_sec_ts/", standardEncodeQuery(p))
	headers := Headers{}
	headers.Set("referer", homeBase+"/user/self")
	headers.Set("user-agent", prof.UA)
	headers.Set("accept", "application/json")
	headers.Set("x-secsdk-csrf-token", "DOWNGRADE")
	headers.Set("content-type", "application/x-www-form-urlencoded")
	headers.Set("accept-language", "zh-CN,zh;q=0.9")
	headers.Set("origin", homeBase)
	headers.Set("priority", "u=1, i")
	headers.Set("sec-fetch-dest", "empty")
	headers.Set("sec-fetch-mode", "cors")
	headers.Set("sec-fetch-site", "same-origin")
	cookie := c.scopedCookieHeader(wwwBootstrapOrder, "www_bootstrap")
	body := "aid=6383&is_from_ttaccountsdk=1"
	resp, err := c.HTTP.Do(ctx, fhttp.MethodPost, url, headers, cookie, []byte(body))
	if err != nil {
		return nil, err
	}
	mergeLoginCookies(c, resp)
	c.harvestSecTS(ctx, resp, false)
	res, err := decodeJSONObject(resp.Body)
	if err != nil {
		return nil, err
	}
	return res, nil
}

func (c *Client) checkTtwid(ctx context.Context) error {
	prof := GetProfile()
	headers := Headers{}
	headers.Set("referer", homeBase+"/")
	headers.Set("user-agent", prof.UA)
	headers.Set("accept", "application/json, text/plain, */*")
	headers.Set("content-type", "application/json")
	headers.Set("accept-language", "zh-CN,zh;q=0.9")
	headers.Set("origin", homeBase)
	headers.Set("priority", "u=1, i")
	headers.Set("sec-fetch-dest", "empty")
	headers.Set("sec-fetch-mode", "cors")
	headers.Set("sec-fetch-site", "same-site")
	body := `{"aid":6383,"service":"www.douyin.com"}`
	cookie := c.scopedCookieHeader(ttwidOrder, "ttwid")
	resp, err := c.HTTP.Do(ctx, fhttp.MethodPost, loginBase+"/ttwid/check/", headers, cookie, []byte(body))
	if err != nil {
		return err
	}
	got := mergeLoginCookies(c, resp)
	if t := got["ttwid"]; t != "" {
		c.Cookie.Set("ttwid", t)
	}
	return nil
}

// ---------------------------------------------------------------------------
// challenge
// ---------------------------------------------------------------------------

func (c *Client) challenge(ctx context.Context) (map[string]any, error) {
	body, err := BuildChallengeBody()
	if err != nil {
		return nil, err
	}
	data := parseURLEncodedParams(body)
	extra := [][2]string{
		{"request_host", escapeQuery(homeBase, "")},
		{"skip_c", "1"},
	}
	p := c.sdkParams(extra, data, true, false, false, true)
	p.WithABogusHost(c, data, "login.douyin.com")
	headers := c.passportHeaders(true, "/passport/web/challenge/", len(body), false)
	cookie := c.scopedCookieHeader(challengeOrder, "challenge")
	resp, err := c.passportRequest(ctx, fhttp.MethodPost, passportAPI+"challenge/", headers, cookie, []byte(body))
	if err != nil {
		return nil, err
	}
	mergeLoginCookies(c, resp)
	c.harvestSecTS(ctx, resp, false)
	res, err := decodeJSONObject(resp.Body)
	if err != nil {
		return nil, err
	}
	c.applyChallengeTemplate(ctx, res)
	return res, nil
}

// applyChallengeTemplate reproduces _apply_challenge_template: derive bit_env
// from passportiv and run the server-issued JS template for p_in/e_in.
func (c *Client) applyChallengeTemplate(ctx context.Context, res map[string]any) {
	data, _ := res["data"].(map[string]any)
	if data == nil {
		return
	}
	passportiv := asString(data["passportiv"])
	if passportiv != "" {
		if v, err := BuildBitEnv(passportiv, GetProfile().UA); err == nil {
			c.Cookie.Set("bit_env", v)
		}
	}
	tpl := asString(data["template"])
	if tpl == "" {
		return
	}
	out, err := RunChallengeTemplate(tpl, 60)
	if err != nil || out == nil {
		return
	}
	pIn := asString(out["p_in"])
	if pIn == "" {
		return
	}
	payload := jObj()
	payload.set("p_in", jStr(pIn))
	c.Cookie.Set("gulu_source_res", base64.StdEncoding.EncodeToString([]byte(payload.stringCompact())))

	eIn, _ := out["e_in"].(map[string]any)
	probe := jObj()
	probe.set("automa_ele", jStr("false"))
	probe.set("bit_helper", jStr("false"))
	probe.set("chrome_extension_script", jStr("[]"))
	probe.set("console_lied", jStr("false"))
	probe.set("global_variables", jStr("[]"))
	probe.set("swt_alt", jStr("false"))
	probe.set("zn_cap", jStr("false"))
	probe.set("hok_noti", jStr("false"))
	probe.set("inj_zfb", jStr("false"))
	probe.set("t", jStr(c.browserT("cookie")))
	probe.set("bit_protocol", jStr("false"))
	for k, v := range eIn {
		if k == "console_liad" {
			continue
		}
		probe.set(k, jsonAnyToJ(v))
	}
	c.Cookie.Set("sdk_source_info", PassportEncrypt(probe.stringCompact()))
}

func jsonAnyToJ(v any) *jNode {
	switch t := v.(type) {
	case string:
		return jStr(t)
	case bool:
		return jBool(t)
	case float64:
		return numFromValue(t)
	case nil:
		return jNull()
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return jNull()
		}
		return jStr(string(b))
	}
}

// ---------------------------------------------------------------------------
// page cookies
// ---------------------------------------------------------------------------

func (c *Client) addPageCookies() {
	prof := GetProfile()
	setDef := func(name, val string) {
		if !c.Cookie.Has(name) {
			c.Cookie.Set(name, val)
		}
	}
	setDef("enter_pc_once", "1")
	setDef("is_support_rtm_web_ts", "1")
	setDef("hevc_supported", "true")
	setDef("IsDouyinActive", "true")
	setDef("is_dash_user", "1")
	setDef("my_rd", "2")
	setDef("home_can_add_dy_2_desktop", "%220%22")
	setDef("strategyABtestKey", "%22"+fmt.Sprintf("%.3f", float64(time.Now().UnixMilli())/1000)+"%22")
	setDef("dy_swidth", prof.ScreenWidth)
	setDef("dy_sheight", prof.ScreenHeight)
	setDef("device_web_cpu_core", prof.CpuCoreNum)
	setDef("device_web_memory_size", prof.DeviceMemory)
	setDef("architecture", envOr("DY_FP_ARCHITECTURE", "amd64"))
	setDef("x-web-secsdk-uid", randomUUIDv4())

	feed := jObj()
	feed.set("cookie_enabled", jBool(true))
	feed.set("screen_width", jInt(int64(atoiOr(prof.ScreenWidth, 0))))
	feed.set("screen_height", jInt(int64(atoiOr(prof.ScreenHeight, 0))))
	feed.set("browser_online", jBool(true))
	feed.set("cpu_core_num", jInt(int64(atoiOr(prof.CpuCoreNum, 0))))
	feed.set("device_memory", jInt(int64(atoiOr(prof.DeviceMemory, 0))))
	feed.set("downlink", jInt(10))
	feed.set("effective_type", jStr("4g"))
	feed.set("round_trip_time", jInt(0))
	var outer strings.Builder
	encodeJSONStr(&outer, feed.stringCompact())
	setDef("stream_recommend_feed_params", percentEncode(outer.String()))

	setDef("__security_mc_1_s_sdk_crypt_sdk",
		fmt.Sprintf("%s-%s-%s", randomHex(4), randomHex(2), randomHex(2)))
	setDef("bd_ticket_guard_regenerate_keys_time", time.Now().Format("2006-01-02/15:04:05"))

	for _, e := range [][2]string{
		{"DY_UIFID_TEMP", "UIFID_TEMP"}, {"DY_ODIN_TT", "odin_tt"},
		{"DY_BIT_ENV", "bit_env"}, {"DY_PASSPORT_AUTH_MIX_STATE", "passport_auth_mix_state"},
		{"DY_AC_NONCE", "__ac_nonce"}, {"DY_AC_SIGNATURE", "__ac_signature"},
		{"DY_FPK1", "fpk1"}, {"DY_FPK2", "fpk2"},
	} {
		if v := envOr(e[0], ""); v != "" {
			setDef(e[1], v)
		}
	}
	// fpk2 is pure MD5(UA); fpk1 is derived from the embedded device profile
	// (no browser renderer needed). Both can still be overridden by DY_FPK*.
	setDef("fpk2", BuildFpk2(prof.UA))
	if !c.Cookie.Has("fpk1") {
		if v, err := BuildFpk1Random(); err == nil {
			c.Cookie.Set("fpk1", v)
		}
	}
	if !c.Cookie.Has("passport_auth_mix_state") {
		c.Cookie.Set("passport_auth_mix_state", generatePassportAuthMixState(48))
	}
	if !c.Cookie.Has("gulu_source_res") {
		g := jObj()
		g.set("p_in", jStr(randomHex(32)))
		c.Cookie.Set("gulu_source_res", base64.StdEncoding.EncodeToString([]byte(g.stringCompact())))
	}
	if !c.Cookie.Has("sdk_source_info") {
		c.Cookie.Set("sdk_source_info", PassportEncrypt(cookieSdkSourceInfo(c)))
	}
}

// cookieSdkSourceInfo builds the 11-key anti-automation probe stored in the
// sdk_source_info cookie (distinct from the larger query probe).
func cookieSdkSourceInfo(c *Client) string {
	probe := jObj()
	probe.set("automa_ele", jStr("false"))
	probe.set("bit_helper", jStr("false"))
	probe.set("chrome_extension_script", jStr("[]"))
	probe.set("console_lied", jStr("false"))
	probe.set("global_variables", jStr("[]"))
	probe.set("swt_alt", jStr("false"))
	probe.set("zn_cap", jStr("false"))
	probe.set("hok_noti", jStr("false"))
	probe.set("inj_zfb", jStr("false"))
	probe.set("t", jStr(c.browserT("cookie")))
	probe.set("bit_protocol", jStr("false"))
	return probe.stringCompact()
}

// ---------------------------------------------------------------------------
// QR login
// ---------------------------------------------------------------------------

// CreateLoginQRCode bootstraps the session (once) and fetches a QR code.
func (c *Client) CreateLoginQRCode(ctx context.Context) (map[string]any, error) {
	if err := c.bootstrapLogin(ctx); err != nil {
		return nil, err
	}
	return c.getQRCode(ctx)
}

func (c *Client) getQRCode(ctx context.Context) (map[string]any, error) {
	st := c.loginState()
	st.mu.Lock()
	refreshed := st.qrRefreshReady
	st.mu.Unlock()

	extra := [][2]string{
		{"next", homeBase},
		{"need_short_url", "true"},
		{"need_logo", "false"},
		{"is_new_login", "1"},
		{"is_from_iesaccountsaas", "1"},
	}
	p := c.sdkParams(extra, nil, refreshed, true, true, true)
	p.WithABogusHost(c, nil, "login.douyin.com")
	headers := c.passportHeaders(false, "/passport/web/get_qrcode/", 0, false)
	cookie := c.scopedCookieHeader(qrOrder, "qr")
	resp, err := c.passportRequest(ctx, fhttp.MethodGet, BuildURL(passportAPI+"get_qrcode/", p.ToString()), headers, cookie, nil)
	if err != nil {
		return nil, err
	}
	mergeLoginCookies(c, resp)
	ApplyTicketGuard(c, resp)
	c.harvestSecTS(ctx, resp, true)
	res, err := decodeJSONObject(resp.Body)
	if err != nil {
		return nil, err
	}
	if err := raiseIfBlocked("get_qrcode/", res); err != nil {
		return res, err
	}
	return res, nil
}

// CheckQRCodeStatus polls one QR state. Returned data.status is one of
// new / scanned / confirmed / expired.
func (c *Client) CheckQRCodeStatus(ctx context.Context, token string) (map[string]any, error) {
	if err := c.bootstrapLogin(ctx); err != nil {
		return nil, err
	}
	return c.checkQRCodeStatus(ctx, token)
}

func (c *Client) checkQRCodeStatus(ctx context.Context, token string) (map[string]any, error) {
	data := NewParams()
	data.Add("need_logo", "false")
	data.Add("is_frontier", "true")
	data.Add("token", token)
	data.Add("is_new_login", "1")
	data.Add("next", homeBase)
	data.Add("need_short_url", "true")
	extra := [][2]string{{"is_from_iesaccountsaas", "1"}}
	p := c.sdkParams(extra, data, true, true, true, true)
	p.WithABogusHost(c, data, "login.douyin.com")
	body := standardEncodeQuery(data)
	headers := c.passportHeaders(true, "/passport/web/check_qrconnect/", len(body), false)
	cookie := c.scopedCookieHeader(qrOrder, "qr")
	resp, err := c.passportRequest(ctx, fhttp.MethodPost, BuildURL(passportAPI+"check_qrconnect/", p.ToString()), headers, cookie, []byte(body))
	if err != nil {
		return nil, err
	}
	mergeLoginCookies(c, resp)
	ApplyTicketGuard(c, resp)
	c.harvestSecTS(ctx, resp, true)

	raw := strings.TrimSpace(resp.Text())
	if raw == "" {
		return map[string]any{"data": map[string]any{"error_code": float64(7), "description": "empty response from QR poll edge"}, "message": "retry"}, nil
	}
	if !strings.HasPrefix(raw, "{") {
		return nil, fmt.Errorf("check_qrconnect 返回非 JSON（可能命中登录风控页）：HTTP %d，前 120 字：%q", resp.StatusCode, truncate(raw, 120))
	}
	res, err := decodeJSONObject(resp.Body)
	if err != nil {
		return nil, err
	}
	dd, _ := res["data"].(map[string]any)
	if asString(dd["status"]) == "expired" {
		st := c.loginState()
		st.mu.Lock()
		st.qrRefreshReady = true
		st.mu.Unlock()
		if !c.Cookie.Has("download_guide") {
			c.Cookie.Set("download_guide", downloadGuide("1"))
		}
		if ms := c.Cookie.Get("passport_auth_mix_state"); ms != "" && len(ms) != 32 {
			c.Cookie.Set("passport_auth_mix_state", generatePassportAuthMixState(32))
		}
	}
	if toInt64(dd["error_code"]) != 7 {
		if err := raiseIfBlocked("check_qrconnect/", res); err != nil {
			return res, err
		}
	}
	return res, nil
}

// LoginByQRCode drives the full QR flow until confirmation or timeout.
// onQRCode receives each new get_qrcode response data map (may be nil).
func (c *Client) LoginByQRCode(ctx context.Context, timeoutSec int, onQRCode func(map[string]any)) (*Client, error) {
	if timeoutSec <= 0 {
		timeoutSec = 300
	}
	if err := c.bootstrapLogin(ctx); err != nil {
		return nil, err
	}
	st := c.loginState()
	st.mu.Lock()
	st.msPinned = true
	st.mu.Unlock()
	defer func() {
		st.mu.Lock()
		st.msPinned = false
		st.mu.Unlock()
	}()

	deadline := time.Now().Add(time.Duration(timeoutSec) * time.Second)
	var token string
	var tokenBorn time.Time
	wait := qrPollInterval
	scanned := false
	var throttledSince time.Time

	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if token == "" {
			res, err := c.getQRCode(ctx)
			if err != nil {
				return nil, err
			}
			data, _ := res["data"].(map[string]any)
			token = asString(data["token"])
			if token == "" {
				return nil, fmt.Errorf("获取二维码失败: %v", data)
			}
			tokenBorn = time.Now()
			if onQRCode != nil {
				onQRCode(data)
			}
		}
		res, err := c.checkQRCodeStatus(ctx, token)
		if err != nil {
			return nil, err
		}
		info, _ := res["data"].(map[string]any)
		if toInt64(info["error_code"]) == 7 {
			if throttledSince.IsZero() {
				throttledSince = time.Now()
			}
			if time.Since(throttledSince) > throttleGiveUp {
				return nil, fmt.Errorf("check_qrconnect 连续 %d 秒返回 error_code=7（访问太频繁），请稍后重试", int(time.Since(throttledSince).Seconds()))
			}
			wait *= 2
			if wait > 60*time.Second {
				wait = 60 * time.Second
			}
			sleepCtx(ctx, wait)
			continue
		}
		throttledSince = time.Time{}
		wait = qrPollInterval

		status := asString(info["status"])
		switch status {
		case "confirmed":
			if err := c.followLoginRedirect(ctx, asString(info["redirect_url"])); err != nil {
				return nil, err
			}
			return c, nil
		case "expired":
			token = ""
			scanned = false
			continue
		case "scanned":
			scanned = true
		}
		if token != "" && !scanned && time.Since(tokenBorn) > qrTTL {
			last, err := c.checkQRCodeStatus(ctx, token)
			if err == nil {
				ld, _ := last["data"].(map[string]any)
				if asString(ld["status"]) == "confirmed" {
					if err := c.followLoginRedirect(ctx, asString(ld["redirect_url"])); err != nil {
						return nil, err
					}
					return c, nil
				}
				if asString(ld["status"]) == "scanned" {
					scanned = true
				} else {
					token = ""
				}
			}
		}
		sleepCtx(ctx, wait)
	}
	return nil, fmt.Errorf("扫码登录超时")
}

// followLoginRedirect follows the login redirect chain, harvesting Set-Cookie
// and ticket-guard server data from every hop.
func (c *Client) followLoginRedirect(ctx context.Context, redirectURL string) error {
	if redirectURL == "" {
		return fmt.Errorf("login redirect unavailable")
	}
	headers := BuildHeaders(HeaderDOC)
	current := redirectURL
	completed := false
	for range 5 {
		resp, err := c.noRedirectGet(ctx, current, headers)
		if err != nil {
			return err
		}
		mergeLoginCookies(c, resp)
		ApplyTicketGuard(c, resp)
		c.harvestSecTS(ctx, resp, false)
		if resp.StatusCode < 300 || resp.StatusCode >= 400 {
			completed = resp.StatusCode >= 200 && resp.StatusCode < 300
			break
		}
		loc := resp.HeaderGet("Location")
		if loc == "" {
			return fmt.Errorf("login redirect unavailable")
		}
		base, err := url.Parse(current)
		if err != nil {
			return fmt.Errorf("login redirect unavailable")
		}
		next, err := url.Parse(loc)
		if err != nil {
			return fmt.Errorf("login redirect unavailable")
		}
		current = base.ResolveReference(next).String()
	}
	if !completed {
		return fmt.Errorf("login redirect unavailable")
	}
	c.Cookie.Del("msToken")
	return nil
}

// noRedirectGet issues a GET that does not auto-follow redirects, so the
// intermediate 30x Set-Cookie headers can be captured.
func (c *Client) noRedirectGet(ctx context.Context, rawURL string, headers Headers) (*Response, error) {
	if nrt, ok := c.HTTP.(noRedirectTransport); ok {
		return nrt.GetNoRedirect(ctx, rawURL, headers, c.CookieStr())
	}
	return c.HTTP.Get(ctx, rawURL, headers, c.CookieStr())
}

// ---------------------------------------------------------------------------
// phone / SMS login
// ---------------------------------------------------------------------------

// formatSMSPhone mirrors login_api._format_sms_phone.
func formatSMSPhone(phone string) (string, error) {
	raw := strings.TrimSpace(phone)
	if len(raw) == 11 && isDigits(raw) {
		return "+86 " + raw, nil
	}
	if strings.HasPrefix(raw, "+86") && len(raw) == 14 && isDigits(raw[3:]) {
		return "+86 " + raw[3:], nil
	}
	if strings.HasPrefix(raw, "+86 ") && len(raw) == 15 && isDigits(raw[4:]) {
		return "+86 " + raw[4:], nil
	}
	return "", fmt.Errorf("phone must be an 11-digit mainland number or '+86 <11 digits>'")
}

func formatSMSCode(code string) (string, error) {
	raw := strings.TrimSpace(code)
	if len(raw) != 6 || !isDigits(raw) {
		return "", fmt.Errorf("code must be exactly six decimal digits")
	}
	return raw, nil
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// ensureSMSMsToken makes sure the SMS requests carry the post-/web/common
// rotated token (>= 170 decoded bytes), mirroring _ensure_sms_ms_token.
func (c *Client) ensureSMSMsToken(ctx context.Context) (string, error) {
	decodedLen := func(v string) int { return len(percentDecode(v)) }
	if cached := c.cachedMsToken(); decodedLen(cached) >= 170 {
		return cached, nil
	}
	if seeded := c.MsToken(); decodedLen(seeded) >= 170 {
		return seeded, nil
	}
	rotated, err := c.RefreshMsToken(ctx, true, false, true)
	if err != nil {
		return "", err
	}
	if decodedLen(rotated) < 170 {
		return "", fmt.Errorf("短信请求要求 /web/common 轮换后的 msToken（解码后至少 170 字节），当前 %d 字节", decodedLen(rotated))
	}
	return rotated, nil
}

// SendPhoneCode bootstraps the session and sends one SMS code.
func (c *Client) SendPhoneCode(ctx context.Context, phone string) (map[string]any, error) {
	if err := c.bootstrapLogin(ctx); err != nil {
		return nil, err
	}
	formatted, err := formatSMSPhone(phone)
	if err != nil {
		return nil, err
	}
	if _, err := c.ensureSMSMsToken(ctx); err != nil {
		return nil, err
	}
	data := NewParams()
	data.Add("is6Digits", "1")
	data.Add("mix_mode", "1")
	data.Add("mobile", PassportEncrypt(formatted))
	data.Add("type", "3731")
	data.Add("fixed_mix_mode", "1")
	extra := [][2]string{{"is_from_iesaccountsaas", "1"}}
	p := c.sdkParams(extra, data, true, true, true, true)
	p.WithABogusHost(c, data, "login.douyin.com")
	body := standardEncodeQuery(data)
	headers := c.passportHeaders(true, "/passport/web/send_code/", len(body), true)
	cookie := c.scopedCookieHeader(smsCurrentOrder, "sms")
	resp, err := c.passportRequest(ctx, fhttp.MethodPost, BuildURL(passportAPI+"send_code/", p.ToString()), headers, cookie, []byte(body))
	if err != nil {
		return nil, err
	}
	mergeLoginCookies(c, resp)
	res, err := decodeJSONObject(resp.Body)
	if err != nil {
		return nil, err
	}
	st := c.loginState()
	st.mu.Lock()
	st.smsSentAt = time.Now()
	if mt := asString(nestedData(res)["mobile_ticket"]); mt != "" {
		st.mobileTicket = mt
	}
	st.mu.Unlock()
	return res, nil
}

// LoginByPhone submits the SMS code on the same session and returns the client
// with server-issued credentials populated.
func (c *Client) LoginByPhone(ctx context.Context, phone, code string) (*Client, error) {
	st := c.loginState()
	st.mu.Lock()
	sentAt := st.smsSentAt
	st.mu.Unlock()
	if sentAt.IsZero() {
		return nil, fmt.Errorf("sms_login 必须复用同一 Client 的 SendPhoneCode 会话；请先调用 SendPhoneCode")
	}
	if err := c.bootstrapLogin(ctx); err != nil {
		return nil, err
	}
	formatted, err := formatSMSPhone(phone)
	if err != nil {
		return nil, err
	}
	codeFmt, err := formatSMSCode(code)
	if err != nil {
		return nil, err
	}
	if _, err := c.ensureSMSMsToken(ctx); err != nil {
		return nil, err
	}
	data := NewParams()
	data.Add("service", homeBase)
	data.Add("mix_mode", "1")
	data.Add("mobile", PassportEncrypt(formatted))
	data.Add("code", PassportEncrypt(codeFmt))
	data.Add("fixed_mix_mode", "1")
	extra := [][2]string{{"is_from_iesaccountsaas", "1"}}
	p := c.sdkParams(extra, data, true, true, true, true)
	p.WithABogusHost(c, data, "login.douyin.com")
	body := standardEncodeQuery(data)
	headers := c.passportHeaders(true, "/passport/web/sms_login/", len(body), true)
	cookie := c.scopedCookieHeader(smsCurrentOrder, "sms_login")
	resp, err := c.passportRequest(ctx, fhttp.MethodPost, BuildURL(passportAPI+"sms_login/", p.ToString()), headers, cookie, []byte(body))
	if err != nil {
		return nil, err
	}
	got := mergeLoginCookies(c, resp)
	ApplyTicketGuard(c, resp)
	c.harvestSecTS(ctx, resp, true)
	res, err := decodeJSONObject(resp.Body)
	if err != nil {
		return nil, err
	}
	redirect := asString(nestedData(res)["redirect_url"])
	if redirect == "" {
		redirect = asString(res["redirect_url"])
	}
	if redirect != "" {
		if err := c.followLoginRedirect(ctx, redirect); err != nil {
			return nil, err
		}
	}
	_ = got
	return c, nil
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

// downloadGuide reproduces login_api._download_guide.
func downloadGuide(stage string) string {
	fixed := envOr("DY_PASSPORT_DOWNLOAD_GUIDE", "")
	if fixed != "" {
		return fixed
	}
	date := time.Now().Format("20060102")
	if fd := envOr("DY_PASSPORT_FIXED_DATE", envOr("DY_FIXED_DATE", "")); fd != "" {
		date = strings.ReplaceAll(fd, "-", "")
	}
	return percentEncode(`"` + stage + "/" + date + `/0"`)
}

func nestedData(res map[string]any) map[string]any {
	d, _ := res["data"].(map[string]any)
	if d == nil {
		return map[string]any{}
	}
	return d
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// parseURLEncodedParams mirrors urllib.parse.parse_qsl(keep_blank_values=True)
// for the ordered form bodies used by the passport endpoints.
func parseURLEncodedParams(s string) *Params {
	p := NewParams()
	for pair := range strings.SplitSeq(s, "&") {
		if pair == "" {
			continue
		}
		k, v, _ := strings.Cut(pair, "=")
		kd, err := url.QueryUnescape(k)
		if err != nil {
			kd = k
		}
		vd, err := url.QueryUnescape(v)
		if err != nil {
			vd = v
		}
		p.Add(kd, vd)
	}
	return p
}
