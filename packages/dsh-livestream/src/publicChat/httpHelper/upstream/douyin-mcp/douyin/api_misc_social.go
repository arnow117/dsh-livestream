package douyin

// 关注 / 朋友 tab 的 feed 与行为上报接口（PC 版，2026-10 实测）。
//
//	关注 feed      GET  /aweme/v1/web/follow/feed/
//	朋友 feed      POST /aweme/v1/web/familiar/feed/
//	朋友推荐       GET  /aweme/v1/web/familiar/recommend/feed/
//	关注页直播顶  POST /webcast/feed/follow_top/
//	关注页直播流  GET  /webcast/web/feed/follow/
//	历史写入       POST /aweme/v1/web/history/write/
//	作品统计上报   POST /aweme/v2/web/aweme/stats/
//	关注已读标记   GET  /aweme/v1/following/list/item/seen/
//	弹幕拉取       GET  /aweme/v1/web/danmaku/get_v2/
//	弹幕配置       GET  /aweme/v1/web/danmaku/conf/get/
//	系列观看上报   POST /aweme/v1/web/series/watch/record/
//
// 请求/参数以 local://dy-gap-spec.md 的浏览器抓包为准。

import (
	"context"
	"fmt"
)

// GetFollowFeed 拉取「关注」tab 的视频流（GET /aweme/v1/web/follow/feed/，来源：关注 tab）。
func (c *Client) GetFollowFeed(ctx context.Context, cursor, count string) (map[string]any, error) {
	const api = "/aweme/v1/web/follow/feed/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if cursor == "" {
		cursor = "0"
	}
	if count == "" {
		count = "20"
	}
	p := NewParams()
	p.Add("cursor", cursor)
	p.Add("level", "1")
	p.Add("count", count)
	p.Add("pull_type", "0")
	p.Add("aweme_ids", "")
	p.Add("room_ids", "")
	p.Add("webcast_sdk_version", "170400")
	p.Add("webcast_version_code", "170400")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetFamiliarFeed 拉取「朋友」tab 的视频流（POST /aweme/v1/web/familiar/feed/，来源：朋友 tab）。
func (c *Client) GetFamiliarFeed(ctx context.Context, cursor, count string) (map[string]any, error) {
	const api = "/aweme/v1/web/familiar/feed/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if cursor == "" {
		cursor = "0"
	}
	if count == "" {
		count = "20"
	}
	p := NewParams()
	p.Add("level", "1")
	p.Add("cursor", cursor)
	p.Add("aweme_ids", "")
	p.Add("room_ids", "")
	p.Add("pull_type", "0")
	p.Add("address_book_access", "2")
	p.Add("gps_access", "2")
	p.Add("recent_gids", "")
	p.Add("count", count)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duPostFormJSON(ctx, douyinBase+api, p, headers, nil)
}

// GetFamiliarRecommendFeed 拉取「朋友」推荐卡片（GET /aweme/v1/web/familiar/recommend/feed/）。
// secUserID 留空时取当前登录用户。
func (c *Client) GetFamiliarRecommendFeed(ctx context.Context, secUserID, maxCursor, minCursor, count string) (map[string]any, error) {
	const api = "/aweme/v1/web/familiar/recommend/feed/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if secUserID == "" {
		sec, err := c.SecUID(ctx)
		if err != nil {
			return nil, fmt.Errorf("获取当前用户 sec_user_id 失败: %w", err)
		}
		secUserID = sec
	}
	if maxCursor == "" {
		maxCursor = "0"
	}
	if minCursor == "" {
		minCursor = "0"
	}
	if count == "" {
		count = "18"
	}
	p := NewParams()
	p.Add("sec_user_id", secUserID)
	p.Add("max_cursor", maxCursor)
	p.Add("min_cursor", minCursor)
	p.Add("count", count)
	p.Add("from", "1")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetFollowLiveTop 拉取「关注」页顶部直播卡片（POST /webcast/feed/follow_top/，来源：关注 tab）。
// body 为浏览器实录的固定字段。
func (c *Client) GetFollowLiveTop(ctx context.Context) (map[string]any, error) {
	const api = "/webcast/feed/follow_top/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())

	body := NewParams()
	body.Add("enter_source", "homepage_pc_followtop")
	body.Add("follow_session_id", "0")
	body.Add("need_map", "1")
	body.Add("need_pinned_info", "0")
	body.Add("source_key", "web_homepage_follow_top")

	p.WithABogus(c, body)
	return c.duPostFormJSON(ctx, douyinBase+api, p, headers, body)
}

