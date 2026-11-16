package douyin

// Relation and notification endpoints: followers, following and notice.

import (
	"context"
	"strconv"
)

// GetUserFollowerList returns one page of a user's followers
// (`/aweme/v1/web/user/follower/list/`). max_time is normalised to the current
// second when empty/0, because the server returns an empty list otherwise.
func (c *Client) GetUserFollowerList(ctx context.Context, userID, secID, maxTime, count string) (map[string]any, error) {
	const api = "/aweme/v1/web/user/follower/list/"
	maxTime = resolveRelationMaxTime(maxTime)
	// source_type=1 pairs with a real timestamp; 2 was the empty recommend branch.
	sourceType := "1"
	refer := douyinBase + "/user/" + secID
	headers := BuildHeaders(HeaderGET)
	headers.WithUIFID(c)
	headers.SetReferer(refer)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("user_id", userID)
	p.Add("sec_user_id", secID)
	p.Add("offset", "0")
	p.Add("min_time", "0")
	p.Add("max_time", maxTime)
	p.Add("count", count)
	p.Add("source_type", sourceType)
	p.Add("gps_access", "0")
	p.Add("address_book_access", "0")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetSomeUserFollowerList pages through a user's followers up to num.
func (c *Client) GetSomeUserFollowerList(ctx context.Context, userID, secID string, num int) ([]any, error) {
	maxTime := "0"
	count := "20"
	var out []any
	for {
		res, err := c.GetUserFollowerList(ctx, userID, secID, maxTime, count)
		if err != nil {
			return nil, err
		}
		out = append(out, duSlice(res["followers"])...)
		if !duHasMore(res) || len(out) >= num {
			break
		}
		maxTime = duStr(res["min_time"])
	}
	if len(out) > num {
		out = out[:num]
	}
	return out, nil
}

// GetUserFollowingList returns one page of the accounts a user follows
// (`/aweme/v1/web/user/following/list/`, signed URL).
func (c *Client) GetUserFollowingList(ctx context.Context, userID, secID, maxTime, count string) (map[string]any, error) {
	const api = "/aweme/v1/web/user/following/list/"
	// See resolveRelationMaxTime: max_time=0 returns the empty "recommend"
	// branch for other users (upstream PR #86 / issue #85).
	maxTime = resolveRelationMaxTime(maxTime)
	refer := douyinBase + "/user/" + secID
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	// 实录 headers_wire 里带 bd-ticket-guard 全套.
	headers.WithBDReadonly(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("user_id", userID)
	p.Add("sec_user_id", secID)
	p.Add("offset", "0")
	p.Add("min_time", "0")
	p.Add("max_time", maxTime)
	p.Add("count", count)
	p.Add("source_type", "1")
	p.Add("gps_access", "0")
	p.Add("address_book_access", "0")
	p.Add("is_top", "1")
	p.Add("pc_client_type", "1")
	// 实录里这个接口特有：pc_libra_divert/support_* 紧跟 pc_client_type.
	p.Add("pc_libra_divert", "Windows")
	p.Add("support_h265", "1")
	p.Add("support_dash", "1")
	p.Add("webcast_sdk_version", "170400")
	p.Add("webcast_version_code", "170400")
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
	p.Add("round_trip_time", "0")
	p.WithWebID(ctx, c, refer)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	// 该接口在 secsdk webSign 策略表里，缺签名会被 ArgusSecurityPlugin 403.
	return c.GetJSONSigned(ctx, douyinBase+api, p, headers)
}

// GetSomeUserFollowingList pages through a user's following list up to num.
func (c *Client) GetSomeUserFollowingList(ctx context.Context, userID, secID string, num int) ([]any, error) {
	maxTime := "0"
	count := "20"
	var out []any
	for {
		res, err := c.GetUserFollowingList(ctx, userID, secID, maxTime, count)
		if err != nil {
			return nil, err
		}
		out = append(out, duSlice(res["followings"])...)
		if !duHasMore(res) || len(out) >= num {
			break
		}
		maxTime = duStr(res["min_time"])
	}
	if len(out) > num {
		out = out[:num]
	}
	return out, nil
}

// GetNoticeList returns the notification list (`/aweme/v1/web/notice/`), with
// notice_list backfilled from notice_list_v2 for compatibility.
func (c *Client) GetNoticeList(ctx context.Context, minTime, maxTime, count, noticeGroup string) (map[string]any, error) {
	const api = "/aweme/v1/web/notice/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderGET)
	headers.WithUIFID(c)
	headers.SetReferer(refer)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("is_new_notice", "1")
	p.Add("is_mark_read", "1")
	p.Add("notice_group", noticeGroup)
	p.Add("count", count)
	p.Add("min_time", minTime)
	p.Add("max_time", maxTime)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	p.WithVerifyFP(c)

	res, err := c.duGetJSON(ctx, douyinBase+api, p, headers)
	if err != nil {
		return nil, err
	}
	// 服务端把通知放在 notice_list_v2；旧的 notice_list 恒为 [].
	if len(duSlice(res["notice_list"])) == 0 {
		if v2 := duSlice(res["notice_list_v2"]); len(v2) > 0 {
			res["notice_list"] = res["notice_list_v2"]
		}
	}
	return res, nil
}

// GetSomeNoticeList pages through notifications up to num.
func (c *Client) GetSomeNoticeList(ctx context.Context, num int, noticeGroup string) ([]any, error) {
	minTime := "0"
	maxTime := "0"
	count := "10"
	var out []any
	for {
		res, err := c.GetNoticeList(ctx, minTime, maxTime, count, noticeGroup)
		if err != nil {
			return nil, err
		}
		out = append(out, duSlice(res["notice_list_v2"])...)
		if !duHasMore(res) || len(out) >= num {
			break
		}
		minTime = duStr(res["min_time"])
		maxTime = duStr(res["max_time"])
	}
	if len(out) > num {
		out = out[:num]
	}
	return out, nil
}

// resolveRelationMaxTime substitutes the current epoch seconds for an empty or
// zero max_time. The follower/following list endpoints otherwise take a
// "recommend" branch that returns an empty list with status_code=0 for other
// users, which callers cannot distinguish from a genuinely empty result
// (upstream PR #86, issue #85).
func resolveRelationMaxTime(maxTime string) string {
	if maxTime == "" || maxTime == "0" {
		return strconv.FormatInt(nowUnix(), 10)
	}
	return maxTime
}
