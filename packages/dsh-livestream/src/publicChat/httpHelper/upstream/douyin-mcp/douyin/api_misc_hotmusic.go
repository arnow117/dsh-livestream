package douyin

// 热搜词视频 + 音乐页接口（PC 版，2026-10-07 抓包 / 前端 bundle 反查）。
//
//	热搜词视频   GET  www-hj.douyin.com/aweme/v1/web/hot/search/video/list/   （不带 uifid）
//	音乐下视频   GET  /aweme/v1/web/music/aweme/                （webSign 策略表内，需 x-secsdk-web-signature）
//	音乐详情     GET  /aweme/v1/web/music/detail/               （同上）
//	收藏的音乐   GET  /aweme/v1/web/music/listcollection/
//	收藏音乐     POST /aweme/v1/web/music/collect/              （写操作）
//
// 注：旧的 `/aweme/v1/web/music/list/`（音乐搜索）在当前 PC 客户端已不存在，
// 真实的音乐接口是 async/c27.js 里的 music/aweme、music/detail、music/listcollection、
// music/collect；参数顺序以 local://dy-gap-spec.md「追加缺口（2026-10-07）」
// 的浏览器实录为准。热搜榜点词后触发的视频列表走 www-hj 域且不带 uifid。

import (
	"context"
	"fmt"
)

// hotMusicStatusError turns a business status_code into an error so a failed
// call cannot be mistaken for an empty success（与 noticeStatusError 同风格）.
func hotMusicStatusError(action string, res map[string]any) error {
	code := toInt64(res["status_code"])
	if code == 0 {
		return nil
	}
	msg, _ := res["status_msg"].(string)
	return fmt.Errorf("%s 失败: status_code=%d %s", action, code, msg)
}

// hotSearchVideoPlatform 追加热搜词视频接口的平台块。顺序与浏览器实录一致：
// webcast_sdk_version/webcast_version_code 紧跟 support_dash，cpu_core_num 排在
// os_version 之后（与 WithPlatform 不同，故不能直接复用）。
func hotSearchVideoPlatform(p *Params) *Params {
	prof := GetProfile()
	p.Add("pc_client_type", "1")
	p.Add("pc_libra_divert", "Windows")
	p.Add("support_h265", "1")
	p.Add("support_dash", "1")
	p.Add("webcast_sdk_version", "170400")
	p.Add("webcast_version_code", "170400")
	p.Add("version_code", "170400")
	p.Add("version_name", "17.4.0")
	p.Add("cookie_enabled", "true")
	p.Add("screen_width", prof.ScreenWidth)
	p.Add("screen_height", prof.ScreenHeight)
	p.Add("browser_language", "zh-CN")
	p.Add("browser_platform", prof.Platform)
	p.Add("browser_name", prof.BrowserName)
	p.Add("browser_version", prof.BrowserVersion)
	p.Add("browser_online", "true")
	p.Add("engine_name", "Blink")
	p.Add("engine_version", prof.EngineVersion)
	p.Add("os_name", prof.OSName)
	p.Add("os_version", prof.OSVersion)
	p.Add("cpu_core_num", prof.CpuCoreNum)
	p.Add("device_memory", prof.DeviceMemory)
	p.Add("platform", "PC")
	p.Add("downlink", "10")
	p.Add("effective_type", "4g")
	p.Add("round_trip_time", "0")
	return p
}

// HotSearchVideos 拉取某个热搜词下的视频列表
// （GET www-hj.douyin.com/aweme/v1/web/hot/search/video/list/，来源：热搜榜点词）。
// sentenceID 是热搜榜条目里的 sentence_id；offset 在服务端的参数名是拼错的
// `offest`，这里照抄浏览器实录。
func (c *Client) HotSearchVideos(ctx context.Context, hotword, sentenceID, offset, count, entryName string) (map[string]any, error) {
	if hotword == "" {
		return nil, fmt.Errorf("hotword 不能为空")
	}
	if sentenceID == "" {
		return nil, fmt.Errorf("sentence_id 不能为空")
	}
	if offset == "" {
		offset = "0"
	}
	if count == "" {
		count = "20"
	}
	if entryName == "" {
		entryName = "pc_web"
	}
	const api = "/aweme/v1/web/hot/search/video/list/"
	refer := douyinBase + "/search/" + quoteStrict(hotword)
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("hotword", hotword)
	p.Add("sentence_id", sentenceID)
	p.Add("offest", offset)
	p.Add("count", count)
	p.Add("entry_name", entryName)
	hotSearchVideoPlatform(p)
	// 实录里这个接口只带 webid，没有 uifid。
	p.WithWebID(ctx, c, refer)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)

	res, err := c.duGetJSON(ctx, imHJBase+api, p, headers)
	if err != nil {
		return nil, err
	}
	if err := hotMusicStatusError("获取热搜词视频", res); err != nil {
		return nil, err
	}
	return res, nil
}

