package douyin

// 「我的」tab（个人主页/资料、设置、收藏、百科）在 PC 端加载的接口。
// 来源 tab：
//   资料     GET  /aweme/v1/web/user/profile/self/
//   数据面板 GET  /aweme/v1/web/user/dashboard
//   社交数   GET  /aweme/v1/web/social/count
//   设置     GET  /aweme/v1/web/get/user/settings/     (www 主站)
//            GET  /aweme/v1/web/user/settings/         (www-hj 域)
//   自定义项 GET  /aweme/v1/web/custom/settings/get/
//   收藏作品 POST /aweme/v1/web/aweme/listcollection/  (www-hj 域，带 x-secsdk-web-signature)
//   百科     GET  baike.douyin.com/webcast/ip/wiki/check_worldbook_access
//            GET  baike.douyin.com/webcast/ip/wiki/get_account_binding_subject

import (
	"context"
	"strconv"
)

// baikeBase 是抖音百科（IP 百科）域名，百科相关接口挂在它下面。
const baikeBase = "https://baike.douyin.com"

// profileSelfRefer 是「我的」tab 的 Referer。
const profileSelfRefer = "https://www.douyin.com/user/self"

// GetMyProfile 拉取登录用户自己的资料（GET /aweme/v1/web/user/profile/self/）。
func (c *Client) GetMyProfile(ctx context.Context) (map[string]any, error) {
	const api = "/aweme/v1/web/user/profile/self/"
	refer := profileSelfRefer
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetUserDashboard 拉取用户数据面板（GET /aweme/v1/web/user/dashboard）。
// UserID 为空时默认查自己。
func (c *Client) GetUserDashboard(ctx context.Context, userID string) (map[string]any, error) {
	const api = "/aweme/v1/web/user/dashboard"
	refer := profileSelfRefer
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if userID == "" {
		uid, err := c.UID(ctx)
		if err != nil {
			return nil, err
		}
		userID = strconv.FormatInt(uid, 10)
	}

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("UserId", userID)
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

// GetSocialCount 拉取登录用户的社交计数（GET /aweme/v1/web/social/count）。
func (c *Client) GetSocialCount(ctx context.Context) (map[string]any, error) {
	const api = "/aweme/v1/web/social/count"
	refer := profileSelfRefer
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetUserSettings 拉取用户设置。
//   - source="www"（默认）: GET www.douyin.com/aweme/v1/web/get/user/settings/
//   - source="hj"          : GET www-hj.douyin.com/aweme/v1/web/user/settings/
//
// hj 版本可选 is_fetch_frequency_control / has_local_cache / request_source，
// 留空则不发送（与浏览器默认一致）。
func (c *Client) GetUserSettings(ctx context.Context, source, isFetchFrequencyControl, hasLocalCache, requestSource string) (map[string]any, error) {
	base := douyinBase
	api := "/aweme/v1/web/get/user/settings/"
	if source == "hj" {
		base = imHJBase
		api = "/aweme/v1/web/user/settings/"
	}
	refer := profileSelfRefer
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	if isFetchFrequencyControl != "" {
		p.Add("is_fetch_frequency_control", isFetchFrequencyControl)
	}
	if hasLocalCache != "" {
		p.Add("has_local_cache", hasLocalCache)
	}
	if requestSource != "" {
		p.Add("request_source", requestSource)
	}
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, base+api, p, headers)
}

// GetCustomSettings 拉取自定义设置项（GET /aweme/v1/web/custom/settings/get/）。
// SettingTypes 默认 "1"。
func (c *Client) GetCustomSettings(ctx context.Context, settingTypes string) (map[string]any, error) {
	const api = "/aweme/v1/web/custom/settings/get/"
	refer := profileSelfRefer
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if settingTypes == "" {
		settingTypes = "1"
	}
	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("setting_types", settingTypes)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetCollectedAwemes 拉取「收藏」tab 的收藏作品列表
// （POST www-hj.douyin.com/aweme/v1/web/aweme/listcollection/，query 带
// x-secsdk-web-signature，body 是表单 count/cursor）。
func (c *Client) GetCollectedAwemes(ctx context.Context, count, cursor string) (map[string]any, error) {
	const api = "/aweme/v1/web/aweme/listcollection/"
	refer := profileSelfRefer + "?showTab=collection"
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)
	headers.WithUIFID(c)
	headers.Set("origin", douyinBase)

	if count == "" {
		count = "10"
	}
	if cursor == "" {
		cursor = "0"
	}

	p := NewParams()
	data := NewParams()
	data.Add("count", count)
	data.Add("cursor", cursor)

	// 该接口在 secsdk webSign 策略表里，POST 也需要 query 上的签名。
	url := SignWebURL(BuildURL(imHJBase+api, standardEncodeQuery(p)), 0, c.Cookie.Get("UIFID"))
	resp, err := c.HTTP.PostJSON(ctx, url, headers, c.CookieStr(), "", []byte(standardEncodeQuery(data)))
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	return decodeJSONObject(resp.Body)
}

// baikeParams 构造百科接口共用的平台参数块（与浏览器实测一致）。
// 不含 a_bogus：业务参数需在签名前追加。
func (c *Client) baikeParams(ctx context.Context, refer string) *Params {
	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	return p
}

// BaikeCheckWorldbook 查询当前账号是否有 IP 百科词条访问权限
// （GET baike.douyin.com/webcast/ip/wiki/check_worldbook_access）。
func (c *Client) BaikeCheckWorldbook(ctx context.Context) (map[string]any, error) {
	const api = "/webcast/ip/wiki/check_worldbook_access"
	refer := baikeBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)
	p := c.baikeParams(ctx, refer)
	p.WithABogusHost(c, nil, "baike.douyin.com")
	return c.duGetJSON(ctx, baikeBase+api, p, headers)
}

// BaikeBindingSubject 查询账号绑定的百科主体
// （GET baike.douyin.com/webcast/ip/wiki/get_account_binding_subject）。
// AccountUID 为空时默认查自己。
func (c *Client) BaikeBindingSubject(ctx context.Context, accountUID string) (map[string]any, error) {
	const api = "/webcast/ip/wiki/get_account_binding_subject"
	refer := baikeBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if accountUID == "" {
		uid, err := c.UID(ctx)
		if err != nil {
			return nil, err
		}
		accountUID = strconv.FormatInt(uid, 10)
	}
	p := c.baikeParams(ctx, refer)
	p.Add("account_uid", accountUID)
	p.WithABogusHost(c, nil, "baike.douyin.com")
	return c.duGetJSON(ctx, baikeBase+api, p, headers)
}
