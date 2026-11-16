package douyin

// Creator-center (creator.douyin.com) publishing session, request signing and
// create_v2 payload builders.
//
// Image collections and videos go through the same publish endpoint
// (/web/api/media/aweme/create_v2/) which is a bd-ticket-guard strictly
// validated write API. The media bytes themselves are uploaded through the
// Volcengine ImageX / VOD gateways (see creator_media.go).

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"

	fhttp "github.com/bogdanfinn/fhttp"
)

// Creator request constants (captured 2026-08-30).
const (
	creatorOrigin     = creatorBase
	creatorHostName   = "creator.douyin.com"
	creatorReadAID    = 2906
	creatorAID        = "1128"
	imagexAppID       = "2906"
	imagexServiceID   = "jm8ajry58r"
	creatorCreateAPI  = "/web/api/media/aweme/create_v2/"
	creatorUploadPage = "https://creator.douyin.com/creator-micro/content/upload"
	csrfProbePath     = "/web/api/media/anchor/search"

	postImageReferer = "https://creator.douyin.com/creator-micro/content/post/image" +
		"?enter_from=publish_page&media_type=image&type=new"
	postVideoReferer = "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page"
)

// PublishImageRequest describes an image-collection publish. Visibility is the
// creator-center "谁可以看" value: "0" public, "1" private (default), "2"
// friends only. AllowDownload nil means allowed (creator-center default). Tags are
// appended to Content as "#tag" plain text (the browser accepts hashtags inside
// the description); Challenges/Mentions/Activity are explicit JSON pass-through
// lists, matching the creator-center API parameters.
type PublishImageRequest struct {
	Title         string         `json:"title"`
	Content       string         `json:"content"`
	Images        []string       `json:"images"`
	Tags          []string       `json:"tags"`
	Visibility    string         `json:"visibility"`
	AllowDownload *bool          `json:"allow_download,omitempty"`
	Timing        int64          `json:"timing,omitempty"`
	CoverIndex    int            `json:"cover_index,omitempty"`
	CoverURI      string         `json:"cover_uri,omitempty"`
	Challenges    []any          `json:"challenges,omitempty"`
	Mentions      []any          `json:"mentions,omitempty"`
	Activity      []any          `json:"activity,omitempty"`
	POI           map[string]any `json:"poi,omitempty"`
	MixID         string         `json:"mix_id,omitempty"`
	HotSpot       map[string]any `json:"hot_spot,omitempty"`
	CreationID    string         `json:"creation_id,omitempty"`
}

// PublishVideoRequest describes a video publish. Cover is an explicit cover
// file path / URL / tos- uri; when empty the VOD commit's Snapshot poster is
// used as the final cover.
type PublishVideoRequest struct {
	Title         string         `json:"title"`
	Content       string         `json:"content"`
	Video         string         `json:"video"`
	Tags          []string       `json:"tags"`
	Visibility    string         `json:"visibility"`
	AllowDownload *bool          `json:"allow_download,omitempty"`
	Timing        int64          `json:"timing,omitempty"`
	Cover         string         `json:"cover,omitempty"`
	CoverDelay    int            `json:"cover_delay,omitempty"`
	Challenges    []any          `json:"challenges,omitempty"`
	Mentions      []any          `json:"mentions,omitempty"`
	Activity      []any          `json:"activity,omitempty"`
	POI           map[string]any `json:"poi,omitempty"`
	MixID         string         `json:"mix_id,omitempty"`
	HotSpot       map[string]any `json:"hot_spot,omitempty"`
	CreationID    string         `json:"creation_id,omitempty"`
	UserID        string         `json:"user_id,omitempty"`
}

// creatorState caches the per-session creator bootstrap results (csrf token).
// It is stored in a package map because Client's field set is frozen.
type creatorState struct {
	mu           sync.Mutex
	csrf         string
	bootstrapped bool
}

var creatorStates sync.Map // map[*Client]*creatorState

func creatorStateFor(c *Client) *creatorState {
	if v, ok := creatorStates.Load(c); ok {
		return v.(*creatorState)
	}
	st := &creatorState{}
	actual, _ := creatorStates.LoadOrStore(c, st)
	return actual.(*creatorState)
}

