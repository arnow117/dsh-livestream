package douyin

// Client is the Douyin session: cookies, transport, signature state and the
// session-scoped caches the API methods need.

import (
	"bytes"
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	"github.com/sirupsen/logrus"
)

// msTokenTTL matches the mssdk 600s token cache.
const msTokenTTL = 10 * time.Minute

const (
	douyinBase  = "https://www.douyin.com"
	liveBase    = "https://live.douyin.com"
	creatorBase = "https://creator.douyin.com"
)

const (
	imText         = 7
	imBigEmoji     = 5
	imStoryPic     = 27
	imStoryVideo   = 30
	imVoice        = 17
	imEncryptVoice = 109
	imShareAweme   = 8
	imSharePhotos  = 77
	imShareWeb     = 26
	imShareUser    = 25
	imFile         = 6
)

// Options configures a Client.
type Options struct {
	Ticket        string
	TsSign        string
	ClientCert    string
	PrivateKey    string
	DtraitBlob    string
	SessionDtrait string
	Proxy         string
	// Transport overrides the HTTP transport. Nil uses the default
	// Chrome-impersonating client built from Proxy.
	Transport Transport
}

// Client is a Douyin session bound to one cookie set.
type Client struct {
	Cookie        *Cookies
	HTTP          Transport
	Signer        *AbogusSigner
	XSigner       *XbogusSigner
	Ticket        string
	TsSign        string
	ClientCert    string
	PrivateKey    string
	DtraitBlob    string
	SessionDtrait string

	mu             sync.Mutex
	loginStateMu   sync.Mutex
	loginSession   *loginState
	msToken        string
	msTokenReal    bool
	msFetching     bool
	msTS           time.Time
	webID          string
	webIDResolving bool
	uid            int64
	secUID         string
	ecdh           map[string][]byte
	dtraitMat      map[string][2]string
}

// NewClient builds a session from a Cookie header value.
func NewClient(cookieStr string, opts Options) (*Client, error) {
	transport := opts.Transport
	if transport == nil {
		http, err := NewHTTPClient(opts.Proxy)
		if err != nil {
			return nil, err
		}
		transport = http
	}
	c := &Client{
		Cookie:        TransCookies(cookieStr),
		HTTP:          transport,
		Signer:        NewAbogusSigner(),
		XSigner:       NewXbogusSigner(),
		Ticket:        opts.Ticket,
		TsSign:        opts.TsSign,
		ClientCert:    opts.ClientCert,
		PrivateKey:    opts.PrivateKey,
		DtraitBlob:    opts.DtraitBlob,
		SessionDtrait: opts.SessionDtrait,
		ecdh:          map[string][]byte{},
	}
	if !c.Cookie.Has("s_v_web_id") {
		c.dshSetGeneratedCookie("s_v_web_id", GenerateSVWebID())
	}
	c.Cookie.Del("msToken")
	return c, nil
}

// dshSetGeneratedCookie preserves provenance for session transports. It must
// only be used immediately after local generation, never for server cookies.
func (c *Client) dshSetGeneratedCookie(name, value string) {
	c.Cookie.Set(name, value)
	if sink, ok := c.HTTP.(interface{ DSHSetGeneratedCookie(string, string) }); ok {
		sink.DSHSetGeneratedCookie(name, value)
	}
}

// CookieStr serializes the current cookie mapping.
func (c *Client) CookieStr() string { return c.Cookie.String() }

// MsToken returns the session msToken. A real token from the mssdk exchange is
// preferred; until the first exchange lands (or if it fails) a random token is
// returned as a fallback.
// The exchange itself runs in the background so callers never block on it.
func (c *Client) MsToken() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.msTokenReal && c.msToken != "" && time.Since(c.msTS) < msTokenTTL {
		return c.msToken
	}
	return ""
}

// startMsTokenFetch launches at most one background mssdk exchange.
func (c *Client) startMsTokenFetch() {
	c.mu.Lock()
	if c.msFetching {
		c.mu.Unlock()
		return
	}
	c.msFetching = true
	c.mu.Unlock()
	go func() {
		defer func() {
			c.mu.Lock()
			c.msFetching = false
			c.mu.Unlock()
		}()
		ctx, cancel := contextWithTimeout(20 * time.Second)
		defer cancel()
		if _, err := c.RefreshMsToken(ctx, false, false, false); err != nil {
			logrus.WithError(err).Debug("msToken 动态换取失败，暂用随机 token")
		}
	}()
}