// MusicAweme 拉取某音乐下的视频列表（GET /aweme/v1/web/music/aweme/）。
// 该接口在 secsdk webSign 策略表里，query 结尾需要 timestamp + x-secsdk-web-signature。
func (c *Client) MusicAweme(ctx context.Context, musicID, cursor, count string) (map[string]any, error) {
	if musicID == "" {
		return nil, fmt.Errorf("music_id 不能为空")
	}
	if cursor == "" {
		cursor = "0"
	}
	if count == "" {
		count = "12"
	}
	const api = "/aweme/v1/web/music/aweme/"
	refer := douyinBase + "/music/" + musicID
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("count", count)
	p.Add("cursor", cursor)
	p.Add("music_id", musicID)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)

	res, err := c.GetJSONSigned(ctx, douyinBase+api, p, headers)
	if err != nil {
		return nil, err
	}
	if err := hotMusicStatusError("获取音乐作品", res); err != nil {
		return nil, err
	}
	return res, nil
}

// MusicDetail 拉取音乐详情（GET /aweme/v1/web/music/detail/，bundle:
// {...COMMON, music_id, scene:1}），同样走 webSign 签名。
func (c *Client) MusicDetail(ctx context.Context, musicID, scene string) (map[string]any, error) {
	if musicID == "" {
		return nil, fmt.Errorf("music_id 不能为空")
	}
	if scene == "" {
		scene = "1"
	}
	const api = "/aweme/v1/web/music/detail/"
	refer := douyinBase + "/music/" + musicID
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("music_id", musicID)
	p.Add("scene", scene)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)

	res, err := c.GetJSONSigned(ctx, douyinBase+api, p, headers)
	if err != nil {
		return nil, err
	}
	if err := hotMusicStatusError("获取音乐详情", res); err != nil {
		return nil, err
	}
	return res, nil
}

// MusicListCollection 拉取当前登录用户收藏的音乐列表
// （GET /aweme/v1/web/music/listcollection/，bundle: {...COMMON, cursor, count:20}）。
func (c *Client) MusicListCollection(ctx context.Context, cursor, count string) (map[string]any, error) {
	if cursor == "" {
		cursor = "0"
	}
	if count == "" {
		count = "20"
	}
	const api = "/aweme/v1/web/music/listcollection/"
	refer := profileSelfRefer + "?showTab=favorite_music"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("cursor", cursor)
	p.Add("count", count)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)

	res, err := c.duGetJSON(ctx, douyinBase+api, p, headers)
	if err != nil {
		return nil, err
	}
	if err := hotMusicStatusError("获取收藏音乐", res); err != nil {
		return nil, err
	}
	return res, nil
}

// CollectMusic 收藏/取消收藏一首音乐（POST /aweme/v1/web/music/collect/）。
// body: music_id / type / action，action 与 type 同值（1=收藏，0=取消）。
// 这是写操作，会改变账号收藏，调用前请确认。
func (c *Client) CollectMusic(ctx context.Context, musicID, typ, action string) (map[string]any, error) {
	if musicID == "" {
		return nil, fmt.Errorf("music_id 不能为空")
	}
	if action == "" {
		action = "1"
	}
	if typ == "" {
		typ = action
	}
	const api = "/aweme/v1/web/music/collect/"
	refer := douyinBase + "/music/" + musicID
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)
	headers.WithBDReadonly(c)
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
	data.Add("music_id", musicID)
	data.Add("type", typ)
	data.Add("action", action)
	p.WithABogus(c, data)
	// 与 aweme/collect 一样，query 末尾还有 uid = md5(登录用户数字 ID)，不参与签名。
	p.Add("uid", c.CommentUID(ctx))

	res, err := c.duPostFormJSON(ctx, douyinBase+api, p, headers, data)
	if err != nil {
		return nil, err
	}
	if err := hotMusicStatusError("收藏音乐", res); err != nil {
		return nil, err
	}
	return res, nil
}