// BootstrapCreatorSession mimics entering the creator page after a main-domain
// login: it seeds the creator host-only / creator-domain cookies, performs the
// oversea judgment hop and exchanges the creator-domain x-secsdk-csrf-token.
func (c *Client) BootstrapCreatorSession(ctx context.Context) error {
	st := creatorStateFor(c)
	st.mu.Lock()
	if st.bootstrapped {
		st.mu.Unlock()
		return nil
	}
	st.mu.Unlock()

	prof := GetProfile()
	nav := Headers{
		{Name: "sec-ch-ua-platform", Value: prof.SecCHUAPlatform},
		{Name: "upgrade-insecure-requests", Value: "1"},
		{Name: "user-agent", Value: prof.UA},
		{Name: "accept", Value: "text/html,application/xhtml+xml,application/xml;q=0.9," +
			"image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
		{Name: "sec-ch-ua", Value: prof.SecCHUA},
		{Name: "sec-ch-ua-mobile", Value: "?0"},
		{Name: "sec-fetch-site", Value: "none"},
		{Name: "sec-fetch-mode", Value: "navigate"},
		{Name: "sec-fetch-user", Value: "?1"},
		{Name: "sec-fetch-dest", Value: "document"},
		{Name: "accept-language", Value: prof.AcceptLanguage},
		{Name: "priority", Value: "u=0, i"},
	}
	resp, err := c.HTTP.Get(ctx, creatorUploadPage, nav, c.CookieStr())
	if err != nil {
		return err
	}
	c.absorbCookies(resp)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("creator 会话初始化失败: HTTP %d", resp.StatusCode)
	}

	oversea := Headers{
		{Name: "origin", Value: creatorOrigin},
		{Name: "accept", Value: "*/*"},
		{Name: "sec-fetch-site", Value: "same-origin"},
		{Name: "sec-fetch-mode", Value: "cors"},
		{Name: "sec-fetch-dest", Value: "empty"},
		{Name: "referer", Value: creatorUploadPage},
		{Name: "user-agent", Value: prof.UA},
		{Name: "accept-language", Value: prof.AcceptLanguage},
	}
	// Enrichment hop: never fatal, odin_tt cannot be synthesized.
	if oresp, oerr := c.HTTP.Get(ctx, creatorOrigin+"/aweme/v1/web/oversea/judgment/", oversea, c.CookieStr()); oerr == nil {
		c.absorbCookies(oresp)
	}

	c.Cookie.Set("x-web-secsdk-uid", creatorUUID())
	if !c.Cookie.Has("gfkadpd") {
		c.Cookie.Set("gfkadpd", "2906,33638")
	}
	if !c.Cookie.Has("_tea_utm_cache_2906") {
		c.Cookie.Set("_tea_utm_cache_2906", "undefined")
	}

	token := c.CSRFToken(ctx, creatorOrigin, csrfProbePath)
	c.Cookie.Set("s_v_web_id", GenerateSVWebID())

	st.mu.Lock()
	st.csrf = token
	st.bootstrapped = true
	st.mu.Unlock()
	return nil
}

// CreatorCSRFToken returns the creator-domain x-secsdk-csrf-token, bootstrapping
// the session when necessary.
func (c *Client) CreatorCSRFToken(ctx context.Context) string {
	st := creatorStateFor(c)
	st.mu.Lock()
	token := st.csrf
	st.mu.Unlock()
	if token != "" {
		return token
	}
	if err := c.BootstrapCreatorSession(ctx); err == nil {
		st.mu.Lock()
		token = st.csrf
		st.mu.Unlock()
	}
	if token != "" {
		return token
	}
	return c.CSRFToken(ctx, creatorOrigin, csrfProbePath)
}

// CreatorCookieStr serializes the session cookies in the browser creator wire
// order (host-only creator cookies first, then the shared main-domain ones).
func (c *Client) CreatorCookieStr() string {
	priority := []string{
		"gd_random", "x-web-secsdk-uid", "gfkadpd", "_tea_utm_cache_2906",
		"csrf_session_id", "bd_ticket_guard_client_web_domain", "s_v_web_id",
		"bd_ticket_guard_client_data",
	}
	used := map[string]bool{}
	parts := make([]string, 0, len(c.Cookie.Names()))
	for _, name := range priority {
		if used[name] || !c.Cookie.Has(name) {
			continue
		}
		used[name] = true
		parts = append(parts, name+"="+c.Cookie.Get(name))
	}
	for _, name := range c.Cookie.Names() {
		if used[name] {
			continue
		}
		used[name] = true
		parts = append(parts, name+"="+c.Cookie.Get(name))
	}
	return strings.Join(parts, "; ")
}

func creatorUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return GenerateMsToken()[:36]
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// creatorSignedParams builds the creator query group with the browser insertion
// order and appends msToken then a_bogus.
func (c *Client) creatorSignedParams(initial [][2]string, includePlatform, includeMsToken, sign bool, body string) *Params {
	p := NewParams()
	for _, kv := range initial {
		p.Add(kv[0], kv[1])
	}
	if includePlatform {
		p.WithCreatorPlatform()
	}
	if includeMsToken {
		p.Add("msToken", c.MsToken())
	}
	if sign {
		p.Add("a_bogus", c.Signer.SignQuery(p.SpliceURL(), body, creatorHostName))
	}
	return p
}