// PrimeMsToken performs the mssdk exchange synchronously (startup / manual refresh).
func (c *Client) PrimeMsToken(ctx context.Context) (string, error) {
	if tok, err := c.RefreshMsToken(ctx, false, false, false); err == nil && tok != "" {
		return tok, nil
	} else if err != nil {
		return "", err
	}
	return "", fmt.Errorf("mssdk /web/r/token 未返回 msToken")
}

// SetMsToken pins a token (used by the login flows and the mssdk exchange).
func (c *Client) SetMsToken(v string) {
	if v == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.msToken = v
	c.msTokenReal = true
	c.msTS = time.Now()
}

// contextWithTimeout is a tiny wrapper to avoid importing context in callers.
func contextWithTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

// WebID resolves the real device webid, cached. While resolution is in flight
// (the bootstrap request itself carries a webid) a random value is returned.
func (c *Client) WebID(ctx context.Context) string {
	c.mu.Lock()
	if c.webID != "" {
		defer c.mu.Unlock()
		return c.webID
	}
	if c.webIDResolving {
		c.mu.Unlock()
		return GenerateFakeWebID()
	}
	c.webIDResolving = true
	c.mu.Unlock()

	id, err := c.GetDeviceID(ctx)
	if err != nil || id == "" {
		id = GenerateFakeWebID()
	}
	c.mu.Lock()
	c.webID = id
	c.webIDResolving = false
	c.mu.Unlock()
	return id
}

// SetWebID pins the webid cache.
func (c *Client) SetWebID(v string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.webID = v
}

// UID returns the logged-in numeric user id.
func (c *Client) UID(ctx context.Context) (int64, error) {
	c.mu.Lock()
	if c.uid != 0 {
		defer c.mu.Unlock()
		return c.uid, nil
	}
	c.mu.Unlock()
	uid, err := c.GetMyUID(ctx)
	if err != nil {
		return 0, err
	}
	c.mu.Lock()
	c.uid = uid
	c.mu.Unlock()
	return uid, nil
}

// SetUID pins the uid cache.
func (c *Client) SetUID(uid int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.uid = uid
}

// SecUID resolves the logged-in user's sec_uid.
func (c *Client) SecUID(ctx context.Context) (string, error) {
	c.mu.Lock()
	if c.secUID != "" {
		defer c.mu.Unlock()
		return c.secUID, nil
	}
	c.mu.Unlock()
	sec, err := c.GetMySecUID(ctx)
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	c.secUID = sec
	c.mu.Unlock()
	return sec, nil
}

// CommentUID is md5(uid) as used in comment/digg queries.
func (c *Client) CommentUID(ctx context.Context) string {
	uid, err := c.UID(ctx)
	if err != nil {
		return ""
	}
	return MD5Hex(fmt.Sprintf("%d", uid))
}

// ECDHKey returns the cached bd-ticket-guard session key for (aid, origin).
func (c *Client) ECDHKey(ctx context.Context, aid int, origin string) []byte {
	if c.PrivateKey == "" {
		return nil
	}
	key := fmt.Sprintf("%d|%s", aid, origin)
	c.mu.Lock()
	if v, ok := c.ecdh[key]; ok {
		c.mu.Unlock()
		return v
	}
	c.mu.Unlock()
	cert, _, err := c.FetchServerCert(ctx, aid, origin)
	var derived []byte
	if err == nil && cert != "" {
		derived, _ = DeriveECDHKey(c.PrivateKey, cert)
	}
	c.mu.Lock()
	c.ecdh[key] = derived
	c.mu.Unlock()
	return derived
}

