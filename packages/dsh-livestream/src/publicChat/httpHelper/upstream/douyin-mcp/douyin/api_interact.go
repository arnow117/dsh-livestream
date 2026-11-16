package douyin

// Interaction write endpoints: digg and publish comment (抖音 Web 端).

import (
	"context"
	"fmt"
	"strings"
)

// Digg likes or unlikes a work (`/aweme/v1/web/commit/item/digg/`,
// digg_type 1 = like, 0 = unlike). It returns status_code == 0, not the
// response's is_digg (which is the pre-action state).
func (c *Client) Digg(ctx context.Context, awemeID, diggType string) (bool, error) {
	const api = "/aweme/v1/web/commit/item/digg/"
	if strings.Contains(awemeID, "://") {
		parsed, _, err := ParseAwemeID(awemeID)
		if err != nil {
			return false, err
		}
		awemeID = parsed
	}
	refer := douyinBase + "/discover?modal_id=" + awemeID
	headers := BuildHeaders(HeaderFORM)
	// 实录：digg 不带 Host，bd 是只读 4 个头，带 x-tt-session-dtrait.
	headers.WithBDReadonly(c)
	c.duDtraitHeader(&headers, api)
	c.duCSRFHeader(ctx, &headers)
	headers.WithUIFID(c)
	headers.Set("origin", douyinBase)
	headers.Set("referer", refer)

	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	// 实录 query 末尾还有 uid = md5(登录用户数字 ID).
	p.Add("uid", c.CommentUID(ctx))

	data := NewParams()
	data.Add("aweme_id", awemeID)
	data.Add("item_type", "0")
	data.Add("type", diggType)

	resp, err := c.HTTP.PostJSON(ctx, BuildURL(douyinBase+api, standardEncodeQuery(p)), headers, c.CookieStr(), "", []byte(standardEncodeQuery(data)))
	if err != nil {
		return false, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return false, err
	}
	res, err := decodeJSONObject(resp.Body)
	if err != nil {
		return false, err
	}
	return toInt64(res["status_code"]) == 0, nil
}

// CommentOpts carries the endpoint's optional fields. Zero values are
// meaningful for the time/rank counters, so callers that want the defaults
// should build the struct explicitly (PublishComment does). PasteEditMethod ""
// means "non_paste"; TextExtra nil means "[]".
type CommentOpts struct {
	ReplyToReplyID       string
	CommentSendCelltime  int
	CommentVideoCelltime int
	OneLevelCommentRank  int
	PasteEditMethod      string
	TextExtra            any
}

// PublishComment publishes a top-level comment or a reply.
func (c *Client) PublishComment(ctx context.Context, awemeID, content, replyID string) (map[string]any, error) {
	return c.PublishCommentWithOpts(ctx, awemeID, content, replyID, CommentOpts{OneLevelCommentRank: -1})
}

