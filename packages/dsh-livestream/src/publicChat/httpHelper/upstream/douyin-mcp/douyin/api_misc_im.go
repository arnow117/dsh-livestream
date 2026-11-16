package douyin

// 抖音 PC 消息面板（私信 IM）相关接口，来自已登录浏览器的实测抓包：
//
//	消息 tab（好友/在线状态）
//	  GET  www-hj.douyin.com/aweme/v1/web/im/spotlight/relation/      关系/好友列表
//	  POST www-hj.douyin.com/aweme/v1/web/im/user/active/status/      批量在线状态
//	  GET  www-hj.douyin.com/aweme/v1/web/im/user/active/update/      在线心跳上报
//	  GET  www-hj.douyin.com/aweme/v1/web/im/user/active/config/get   在线状态配置
//	消息 tab（资源/策略）
//	  GET  www.douyin.com/aweme/v1/web/im/strategy/config             策略配置
//	  GET  www-hj.douyin.com/aweme/v1/web/im/resource/list/aggregation/ 资源聚合（表情等）
//	  GET  www.douyin.com/aweme/v1/web/im/resources/emoticon/trending  热门表情
//	  POST www.douyin.com/aweme/v1/web/im/get/online_feedback/entrance/ 在线反馈入口
//	消息 tab（协议层）
//	  POST imapi.douyin.com/v1/message/get_user_message               IM 增量拉消息（protobuf, cmd 2048）
//
// www-hj.douyin.com 的 IM 接口沿用仓库既有约定（GetWatchLater / IMUserInfo）：
// 走 GetJSON / PostForm 的原始查询编码，平台块用 WithPlatform("50", ...)。
// www.douyin.com 的接口走 duGetJSON / duPostFormJSON，平台块 WithPlatform("0", ...)。

import (
	"context"
	"encoding/json"
	"net/url"
	"time"
)