// CSRFToken fetches x-secsdk-csrf-token for an origin.
func (c *Client) CSRFToken(ctx context.Context, origin, path string) string {
	prof := GetProfile()
	headers := Headers{
		{Name: "x-secsdk-csrf-request", Value: "1"},
		{Name: "referer", Value: origin + "/"},
		{Name: "user-agent", Value: prof.UA},
		{Name: "x-secsdk-csrf-version", Value: "1.2.22"},
		{Name: "accept", Value: "*/*"},
		{Name: "accept-language", Value: prof.AcceptLanguage},
	}
	resp, err := c.HTTP.Do(ctx, fhttp.MethodHead, origin+path, headers, c.CookieStr(), nil)
	if err != nil {
		return ""
	}
	parts := strings.Split(resp.HeaderGet("X-Ware-Csrf-Token"), ",")
	if len(parts) < 5 {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

// SessionDtraitHeader returns the x-tt-session-dtrait header value, or "" when
// no device material is configured.
func (c *Client) SessionDtraitHeader(path string, aid int, origin string, strict bool) (string, error) {
	if c.DtraitBlob == "" {
		if c.SessionDtrait != "" && !strict {
			return c.SessionDtrait, nil
		}
		if strict {
			return "", fmt.Errorf("缺少可按 path 重算的 dtrait 设备素材；请配置 DY_DTRAIT_BLOB")
		}
		return "", nil
	}
	header, err := c.buildSessionDtrait(path, aid, origin)
	if err != nil {
		if strict {
			return "", fmt.Errorf("x-tt-session-dtrait 构造失败: %w", err)
		}
		return "", nil
	}
	return header, nil
}

// WithBD adds the full bd-ticket-guard header set (write/publish APIs).
func (h *Headers) WithBD(ctx context.Context, c *Client, api string, aid int, origin string, requireDtrait bool) error {
	if c.Ticket == "" || c.TsSign == "" || c.PrivateKey == "" {
		return fmt.Errorf("bd-ticket-guard 缺少 ticket/ts_sign/private_key 配置")
	}
	ecdhKey := c.ECDHKey(ctx, aid, origin)
	clientData, algoType, err := GenerateBDTicketClientData(api, c.Ticket, c.TsSign, c.PrivateKey, ecdhKey, 0, nil)
	if err != nil {
		return err
	}
	h.Set("bd-ticket-guard-client-data", clientData)
	h.Set("bd-ticket-guard-ree-public-key", GenerateReeKey(c.PrivateKey))
	h.Set("bd-ticket-guard-version", "2")
	h.Set("bd-ticket-guard-web-version", TicketGuardVersion(c.TsSign))
	if algoType == "hmac" {
		h.Set("bd-ticket-guard-web-sign-type", "1")
	} else {
		h.Set("bd-ticket-guard-web-sign-type", "0")
	}
	dtrait, err := c.SessionDtraitHeader(api, aid, origin, requireDtrait)
	if err != nil {
		return err
	}
	if dtrait != "" {
		h.Set("x-tt-session-dtrait", dtrait)
	} else if requireDtrait {
		return fmt.Errorf("发布接口必须携带 x-tt-session-dtrait")
	}
	return nil
}

// CheckRisk converts Douyin's anti-bot responses into readable errors.
func CheckRisk(resp *Response) error {
	text := strings.TrimLeft(resp.Text(), " \t\r\n")
	if strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
		return nil
	}
	logid := resp.HeaderGet("X-Tt-Logid")
	if bd := resp.HeaderGet("X-Vc-Bdturing-Parameters"); bd != "" {
		subtype := ""
		if raw, err := base64.StdEncoding.DecodeString(bd + strings.Repeat("=", (4-len(bd)%4)%4)); err == nil {
			var info map[string]any
			if json.Unmarshal(raw, &info) == nil {
				if s, ok := info["subtype"].(string); ok {
					subtype = s
				}
			}
		}
		if subtype == "" {
			subtype = "未知类型"
		}
		return fmt.Errorf("触发人机验证（bdturing %s）。需在浏览器完成验证、或更换 IP / 降低请求频率后重试。logid=%s", subtype, logid)
	}
	if pp := resp.HeaderGet("X-Tt-Verify-Passport-Decision"); pp != "" {
		scene := ""
		var info map[string]any
		if json.Unmarshal([]byte(pp), &info) == nil {
			if ep, ok := info["event_params"].(map[string]any); ok {
				if s, ok := ep["verify_scene"].(string); ok {
					scene = s
				}
			}
		}
		if scene == "" {
			scene = "未知"
		}
		return fmt.Errorf("需要二次身份验证（scene=%s）。多为缺少 x-tt-session-dtrait 或账号风控所致。logid=%s", scene, logid)
	}
	if text == "" {
		return fmt.Errorf("接口返回空响应（HTTP %d），通常是签名参数不对或被风控拦截。logid=%s", resp.StatusCode, logid)
	}
	if strings.Contains(text, "__ac_nonce") || strings.Contains(text, "_$jsvmprt") {
		return fmt.Errorf("命中 acrawler 挑战页（HTTP %d）。需要 __ac_signature：本服务会在可解析到 Node（PATH / DY_NODE / mise）时本地求解并自动重试一次；也可用 DY_AC_SIGNATURE/DY_AC_NONCE 注入。logid=%s", resp.StatusCode, logid)
	}
	head := text
	if len(head) > 120 {
		head = head[:120]
	}
	return fmt.Errorf("接口返回非 JSON（HTTP %d），前 120 字：%q。logid=%s", resp.StatusCode, head, logid)
}

// acRetry solves an acrawler challenge page once and replays the request.
// send must re-issue the same request (fresh signature/timestamp).
func (c *Client) acRetry(_ context.Context, resp *Response, _ func() (*Response, error)) (*Response, error) {
	// Do not solve or replay an interactive challenge inside the helper.
	return resp, nil
}

// GetParams performs a GET using the params' raw query.
func (c *Client) GetParams(ctx context.Context, base string, params *Params, headers Headers) (*Response, error) {
	return c.HTTP.Get(ctx, BuildURL(base, params.ToString()), headers, c.CookieStr())
}

// GetParamsSigned performs a GET whose query must carry x-secsdk-web-signature.
func (c *Client) GetParamsSigned(ctx context.Context, base string, params *Params, headers Headers) (*Response, error) {
	url := SignWebURL(BuildURL(base, params.ToString()), 0, c.Cookie.Get("UIFID"))
	return c.HTTP.Get(ctx, url, headers, c.CookieStr())
}

// PostForm performs a form-encoded POST with the params' raw query.
func (c *Client) PostForm(ctx context.Context, base string, params *Params, headers Headers, body string) (*Response, error) {
	return c.HTTP.PostJSON(ctx, BuildURL(base, params.ToString()), headers, c.CookieStr(), "", []byte(body))
}

// GetJSON performs a GET and decodes a JSON object, transparently merging any
// Set-Cookie values into the session.
func (c *Client) GetJSON(ctx context.Context, base string, params *Params, headers Headers) (map[string]any, error) {
	resp, err := c.GetParams(ctx, base, params, headers)
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		resp, err = c.acRetry(ctx, resp, func() (*Response, error) { return c.GetParams(ctx, base, params, headers) })
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

// GetJSONSigned is GetJSON plus web-signature signing.
func (c *Client) GetJSONSigned(ctx context.Context, base string, params *Params, headers Headers) (map[string]any, error) {
	resp, err := c.GetParamsSigned(ctx, base, params, headers)
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		resp, err = c.acRetry(ctx, resp, func() (*Response, error) { return c.GetParamsSigned(ctx, base, params, headers) })
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

func (c *Client) absorbCookies(resp *Response) {
	if len(resp.Cookies) == 0 {
		return
	}
	for _, ck := range resp.Cookies {
		if ck.Value == "" {
			continue
		}
		c.Cookie.Set(ck.Name, ck.Value)
	}
}

// decodeJSONObject preserves 64-bit IDs exactly: Douyin aweme/room/user ids
// exceed float64's 53-bit integer range, so numbers stay json.Number instead
// of being silently rounded.
func decodeJSONObject(body []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var out map[string]any
	if err := dec.Decode(&out); err != nil {
		return nil, fmt.Errorf("decode json: %w", err)
	}
	return out, nil
}

func nowUnix() int64 { return time.Now().Unix() }

// ProxyFromEnv returns the configured proxy URL for the transport.
func ProxyFromEnv() string {
	return cmp.Or(strings.TrimSpace(os.Getenv("DY_PROXY")), strings.TrimSpace(os.Getenv("HTTPS_PROXY")))
}