// creatorXHRHeaders mirrors _creator_xhr_headers(): same-origin creator XHR
// headers, deliberately without sec-ch-ua* (the creator domain does not send
// them). The Cookie header is passed separately to the transport.
func (c *Client) creatorXHRHeaders(ctx context.Context, referer, contentType string, isGet bool, first [][2]string) Headers {
	prof := GetProfile()
	h := Headers{}
	for _, kv := range first {
		h.Set(kv[0], kv[1])
	}
	h.Set("referer", referer)
	h.Set("user-agent", prof.UA)
	h.Set("accept", "application/json, text/plain, */*")
	if token := c.CreatorCSRFToken(ctx); token != "" {
		h.Set("x-secsdk-csrf-token", token)
	}
	if contentType != "" {
		h.Set("content-type", contentType)
	}
	h.Set("accept-language", prof.AcceptLanguage)
	if !isGet {
		h.Set("origin", creatorOrigin)
	}
	h.Set("priority", "u=1, i")
	h.Set("sec-fetch-dest", "empty")
	h.Set("sec-fetch-mode", "cors")
	h.Set("sec-fetch-site", "same-origin")
	return h
}

// creatorAPIRequest performs a creator same-origin XHR and decodes its JSON.
func (c *Client) creatorAPIRequest(ctx context.Context, method, api string, initial [][2]string,
	includePlatform, includeMsToken, sign bool, body, contentType, referer string,
	firstHeaders [][2]string) (map[string]any, error) {
	p := c.creatorSignedParams(initial, includePlatform, includeMsToken, sign, body)
	h := c.creatorXHRHeaders(ctx, referer, contentType, method == fhttp.MethodGet, firstHeaders)
	url := creatorBase + api
	var resp *Response
	var err error
	if method == fhttp.MethodGet {
		resp, err = c.HTTP.Get(ctx, BuildURL(url, p.ToString()), h, c.CreatorCookieStr())
	} else {
		resp, err = c.HTTP.Do(ctx, fhttp.MethodPost, BuildURL(url, p.ToString()), h, c.CreatorCookieStr(), []byte(body))
	}
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	return creatorDecode(resp)
}

// creatorDecode applies the risk check before parsing JSON.
func creatorDecode(resp *Response) (map[string]any, error) {
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	return decodeJSONObject(resp.Body)
}

// creatorJSON is json.dumps(..., ensure_ascii=False, separators=(",", ":")).
func creatorJSON(v any) string {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return ""
	}
	return strings.TrimRight(buf.String(), "\n")
}

// GetPreviewVideoList mirrors /janus/douyin/creator/pc/work_list (no msToken /
// a_bogus on the captured request).
func (c *Client) GetPreviewVideoList(ctx context.Context, currentAwemeID string) ([]any, error) {
	initial := [][2]string{
		{"scene", "star_atlas"},
		{"device_platform", "android"},
		{"status", "4"},
		{"count", "18"},
		{"max_cursor", "0"},
	}
	result, err := c.creatorAPIRequest(ctx, fhttp.MethodGet, "/janus/douyin/creator/pc/work_list", initial,
		true, false, false, "", "", postVideoReferer, nil)
	if err != nil {
		return nil, err
	}
	if toInt64(result["status_code"]) != 0 {
		if _, ok := result["status_code"]; ok {
			return nil, fmt.Errorf("work_list 失败: %v", result["status_msg"])
		}
	}
	preview := []any{map[string]any{"isCurrent": true}}
	list, _ := result["aweme_list"].([]any)
	for _, raw := range list {
		item, _ := raw.(map[string]any)
		if item == nil {
			continue
		}
		video, _ := item["video"].(map[string]any)
		coverURL := ""
		if video != nil {
			if opt, ok := video["optimized_cover"].(map[string]any); ok {
				coverURL = creatorFirstURL(opt["url_list"])
			}
			if coverURL == "" {
				if n, ok := video["cover"].(map[string]any); ok {
					coverURL = creatorFirstURL(n["url_list"])
				}
			}
		}
		mapped := map[string]any{"coverUrl": coverURL}
		if _, ok := item["is_pinned"]; ok {
			mapped["isPinned"] = item["is_pinned"]
		}
		mapped["isTiming"] = false
		if t, ok := item["timer"].(map[string]any); ok {
			mapped["isTiming"] = toInt64(t["status"]) == 0
		}
		mapped["isPreview"] = toInt64(item["status_value"]) == 141
		mapped["isCurrent"] = currentAwemeID != "" && fmt.Sprint(item["aweme_id"]) == currentAwemeID
		mapped["isLiveReplay"] = item["is_live_replay"] == true
		preview = append(preview, mapped)
	}
	return preview, nil
}

// GetCoverGenRef mirrors /aweme/v1/cover/gen/ref/.
func (c *Client) GetCoverGenRef(ctx context.Context, creationID string) (map[string]any, error) {
	res, err := c.creatorAPIRequest(ctx, fhttp.MethodGet, "/aweme/v1/cover/gen/ref/",
		[][2]string{{"creation_id", creationID}}, true, true, true, "", "", postVideoReferer, nil)
	if err != nil {
		return nil, err
	}
	if code := toInt64(res["status_code"]); code != 0 {
		if _, ok := res["status_code"]; ok {
			return nil, fmt.Errorf("cover/gen/ref 失败: %v", res)
		}
	}
	return res, nil
}

