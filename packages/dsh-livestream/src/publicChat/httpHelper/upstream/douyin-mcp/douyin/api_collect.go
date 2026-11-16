package douyin

// Collection / favorite endpoints: favorite list, collect, move, remove and
// collect list.

import (
	"context"
)

// duCSRFHeader adds x-secsdk-csrf-token fetched from the site (write APIs).
func (c *Client) duCSRFHeader(ctx context.Context, h *Headers) {
	if tok := c.CSRFToken(ctx, douyinBase, "/service/2/abtest_config/"); tok != "" {
		h.Set("x-secsdk-csrf-token", tok)
	}
}

// duDtraitHeader adds x-tt-session-dtrait when device material is configured.
func (c *Client) duDtraitHeader(h *Headers, api string) {
	if dt, err := c.SessionDtraitHeader(api, 6383, douyinBase, false); err == nil && dt != "" {
		h.Set("x-tt-session-dtrait", dt)
	}
}

// GetUserFavorite returns one page of a user's favorites
// (`/aweme/v1/web/aweme/favorite/`, signed URL, no msToken).
func (c *Client) GetUserFavorite(ctx context.Context, secID, maxCursor, num string) (map[string]any, error) {
	const api = "/aweme/v1/web/aweme/favorite/"
	refer := douyinBase + "/user/" + secID + "?showTab=like"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)
	// 实录 headers_wire 里这个接口带 bd-ticket-guard 全套.
	headers.WithBDReadonly(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("sec_user_id", secID)
	p.Add("max_cursor", maxCursor)
	p.Add("min_cursor", "0")
	p.Add("whale_cut_token", "")
	p.Add("cut_version", "1")
	p.Add("count", num)
	p.Add("publish_video_strategy_type", "2")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	// 当前 PC 版在 verifyFp 之后发 msToken，再算 a_bogus.
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.GetJSONSigned(ctx, douyinBase+api, p, headers)
}

// GetCollectList returns the logged-in user's collections
// (`/aweme/v1/web/collects/list/`, signed URL).
func (c *Client) GetCollectList(ctx context.Context) (map[string]any, error) {
	const api = "/aweme/v1/web/collects/list/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderGET)
	headers.WithUIFID(c)
	headers.SetReferer(refer)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("cursor", "0")
	p.Add("count", "20")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.GetJSONSigned(ctx, douyinBase+api, p, headers)
}

// CollectAweme collects or uncollects a work
// (`/aweme/v1/web/aweme/collect/`, action 1 = collect, 0 = uncollect).
func (c *Client) CollectAweme(ctx context.Context, awemeID, action string) (map[string]any, error) {
	const api = "/aweme/v1/web/aweme/collect/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)
	headers.WithBDReadonly(c)
	// 实录里 collect 接口没有 x-tt-session-dtrait（digg 才有）.
	c.duCSRFHeader(ctx, &headers)
	headers.WithUIFID(c)
	headers.Set("origin", douyinBase)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("pc_client_type", "1")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())

	data := NewParams()
	data.Add("action", action)
	data.Add("aweme_id", awemeID)
	data.Add("aweme_type", "0")
	p.WithABogus(c, data)
	// 实录 query 末尾还有 uid = md5(登录用户数字 ID)，不参与签名.
	p.Add("uid", c.CommentUID(ctx))

	return c.duPostFormJSON(ctx, douyinBase+api, p, headers, data)
}

// MoveCollectAweme moves a work into a collection
// (`/aweme/v1/web/collects/video/move/`); the work must already be collected.
func (c *Client) MoveCollectAweme(ctx context.Context, awemeID, collectName, collectID string) (map[string]any, error) {
	const api = "/aweme/v1/web/collects/video/move/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)
	headers.WithBDReadonly(c)
	// 实录 digg 带 x-tt-session-dtrait（写接口的风控头）.
	c.duDtraitHeader(&headers, api)
	c.duCSRFHeader(ctx, &headers)
	headers.WithUIFID(c)
	headers.Set("origin", douyinBase)

	prof := GetProfile()
	p := NewParams()
	p.Add("aid", "6383")
	p.Add("browser_language", "zh-CN")
	p.Add("browser_name", prof.BrowserName)
	p.Add("browser_online", "true")
	p.Add("browser_platform", prof.Platform)
	p.Add("browser_version", prof.BrowserVersion)
	p.Add("channel", "channel_pc_web")
	p.Add("collects_name", collectName)
	p.Add("cookie_enabled", "true")
	p.Add("cpu_core_num", prof.CpuCoreNum)
	p.Add("device_memory", prof.DeviceMemory)
	p.Add("device_platform", "webapp")
	p.Add("downlink", "10")
	p.Add("effective_type", "4g")
	p.Add("engine_name", "Blink")
	p.Add("engine_version", prof.EngineVersion)
	p.Add("item_ids", awemeID)
	p.Add("item_type", "2")
	p.Add("move_collects_list", collectID)
	p.Add("os_name", "Windows")
	p.Add("os_version", prof.OSVersion)
	p.Add("pc_client_type", "1")
	p.Add("platform", "PC")
	p.Add("round_trip_time", "50")
	p.Add("screen_height", prof.ScreenHeight)
	p.Add("screen_width", prof.ScreenWidth)
	p.Add("to_collects_id", collectID)
	p.Add("update_collects_sort", "true")
	p.Add("update_version_code", "170400")
	p.Add("version_code", "170400")
	p.Add("version_name", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)

	return c.duPostFormJSON(ctx, douyinBase+api, p, headers, nil)
}

// RemoveCollectAweme removes a work from a collection
// (`/aweme/v1/web/collects/video/move/`).
func (c *Client) RemoveCollectAweme(ctx context.Context, awemeID, collectName, collectID string) (map[string]any, error) {
	const api = "/aweme/v1/web/collects/video/move/"
	refer := douyinBase + "/user/self?showTab=favorite_collection"
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)
	headers.WithBDReadonly(c)
	c.duCSRFHeader(ctx, &headers)
	headers.WithUIFID(c)
	headers.Set("origin", douyinBase)

	prof := GetProfile()
	p := NewParams()
	p.Add("aid", "6383")
	p.Add("browser_language", "zh-CN")
	p.Add("browser_name", prof.BrowserName)
	p.Add("browser_online", "true")
	p.Add("browser_platform", prof.Platform)
	p.Add("browser_version", prof.BrowserVersion)
	p.Add("channel", "channel_pc_web")
	p.Add("collects_name", collectName)
	p.Add("cookie_enabled", "true")
	p.Add("cpu_core_num", prof.CpuCoreNum)
	p.Add("device_memory", prof.DeviceMemory)
	p.Add("device_platform", "webapp")
	p.Add("downlink", "10")
	p.Add("effective_type", "4g")
	p.Add("engine_name", "Blink")
	p.Add("engine_version", prof.EngineVersion)
	p.Add("from_collects_id", collectID)
	p.Add("item_ids", awemeID)
	p.Add("item_type", "2")
	p.Add("os_name", "Windows")
	p.Add("os_version", prof.OSVersion)
	p.Add("pc_client_type", "1")
	p.Add("platform", "PC")
	p.Add("round_trip_time", "50")
	p.Add("screen_height", prof.ScreenHeight)
	p.Add("screen_width", prof.ScreenWidth)
	p.Add("update_version_code", "170400")
	p.Add("version_code", "170400")
	p.Add("version_name", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)

	return c.duPostFormJSON(ctx, douyinBase+api, p, headers, nil)
}