// PublishCommentWithOpts is PublishComment with the full optional-field
// surface.
func (c *Client) PublishCommentWithOpts(ctx context.Context, awemeID, content, replyID string, opts CommentOpts) (map[string]any, error) {
	const api = "/aweme/v1/web/comment/publish"
	// 评论发布是 bd-ticket-guard 的强校验写接口.
	if err := c.publishCredentialsOK(); err != nil {
		return nil, err
	}
	// 传链接进来时先解析成数字 ID，否则服务端返回 status_code=5.
	if strings.Contains(awemeID, "://") {
		parsed, _, err := ParseAwemeID(awemeID)
		if err != nil {
			return nil, err
		}
		awemeID = parsed
	}
	refer := douyinBase + "/video/" + awemeID
	headers := BuildHeaders(HeaderFORM)
	headers.Set("origin", douyinBase)
	headers.SetReferer(refer)
	if err := headers.WithBD(ctx, c, api, 6383, douyinBase, false); err != nil {
		return nil, err
	}
	c.duCSRFHeader(ctx, &headers)
	// uifid 既在 query 也在头里，取自 UIFID Cookie.
	uifid := c.Cookie.Get("UIFID")
	if uifid != "" {
		headers.Set("uifid", uifid)
	}

	p := NewParams()
	p.Add("app_name", "aweme")
	p.Add("enter_from", "video_detail")
	p.Add("previous_page", "video_detail")
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("pc_client_type", "1")
	p.Add("pc_libra_divert", "Windows")
	p.Add("update_version_code", "170400")
	p.Add("support_h265", "1")
	p.Add("support_dash", "1")
	p.Add("version_code", "170400")
	p.Add("version_name", "17.4.0")
	p.Add("cookie_enabled", "true")
	p.Add("screen_width", GetProfile().ScreenWidth)
	p.Add("screen_height", GetProfile().ScreenHeight)
	p.Add("browser_language", "zh-CN")
	p.Add("browser_platform", "Win32")
	p.Add("browser_name", GetProfile().BrowserName)
	p.Add("browser_version", GetProfile().BrowserVersion)
	p.Add("browser_online", "true")
	p.Add("engine_name", "Blink")
	p.Add("engine_version", GetProfile().EngineVersion)
	p.Add("os_name", "Windows")
	p.Add("os_version", "10")
	p.Add("cpu_core_num", GetProfile().CpuCoreNum)
	p.Add("device_memory", GetProfile().DeviceMemory)
	p.Add("platform", "PC")
	p.Add("downlink", "10")
	p.Add("effective_type", "4g")
	p.Add("round_trip_time", "50")
	p.WithWebID(ctx, c, refer)
	if uifid != "" {
		p.Add("uifid", uifid)
	}
	p.Add("verifyFp", c.Cookie.Get("s_v_web_id"))
	p.Add("fp", c.Cookie.Get("s_v_web_id"))
	p.Add("msToken", c.MsToken())

	data := NewParams()
	data.Add("aweme_id", awemeID)
	if replyID != "" {
		data.Add("reply_id", replyID)
	}
	if opts.ReplyToReplyID != "" {
		data.Add("reply_to_reply_id", opts.ReplyToReplyID)
	}
	data.Add("comment_send_celltime", fmt.Sprintf("%d", opts.CommentSendCelltime))
	data.Add("comment_video_celltime", fmt.Sprintf("%d", opts.CommentVideoCelltime))
	data.Add("one_level_comment_rank", fmt.Sprintf("%d", opts.OneLevelCommentRank))
	paste := opts.PasteEditMethod
	if paste == "" {
		paste = "non_paste"
	}
	data.Add("paste_edit_method", paste)
	data.Add("text", content)
	textExtra := opts.TextExtra
	if textExtra == nil {
		textExtra = []any{}
	}
	data.Add("text_extra", duCompactJSON(textExtra))

	p.WithABogus(c, data)
	// uid 在 a_bogus 之后追加，不参与签名.
	if uid := c.CommentUID(ctx); uid != "" {
		p.Add("uid", uid)
	}
	return c.duPostFormJSON(ctx, douyinBase+api, p, headers, data)
}

// publishCredentialsOK enforces the endpoint's guards: the ticket/ts_sign must
// belong to the current cookie session and device-trait material must be
// present, otherwise the server rejects with an opaque error.
func (c *Client) publishCredentialsOK() error {
	if c.Ticket == "" || c.TsSign == "" {
		return fmt.Errorf("评论发布需要与当前 Cookie 同会话的 ticket/ts_sign；请重新导出配套浏览器凭据，不能混用旧 .env。")
	}
	if signID := c.Cookie.Get("bd_ticket_guard_ts_sign_id"); signID != "" && !strings.HasPrefix(c.TsSign, signID) {
		return fmt.Errorf("评论发布需要与当前 Cookie 同会话的 ticket/ts_sign；请重新导出配套浏览器凭据，不能混用旧 .env。")
	}
	if c.DtraitBlob == "" && c.SessionDtrait == "" {
		return fmt.Errorf("评论发布需要同一浏览器会话的 dtrait_blob/profile 或 session_dtrait；只提供 Cookie 会被风控拦截。")
	}
	return nil
}