// GetUserDeclarationSuggestion mirrors /aweme/v3/user_declaration/suggestion/.
func (c *Client) GetUserDeclarationSuggestion(ctx context.Context, creationID, itemType string) (map[string]any, error) {
	if itemType == "" {
		itemType = "video"
	}
	feats := creatorJSON(map[string]any{
		"has_ai_metadata":   false,
		"is_xing_tu_submit": false,
		"has_marketing_poi": false,
		"item_type":         itemType,
	})
	res, err := c.creatorAPIRequest(ctx, fhttp.MethodGet, "/aweme/v3/user_declaration/suggestion/",
		[][2]string{
			{"scene", "new_self_media_before_publish"},
			{"creation_id", creationID},
			{"user_decl_judge_feats", feats},
			{"libra_token", "douyin_pc"},
		}, true, true, true, "", "", postVideoReferer, nil)
	if err != nil {
		return nil, err
	}
	if code := toInt64(res["status_code"]); code != 0 {
		if _, ok := res["status_code"]; ok {
			return nil, fmt.Errorf("user_declaration/suggestion 失败: %v", res)
		}
	}
	return res, nil
}

// ticketMatchesSession checks that a configured ts_sign belongs to the current
// cookie's login (bd_ticket_guard_ts_sign_id is its prefix).
func (c *Client) ticketMatchesSession() bool {
	if c.TsSign == "" {
		return false
	}
	signID := c.Cookie.Get("bd_ticket_guard_ts_sign_id")
	if signID == "" {
		return true
	}
	return strings.HasPrefix(c.TsSign, signID)
}

// requirePublishSecurity enforces the full create_v2 security material before
// any media is uploaded, matching _require_publish_security.
func (c *Client) requirePublishSecurity() error {
	var missing []string
	if c.Ticket == "" {
		missing = append(missing, "DY_TICKET")
	}
	if c.TsSign == "" {
		missing = append(missing, "DY_TS_SIGN")
	}
	if c.PrivateKey == "" {
		missing = append(missing, "DY_PRIVATE_KEY")
	}
	if len(missing) > 0 {
		return fmt.Errorf("发布安全凭据缺失: %s", strings.Join(missing, ", "))
	}
	if !c.ticketMatchesSession() {
		return errors.New("ticket/ts_sign 与 Cookie 不属于同一次登录，禁止发送 create_v2")
	}
	if c.DtraitBlob == "" {
		return errors.New("缺少可按 create_v2 path 和当前时间重算的 DY_DTRAIT_BLOB；静态 DY_SESSION_DTRAIT 不能用于发布，禁止发送请求")
	}
	return nil
}

// resolveUserID returns the logged-in uid used as TOS X-Storage-U (empty on
// failure, matching _resolve_user_id).
func (c *Client) resolveUserID(ctx context.Context) string {
	uid, err := c.UID(ctx)
	if err != nil {
		return ""
	}
	return strconv.FormatInt(uid, 10)
}

