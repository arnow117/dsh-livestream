package douyin

// User profile and works endpoints: profile info and the works list.

import (
	"context"
)

// GetUserInfo returns a user's profile (`/aweme/v1/web/user/profile/other/`).
func (c *Client) GetUserInfo(ctx context.Context, userURL string) (map[string]any, error) {
	const api = "/aweme/v1/web/user/profile/other/"
	userURL = duUserURL(userURL)
	userID := duUserID(userURL)
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(userURL)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("publish_video_strategy_type", "2")
	p.Add("source", "channel_pc_web")
	p.Add("sec_user_id", userID)
	p.Add("personal_center_strategy", "1")
	// 实测 personal_center_strategy 之后还有这两个.
	p.Add("profile_other_record_enable", "1")
	p.Add("land_to", "1")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, userURL)
	p.WithUIFID(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	// 实录里 verifyFp / fp 在 a_bogus 之后.
	p.WithVerifyFP(c)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetUserWorkInfo returns one page of a user's works
// (`/aweme/v1/web/aweme/post/`, version_code 290100 / signed URL).
func (c *Client) GetUserWorkInfo(ctx context.Context, userURL, maxCursor string) (map[string]any, error) {
	const api = "/aweme/v1/web/aweme/post/"
	userURL = duUserURL(userURL)
	userID := duUserID(userURL)
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(userURL)
	headers.WithUIFID(c)

	needTimeList := "0"
	if maxCursor == "0" {
		needTimeList = "1"
	}

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("sec_user_id", userID)
	p.Add("max_cursor", maxCursor)
	p.Add("locate_query", "false")
	p.Add("show_live_replay_strategy", "1")
	p.Add("need_time_list", needTimeList)
	p.Add("time_list_query", "0")
	// whale_cut_token 是空值字段，浏览器确实发.
	p.Add("whale_cut_token", "")
	p.Add("cut_version", "1")
	p.Add("count", "18")
	p.Add("publish_video_strategy_type", "2")
	// 自己主页发 0、他人主页发 1，按 sec_user_id 是否本人判断.
	if own, _ := c.SecUID(ctx); own != "" && own == userID {
		p.Add("from_user_page", "0")
	} else {
		p.Add("from_user_page", "1")
	}
	p.Add("update_version_code", "170400")
	p.Add("pc_client_type", "1")
	p.Add("pc_libra_divert", "Windows")
	p.Add("support_h265", "1")
	p.Add("support_dash", "1")
	p.Add("cpu_core_num", GetProfile().CpuCoreNum)
	// 这个接口特有：version_code 是 290100 / 29.1.0.
	p.Add("version_code", "290100")
	p.Add("version_name", "29.1.0")
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
	p.Add("device_memory", GetProfile().DeviceMemory)
	p.Add("platform", "PC")
	p.Add("downlink", "10")
	p.Add("effective_type", "4g")
	p.Add("round_trip_time", "0")
	p.WithWebID(ctx, c, userURL)
	p.WithUIFID(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	// verifyFp / fp 在 a_bogus 之后.
	p.WithVerifyFP(c)
	// 该接口在 secsdk webSign 策略表里，末尾还要带 timestamp + 签名.
	return c.GetJSONSigned(ctx, douyinBase+api, p, headers)
}

// GetUserAllWorkInfo pages through a user's works up to limit.
func (c *Client) GetUserAllWorkInfo(ctx context.Context, userURL string, limit int) ([]any, error) {
	maxCursor := "0"
	var out []any
	for {
		res, err := c.GetUserWorkInfo(ctx, userURL, maxCursor)
		if err != nil {
			return nil, err
		}
		worksVal, ok := res["aweme_list"]
		if !ok {
			break
		}
		out = append(out, duSlice(worksVal)...)
		if v, ok := res["max_cursor"]; ok {
			maxCursor = duStr(v)
		}
		if !duHasMore(res) {
			break
		}
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