// imHJFinish 追加 www-hj.douyin.com 的通用平台块与签名参数（顺序与
// GetWatchLater 一致）。
func (c *Client) imHJFinish(ctx context.Context, p *Params, refer string) *Params {
	p.WithPlatform("50", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return p
}

// imWWWFinish 追加 www.douyin.com 的通用平台块与签名参数（顺序与
// noticeFinish 一致）。
func (c *Client) imWWWFinish(ctx context.Context, p *Params, refer string) *Params {
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	p.WithVerifyFP(c)
	return p
}

// imJSONStringArray 把字符串切片序列化为 JSON 数组串；nil 返回 "[]"。
func imJSONStringArray(v []string) string {
	if v == nil {
		v = []string{}
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// IMGetSpotlightRelation 获取消息面板「好友/关系」列表（spotlight）。
// 来源 tab：消息面板 - 好友。
func (c *Client) IMGetSpotlightRelation(ctx context.Context, count, maxTime string) (map[string]any, error) {
	const api = "/aweme/v1/web/im/spotlight/relation/"
	refer := douyinBase + "/friend"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if count == "" {
		count = "50"
	}
	if maxTime == "" {
		maxTime = "0"
	}
	p := NewParams()
	p.Add("count", count)
	p.Add("max_time", maxTime)
	p.Add("min_time", "0")
	p.Add("need_remove_share_panel", "true")
	p.Add("need_sorted_info", "true")
	p.Add("with_fstatus", "1")
	c.imHJFinish(ctx, p, refer)
	return c.GetJSON(ctx, imHJBase+api, p, headers)
}

// IMGetActiveStatus 批量查询多个会话/用户的在线状态。
// convIDs / secUIDs 为 JSON 数组串（convIDs 可为空数组）。
// 来源 tab：消息面板 - 在线状态（心跳）。
func (c *Client) IMGetActiveStatus(ctx context.Context, convIDs, secUIDs []string) (map[string]any, error) {
	const api = "/aweme/v1/web/im/user/active/status/"
	refer := douyinBase + "/friend"
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	form := url.Values{}
	form.Set("conv_ids", imJSONStringArray(convIDs))
	form.Set("sec_user_ids", imJSONStringArray(secUIDs))
	form.Set("source", "heartbeat")

	p := NewParams()
	c.imHJFinish(ctx, p, refer)
	resp, err := c.PostForm(ctx, imHJBase+api, p, headers, form.Encode())
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	return decodeJSONObject(resp.Body)
}

// IMActiveHeartbeat 上报在线心跳（active/update）。
// 来源 tab：消息面板 - 在线状态。
func (c *Client) IMActiveHeartbeat(ctx context.Context, newUserLogin string) (map[string]any, error) {
	const api = "/aweme/v1/web/im/user/active/update/"
	refer := douyinBase + "/friend"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if newUserLogin == "" {
		newUserLogin = "0"
	}
	p := NewParams()
	p.Add("action", "heartbeat")
	p.Add("new_user_login", newUserLogin)
	c.imHJFinish(ctx, p, refer)
	return c.GetJSON(ctx, imHJBase+api, p, headers)
}

// IMGetActiveConfig 获取在线状态配置（active/config/get）。
// 来源 tab：消息面板 - 在线状态。
func (c *Client) IMGetActiveConfig(ctx context.Context) (map[string]any, error) {
	const api = "/aweme/v1/web/im/user/active/config/get"
	refer := douyinBase + "/friend"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	c.imHJFinish(ctx, p, refer)
	return c.GetJSON(ctx, imHJBase+api, p, headers)
}

// IMGetStrategyConfig 获取 IM 策略配置（strategy/config）。
// scenes 为 JSON 数组串，默认 ["interactive_resources"]。
// 来源 tab：消息面板 - 互动资源策略。
func (c *Client) IMGetStrategyConfig(ctx context.Context, scenes string) (map[string]any, error) {
	const api = "/aweme/v1/web/im/strategy/config"
	refer := douyinBase + "/friend"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if scenes == "" {
		scenes = `["interactive_resources"]`
	}
	p := NewParams()
	p.Add("app_id", "1128")
	p.Add("scenes", scenes)
	c.imWWWFinish(ctx, p, refer)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// IMGetResources 获取消息面板的资源聚合列表（表情包等）。
// 来源 tab：消息面板 - 自定义表情。
func (c *Client) IMGetResources(ctx context.Context, scenes, customCursor, customLimit string) (map[string]any, error) {
	const api = "/aweme/v1/web/im/resource/list/aggregation/"
	refer := douyinBase + "/friend"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if scenes == "" {
		scenes = "CUSTOM_STICKER_PAGE"
	}
	if customCursor == "" {
		customCursor = "0"
	}
	if customLimit == "" {
		customLimit = "50"
	}
	p := NewParams()
	p.Add("app_id", "1128")
	p.Add("scenes", scenes)
	p.Add("custom_cursor", customCursor)
	p.Add("custom_limit", customLimit)
	c.imHJFinish(ctx, p, refer)
	return c.GetJSON(ctx, imHJBase+api, p, headers)
}

// IMGetEmoticonTrending 获取热门表情列表（emoticon/trending）。
// groupId 为表情分组，默认 1。
// 来源 tab：消息面板 - 表情面板。
func (c *Client) IMGetEmoticonTrending(ctx context.Context, cursor, count, groupID string) (map[string]any, error) {
	const api = "/aweme/v1/web/im/resources/emoticon/trending"
	refer := douyinBase + "/friend"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if cursor == "" {
		cursor = "0"
	}
	if count == "" {
		count = "50"
	}
	if groupID == "" {
		groupID = "1"
	}
	p := NewParams()
	p.Add("cursor", cursor)
	p.Add("count", count)
	p.Add("groupId", groupID)
	c.imWWWFinish(ctx, p, refer)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// IMGetFeedbackEntrance 获取在线反馈入口（online_feedback/entrance）。
// 来源 tab：消息面板 - 在线反馈。
func (c *Client) IMGetFeedbackEntrance(ctx context.Context, entrance string) (map[string]any, error) {
	const api = "/aweme/v1/web/im/get/online_feedback/entrance/"
	refer := douyinBase + "/friend"
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if entrance == "" {
		entrance = "IM6383-3586"
	}
	p := NewParams()
	p.Add("app_id", "10001")
	p.Add("entrance", entrance)
	c.imWWWFinish(ctx, p, refer)
	return c.duPostFormJSON(ctx, douyinBase+api, p, headers, nil)
}

// --- IM 增量拉消息（protobuf, cmd 2048） -----------------------------------

// IMPullMessages 通过 IM 协议增量拉取消息（cmd 2048）。
//
// 请求体来自实测解码：cmd=2048、body 字段号 2048，其内部字段为
// 1=游标(微秒时间戳) / 2=固定业务值 72313 / 4=时间戳(微秒) / 5=空串。
// cursor / timestamp 为 0 时取当前时间（微秒）。响应以字段号 keyed map 返回
// （协议未公开，保持原始解码，便于上层按字段解读）。
func (c *Client) IMPullMessages(ctx context.Context, cursor, timestamp int64) (map[string]any, error) {
	if cursor <= 0 {
		cursor = time.Now().UnixMicro()
	}
	if timestamp <= 0 {
		timestamp = time.Now().UnixMicro()
	}
	inner := &pbw{}
	inner.IntAlways(1, cursor)
	inner.IntAlways(2, 72313)
	inner.IntAlways(4, timestamp)
	out, err := c.imCall(ctx, "/v1/message/get_user_message", 2048, 1, 2048, inner, 2048)
	if err != nil {
		return nil, err
	}
	return pbMapToAny(out), nil
}