// createAweme POSTs the create_v2 payload with the browser wire header order.
func (c *Client) createAweme(ctx context.Context, item map[string]any, referer string) (map[string]any, error) {
	if err := c.requirePublishSecurity(); err != nil {
		return nil, fmt.Errorf("create_v2 安全校验失败，请求未发送: %w", err)
	}
	if referer == "" {
		referer = postImageReferer
	}

	bd := Headers{}
	if err := bd.WithBD(ctx, c, creatorCreateAPI, creatorReadAID, creatorOrigin, true); err != nil {
		return nil, fmt.Errorf("create_v2 加密头构造失败，请求未发送: %w", err)
	}
	get := func(name string) string {
		v, _ := bd.Get(name)
		return v
	}

	body := creatorJSON(item)
	prof := GetProfile()
	headers := Headers{}
	headers.Set("x-tt-session-dtrait", get("x-tt-session-dtrait"))
	headers.Set("bd-ticket-guard-web-version", get("bd-ticket-guard-web-version"))
	headers.Set("bd-ticket-guard-client-data", get("bd-ticket-guard-client-data"))
	headers.Set("bd-ticket-guard-web-sign-type", get("bd-ticket-guard-web-sign-type"))
	headers.Set("user-agent", prof.UA)
	headers.Set("accept", "application/json, text/plain, */*")
	token := c.CreatorCSRFToken(ctx)
	if token == "" {
		return nil, errors.New("create_v2 缺少 x-secsdk-csrf-token，请求未发送")
	}
	headers.Set("x-secsdk-csrf-token", token)
	headers.Set("content-type", "application/json")
	headers.Set("bd-ticket-guard-ree-public-key", get("bd-ticket-guard-ree-public-key"))
	headers.Set("bd-ticket-guard-version", get("bd-ticket-guard-version"))
	headers.Set("origin", creatorOrigin)
	headers.Set("sec-fetch-site", "same-origin")
	headers.Set("sec-fetch-mode", "cors")
	headers.Set("sec-fetch-dest", "empty")
	headers.Set("referer", referer)
	headers.Set("accept-encoding", "gzip, deflate, br, zstd")
	headers.Set("accept-language", prof.AcceptLanguage)
	headers.Set("priority", "u=1, i")

	cookieValue := c.CreatorCookieStr()
	if cookieValue == "" {
		return nil, errors.New("create_v2 缺少 Cookie，请求未发送")
	}

	p := NewParams()
	p.Add("read_aid", strconv.Itoa(creatorReadAID))
	p.WithCreatorPlatform()
	p.Add("msToken", c.MsToken())
	p.Add("a_bogus", c.Signer.SignQuery(p.SpliceURL(), body, creatorHostName))

	url := BuildURL(creatorBase+creatorCreateAPI, p.ToString())
	resp, err := c.HTTP.Do(ctx, fhttp.MethodPost, url, headers, cookieValue, []byte(body))
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)

	res, err := creatorDecode(resp)
	if err != nil {
		return nil, fmt.Errorf("发布接口返回异常（HTTP %d）。create_v2 为 bd-ticket-guard 强校验接口，"+
			"请确保已配置 DY_TICKET / DY_TS_SIGN / DY_PRIVATE_KEY / DY_DTRAIT_BLOB: %w", resp.StatusCode, err)
	}
	if toInt64(res["status_code"]) == 0 && creatorNonZeroID(res["item_id"]) {
		return res, nil
	}
	msg := creatorMapStr(res, "status_msg")
	if msg == "" {
		msg = fmt.Sprint(res)
	}
	return res, fmt.Errorf("发布失败: %s", msg)
}

// PublishImageContent publishes an image collection (end-to-end).
func (c *Client) PublishImageContent(ctx context.Context, req PublishImageRequest) (map[string]any, error) {
	if err := c.requirePublishSecurity(); err != nil {
		return nil, err
	}
	if len(req.Images) == 0 {
		return nil, errors.New("images 不能为空")
	}

	// 2026-08-23 capture: image-collection ImageX user_id and TOS X-Storage-U are
	// empty (video/cover chains carry the real uid).
	userID := ""
	imageInfos := make([]map[string]any, 0, len(req.Images))
	for _, img := range req.Images {
		sts, err := c.getCreatorUploadAuth(ctx, postImageReferer)
		if err != nil {
			return nil, err
		}
		data, err := creatorReadMediaBytes(ctx, c, img)
		if err != nil {
			return nil, err
		}
		info, err := c.uploadOneImage(ctx, sts, data, userID)
		if err != nil {
			return nil, err
		}
		imageInfos = append(imageInfos, info)
	}

	if req.CreationID == "" {
		req.CreationID = creatorCreationID()
	}
	item, err := BuildImageCreateItem(imageInfos, req)
	if err != nil {
		return nil, err
	}
	return c.createAweme(ctx, item, postImageReferer)
}

// PublishVideoContent publishes a video (end-to-end). The AI cover-generation
// chain (OpenCV/WebCodecs frame extraction) is not ported: the final cover is
// either an explicit Cover or the VOD Snapshot poster.
func (c *Client) PublishVideoContent(ctx context.Context, req PublishVideoRequest) (map[string]any, error) {
	if err := c.requirePublishSecurity(); err != nil {
		return nil, err
	}
	if req.Video == "" {
		return nil, errors.New("video 不能为空")
	}
	if req.UserID == "" {
		req.UserID = c.resolveUserID(ctx)
	}
	if req.CreationID == "" {
		req.CreationID = creatorCreationID()
	}

	// Browser pre-publish fan-out (best-effort enrichment mirrors post_video).
	if _, err := c.GetPreviewVideoList(ctx, ""); err != nil {
		return nil, err
	}
	if _, err := c.GetCoverGenRef(ctx, req.CreationID); err != nil {
		return nil, err
	}
	if _, err := c.GetUserDeclarationSuggestion(ctx, req.CreationID, "video"); err != nil {
		return nil, err
	}

	sts, err := c.GetCreatorUploadAuth(ctx, postVideoReferer)
	if err != nil {
		return nil, err
	}
	source, err := creatorNewMediaSource(ctx, c, req.Video)
	if err != nil {
		return nil, err
	}
	videoNode, err := c.applyVideoUpload(ctx, sts, source.size, req.UserID)
	if err != nil {
		return nil, err
	}
	info, err := c.uploadVideo(ctx, sts, videoNode, source, req.UserID)
	if err != nil {
		return nil, err
	}
	posterURI := creatorMapStr(info, "poster_uri")
	if req.Cover != "" && !strings.HasPrefix(req.Cover, "tos-") {
		commitSTS, err := c.GetCreatorUploadAuth(ctx, postVideoReferer)
		if err != nil {
			return nil, err
		}
		coverData, err := creatorReadMediaBytes(ctx, c, req.Cover)
		if err != nil {
			return nil, err
		}
		coverInfo, err := c.uploadOneImage(ctx, commitSTS, coverData, req.UserID)
		if err != nil {
			return nil, err
		}
		posterURI = creatorMapStr(coverInfo, "uri")
	} else if strings.HasPrefix(req.Cover, "tos-") {
		posterURI = req.Cover
	}

	item, err := BuildVideoCreateItem(info, req, posterURI)
	if err != nil {
		return nil, err
	}
	return c.createAweme(ctx, item, postVideoReferer)
}