// GetFollowLiveFeed 拉取「关注」页直播流（GET /webcast/web/feed/follow/，来源：关注 tab）。
func (c *Client) GetFollowLiveFeed(ctx context.Context, scene string) (map[string]any, error) {
	const api = "/webcast/web/feed/follow/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if scene == "" {
		scene = "aweme_pc_follow_top"
	}
	p := NewParams()
	p.Add("scene", scene)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// ReportHistoryWrite 上报一次「观看历史」写入（POST /aweme/v1/web/history/write/）。
func (c *Client) ReportHistoryWrite(ctx context.Context, authorID, awemeID string) (map[string]any, error) {
	if awemeID == "" {
		return nil, fmt.Errorf("aweme_id 不能为空")
	}
	const api = "/aweme/v1/web/history/write/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)
	headers.WithUIFID(c)
	headers.WithBDReadonly(c)

	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())

	body := NewParams()
	body.Add("author_id", authorID)
	body.Add("aweme_id", awemeID)

	p.WithABogus(c, body)
	return c.duPostFormJSON(ctx, douyinHJBase+api, p, headers, body)
}

// ReportAwemeStats 上报作品播放统计（POST /aweme/v2/web/aweme/stats/）。
func (c *Client) ReportAwemeStats(ctx context.Context, itemID, awemeType, playDelta, source string) (map[string]any, error) {
	if itemID == "" {
		return nil, fmt.Errorf("item_id 不能为空")
	}
	if awemeType == "" {
		awemeType = "0"
	}
	if playDelta == "" {
		playDelta = "1"
	}
	if source == "" {
		source = "0"
	}
	const api = "/aweme/v2/web/aweme/stats/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)
	headers.WithUIFID(c)
	headers.WithBDReadonly(c)

	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())

	body := NewParams()
	body.Add("aweme_type", awemeType)
	body.Add("item_id", itemID)
	body.Add("play_delta", playDelta)
	body.Add("source", source)

	p.WithABogus(c, body)
	return c.duPostFormJSON(ctx, douyinHJBase+api, p, headers, body)
}

// MarkFollowingSeen 标记关注流中已看过的作品（GET /aweme/v1/following/list/item/seen/）。
func (c *Client) MarkFollowingSeen(ctx context.Context, itemIDList, typ string) (map[string]any, error) {
	if itemIDList == "" {
		return nil, fmt.Errorf("item_id_list 不能为空")
	}
	if typ == "" {
		typ = "1"
	}
	const api = "/aweme/v1/following/list/item/seen/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("item_id_list", itemIDList)
	p.Add("type", typ)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinHJBase+api, p, headers)
}

// GetDanmaku 拉取某作品某时间段的弹幕（GET /aweme/v1/web/danmaku/get_v2/）。
// authentication_token 来自 GetDanmakuConf 或视频详情响应。
func (c *Client) GetDanmaku(ctx context.Context, itemID, startTime, endTime, duration, authToken string) (map[string]any, error) {
	if itemID == "" {
		return nil, fmt.Errorf("item_id 不能为空")
	}
	if startTime == "" {
		startTime = "0"
	}
	const api = "/aweme/v1/web/danmaku/get_v2/"
	refer := douyinBase + "/video/" + itemID
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("app_name", "aweme")
	p.Add("format", "json")
	p.Add("group_id", itemID)
	p.Add("item_id", itemID)
	p.Add("start_time", startTime)
	p.Add("end_time", endTime)
	p.Add("authentication_token", authToken)
	p.Add("duration", duration)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinHJBase+api, p, headers)
}

// GetDanmakuConf 获取弹幕鉴权配置（GET /aweme/v1/web/danmaku/conf/get/），
// 返回体里的 token 可作为 GetDanmaku 的 authentication_token。
func (c *Client) GetDanmakuConf(ctx context.Context, hardwareConcurrency string) (map[string]any, error) {
	if hardwareConcurrency == "" {
		hardwareConcurrency = "10"
	}
	const api = "/aweme/v1/web/danmaku/conf/get/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("conf_end_type", "4")
	p.Add("hardware_concurrency", hardwareConcurrency)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinHJBase+api, p, headers)
}

// ReportSeriesWatch 上报「系列/合集」观看进度（GET /aweme/v1/web/series/watch/record/）。
// 参数取自 douyin-pc-web 前端源码（client-entry bundle）中的调用点：
// U2("/aweme/v1/web/series/watch/record/", {episode, series_id, item_id})，
// 并在已登录浏览器上抓到了真实请求：episode=1&series_id=..&item_id=..（GET）。
func (c *Client) ReportSeriesWatch(ctx context.Context, itemID, seriesID, episode string) (map[string]any, error) {
	if itemID == "" {
		return nil, fmt.Errorf("item_id 不能为空")
	}
	if episode == "" {
		episode = "1"
	}
	const api = "/aweme/v1/web/series/watch/record/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("episode", episode)
	p.Add("series_id", seriesID)
	p.Add("item_id", itemID)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}