// --- create_v2 item builders -------------------------------------------------

// BuildImageCreateItem builds the image create_v2 item (pure, mirrors
// build_image_create_item).
func BuildImageCreateItem(imageInfos []map[string]any, req PublishImageRequest) (map[string]any, error) {
	if len(imageInfos) == 0 {
		return nil, errors.New("image_infos 不能为空")
	}
	vis, err := visibilityValue(req.Visibility)
	if err != nil {
		return nil, err
	}
	if req.CreationID == "" {
		req.CreationID = creatorCreationID()
	}
	text, textExtra := creatorBuildImageText(req.Title, creatorAppendTags(req.Content, req.Tags))

	cover := req.CoverURI
	if cover == "" {
		cover = creatorMapStr(imageInfos[min(max(req.CoverIndex, 0), len(imageInfos)-1)], "uri")
	}

	images := make([]any, 0, len(imageInfos))
	for _, info := range imageInfos {
		images = append(images, map[string]any{
			"uri":    creatorMapStr(info, "uri"),
			"width":  toInt64(info["width"]),
			"height": toInt64(info["height"]),
		})
	}

	common := map[string]any{
		"text":            text,
		"text_extra":      creatorJSON(textExtra),
		"activity":        creatorJSON(creatorOrEmptySlice(req.Activity)),
		"challenges":      creatorJSON(creatorOrEmptySlice(req.Challenges)),
		"hashtag_source":  "",
		"mentions":        creatorJSON(creatorOrEmptySlice(req.Mentions)),
		"visibility_type": vis,
		"download":        downloadValue(req.AllowDownload),
		"timing":          imageTiming(req.Timing),
		"media_type":      2,
		"images":          images,
		"creation_id":     req.CreationID,
	}
	if req.MixID != "" {
		common["mix_id"] = req.MixID
	}
	if len(req.POI) > 0 {
		common["poi_id"] = creatorMapStr(req.POI, "poi_id")
		common["poi_name"] = creatorMapStr(req.POI, "poi_name")
	}
	if len(req.HotSpot) > 0 {
		common["hot_sentence"] = creatorMapStr(req.HotSpot, "word")
	}
	anchor := map[string]any{}
	if len(req.POI) > 0 {
		anchor["poi"] = req.POI
	}
	return map[string]any{"item": map[string]any{
		"common": common,
		"cover":  map[string]any{"poster": cover},
		"anchor": anchor,
	}}, nil
}

// BuildVideoCreateItem builds the video create_v2 item (pure, mirrors
// build_video_create_item). posterURI is the resolved cover uri.
func BuildVideoCreateItem(info map[string]any, req PublishVideoRequest, posterURI string) (map[string]any, error) {
	vis, err := visibilityValue(req.Visibility)
	if err != nil {
		return nil, err
	}
	if req.CreationID == "" {
		req.CreationID = creatorCreationID()
	}
	parts := creatorBuildVideoText(req.Title, creatorAppendTags(req.Content, req.Tags))

	common := map[string]any{
		"text":                 parts.text,
		"caption":              parts.caption,
		"item_title":           parts.itemTitle,
		"activity":             creatorJSON(creatorOrEmptySlice(req.Activity)),
		"text_extra":           creatorJSON([]any{}),
		"challenges":           creatorJSON(creatorOrEmptySlice(req.Challenges)),
		"mentions":             creatorJSON(creatorOrEmptySlice(req.Mentions)),
		"hashtag_source":       "",
		"hot_sentence":         creatorMapStr(req.HotSpot, "word"),
		"interaction_stickers": "[]",
		"visibility_type":      vis,
		"download":             downloadValue(req.AllowDownload),
		"timing":               videoTiming(req.Timing),
		"creation_id":          req.CreationID,
		"media_type":           4,
		"video_id":             creatorMapStr(info, "vid"),
		"music_source":         0,
		"music_id":             nil,
	}
	if req.MixID != "" {
		common["mix_id"] = req.MixID
	}
	if len(req.POI) > 0 {
		common["poi_id"] = creatorMapStr(req.POI, "poi_id")
		common["poi_name"] = creatorMapStr(req.POI, "poi_name")
	}
	if posterURI == "" {
		posterURI = creatorMapStr(info, "poster_uri")
	}
	anchor := map[string]any{}
	if len(req.POI) > 0 {
		anchor["poi"] = req.POI
	}
	cover := map[string]any{
		"cover_text_uri":          nil,
		"cover_text":              nil,
		"poster":                  posterURI,
		"poster_delay":            int64(req.CoverDelay),
		"cover_tools_extend_info": creatorJSON(creatorCoverToolsExtendInfo(posterURI, "", "", "", nil, nil)),
		"cover_tools_info":        creatorJSON(map[string]any{}),
	}
	return map[string]any{"item": map[string]any{
		"common":          common,
		"cover":           cover,
		"mix":             map[string]any{},
		"selected_member": map[string]any{"is_selected_member_video": false},
		"chapter":         map[string]any{"chapter": creatorJSON(creatorEmptyChapter())},
		"anchor":          anchor,
		"sync":            map[string]any{"should_sync": false, "sync_to_toutiao": 0},
		"open_platform":   map[string]any{},
		"assistant":       map[string]any{"is_preview": 0, "is_post_assistant": 1},
	}}, nil
}

// creatorCoverToolsExtendInfo mirrors build_video_cover_tools_extend_info.
func creatorCoverToolsExtendInfo(posterURI, videoName, coverURL, aiURI string, recommendFrames []map[string]any, previewVideoList []any) map[string]any {
	coverList := make([]any, 0, len(recommendFrames))
	for index, frame := range recommendFrames {
		value := frame["time"]
		if f, ok := value.(float64); ok && f == float64(int64(f)) {
			value = int64(f)
		}
		previewBlob := creatorFirstNonEmpty(creatorMapStr(frame, "previewBlobSrc"), creatorMapStr(frame, "preview_blob_src"), creatorBlobURL())
		sourceBlob := creatorFirstNonEmpty(creatorMapStr(frame, "src"), creatorBlobURL())
		isAI := false
		if b, ok := frame["isAIGen"].(bool); ok {
			isAI = b
		} else if index == 0 && aiURI != "" {
			isAI = true
		}
		uri1 := creatorMapStr(frame, "uri1")
		if uri1 == "" {
			if isAI {
				uri1 = aiURI
			} else {
				uri1 = "NOT_READY"
			}
		}
		cropBox := frame["cropBox"]
		if cropBox == nil {
			cropBox = frame["crop_box"]
		}
		if cropBox == nil {
			cropBox = []any{0, 0, 0.75, 1}
		}
		cropBox2 := frame["cropBox2"]
		if cropBox2 == nil {
			cropBox2 = frame["crop_box2"]
		}
		if cropBox2 == nil {
			cropBox2 = []any{0.08695652335882187, 0, 0.508695662021637, 1}
		}
		coverList = append(coverList, map[string]any{
			"id":             creatorFirstNonEmpty(creatorMapStr(frame, "id"), creatorFrontendUUID()),
			"time":           value,
			"uri":            creatorFirstNonEmpty(creatorMapStr(frame, "uri"), "NOT_READY"),
			"frameIndex":     creatorFrameInt(frame, "frameIndex", creatorFrameInt(frame, "frame_index", int64(index))),
			"previewBlobSrc": previewBlob,
			"cropHeight":     creatorFrameInt(frame, "cropHeight", creatorFrameInt(frame, "crop_height", 360)),
			"cropWidth":      creatorFrameInt(frame, "cropWidth", creatorFrameInt(frame, "crop_width", 480)),
			"cropBox":        cropBox,
			"cropBox2":       cropBox2,
			"src":            sourceBlob,
			"rawBlob":        map[string]any{},
			"fileName":       creatorFirstNonEmpty(creatorMapStr(frame, "fileName"), creatorMapStr(frame, "file_name"), videoName),
			"isAIGen":        isAI,
			"uri1":           uri1,
		})
	}
	return map[string]any{
		"recommendServerInfo": map[string]any{"res": []any{}, "times": []any{}},
		"recommendCoverList":  coverList,
		"recommendCoverInfo": map[string]any{
			"isFromRecommend": len(coverList) > 0, "isDefaultSelect": false,
			"isRecommendClickFrom": "", "selectInfo": map[string]any{}, "editingInfo": map[string]any{},
		},
		"recommendCoverTime": 0,
		"coverInfo": map[string]any{
			"firstFrameCoverUri": posterURI, "videoName": videoName,
			"uri": posterURI, "url": coverURL, "posterDelay": 0,
		},
		"coverUrl":                  coverURL,
		"coverHorizontalInfo":       nil,
		"coverHorizontalUrl":        "",
		"pasterInfo":                nil,
		"stateInfo":                 nil,
		"croppedCoverInfo":          nil,
		"uploadBackgroundInfo":      nil,
		"uploadPasterInfo":          nil,
		"uploadCoverStateInfo":      nil,
		"xiguaCoverInfo":            map[string]any{"posterDelay": 0},
		"xiguaPasterInfo":           nil,
		"xiguaStateInfo":            nil,
		"xiguaUploadCoverStateInfo": nil,
		"xiguaUploadBackgroundInfo": nil,
		"xiguaUploadPasterInfo":     nil,
		"editXigua":                 false,
		"coverSource":               "",
		"previewVideoList":          creatorOrEmptySlice(previewVideoList),
	}
}

func creatorEmptyChapter() map[string]any {
	return map[string]any{
		"chapter_abstract": "",
		"chapter_details":  []any{},
		"chapter_type":     1,
		"chapter_tools_info": map[string]any{
			"chapter_recommend_detail":   []any{},
			"chapter_recommend_abstract": "",
			"chapter_source":             2,
			"chapter_recommend_type":     -2,
			"create_date":                nowUnix(),
			"is_pc":                      "1",
			"is_pre_generated":           "0",
			"is_syn":                     "1",
		},
	}
}

// --- text helpers ------------------------------------------------------------

func creatorBuildImageText(title, desc string) (string, []any) {
	var sb strings.Builder
	extra := []any{}
	if title != "" {
		sb.WriteString(title)
		extra = append(extra, map[string]any{
			"start": 0, "end": creatorJSLen(title), "hashtag_id": 0, "hashtag_name": "", "type": 7,
		})
	}
	if desc != "" {
		if sb.Len() > 0 {
			sepStart := creatorJSLen(sb.String())
			sb.WriteString("。")
			extra = append(extra, map[string]any{
				"start": sepStart, "end": sepStart + 1, "hashtag_id": 0, "hashtag_name": "", "type": 8,
			})
		}
		sb.WriteString(desc)
	}
	return sb.String(), extra
}

type creatorVideoText struct {
	text      string
	itemTitle string
	caption   string
}

func creatorBuildVideoText(title, desc string) creatorVideoText {
	title = strings.TrimSpace(title)
	desc = strings.TrimSpace(desc)
	text := desc
	if title != "" {
		text = title + " " + desc
	}
	return creatorVideoText{text: text, itemTitle: title, caption: desc}
}

// creatorJSLen is JavaScript String.length (UTF-16 code units).
func creatorJSLen(s string) int { return len(utf16.Encode([]rune(s))) }

func creatorAppendTags(content string, tags []string) string {
	extra := make([]string, 0, len(tags))
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "#") {
			extra = append(extra, t)
		} else {
			extra = append(extra, "#"+t)
		}
	}
	if len(extra) == 0 {
		return content
	}
	if strings.TrimSpace(content) == "" {
		return strings.Join(extra, " ")
	}
	return content + " " + strings.Join(extra, " ")
}

// --- value helpers -----------------------------------------------------------

func visibilityValue(v string) (int64, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 1, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("visibility 必须是 0/1/2: %q", v)
	}
	return n, nil
}

func downloadValue(v *bool) int64 {
	if v == nil || *v {
		return 1
	}
	return 0
}

func imageTiming(v int64) int64 {
	if v == 0 {
		return -1
	}
	return v
}

func videoTiming(v int64) int64 { return v }

func creatorOrEmptySlice(v []any) []any {
	if v == nil {
		return []any{}
	}
	return v
}

func creatorFirstURL(v any) string {
	list, _ := v.([]any)
	for _, item := range list {
		if s := fmt.Sprint(item); s != "" && s != "<nil>" {
			return s
		}
	}
	return ""
}

func creatorMapStr(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

func creatorFirstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func creatorNonZeroID(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != "" && t != "0"
	case float64:
		return t != 0
	case int64:
		return t != 0
	case int:
		return t != 0
	default:
		s := fmt.Sprint(v)
		return s != "" && s != "0" && s != "<nil>"
	}
}

func creatorFrameInt(frame map[string]any, key string, def int64) int64 {
	if v, ok := frame[key]; ok && v != nil {
		return toInt64(v)
	}
	return def
}

func creatorCreationID() string {
	return creatorRandAlphaNum(8) + strconv.FormatInt(GenerateMillisecond(), 10)
}

func creatorBlobURL() string { return "blob:" + creatorOrigin + "/" + creatorUUID() }

func creatorFrontendUUID() string {
	const hexDigits = "0123456789abcdef"
	var sb strings.Builder
	for range 8 {
		chunk := make([]byte, 0, 4)
		for range 4 {
			chunk = append(chunk, hexDigits[creatorRandInt(16)])
		}
		sb.Write(chunk)
	}
	return sb.String()
}

func creatorRandInt(n int) int {
	var b [1]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0
	}
	return int(b[0]) % n
}

func creatorRandAlphaNum(n int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	var sb strings.Builder
	for range n {
		sb.WriteByte(alphabet[creatorRandInt(len(alphabet))])
	}
	return sb.String()
}
