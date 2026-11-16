package douyin

// Search endpoints (general / video / user / live). The search family uses
// version_code 190600 for the general channel and per-endpoint fingerprint
// blocks; verifyFp/fp always trail a_bogus here (unlike the comment APIs).

import (
	"context"
	"strconv"
)

// SearchGeneralWork searches the general channel
// (`/aweme/v1/web/general/search/single/`, version_code 190600).
func (c *Client) SearchGeneralWork(ctx context.Context, query, sortType, publishTime, offset, filterDuration, searchRange, contentType string) (map[string]any, error) {
	const api = "/aweme/v1/web/general/search/single/"
	refer := douyinBase + "/search/" + duQuote(query) + "?aid=" + duUUID4() + "&type=general"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	isFilter := "0"
	if sortType != "0" || publishTime != "0" || filterDuration != "" || searchRange != "" || contentType != "" {
		isFilter = "1"
	}
	needFilter := "0"
	if offset == "0" {
		needFilter = "1"
	}

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("search_channel", "aweme_general")
	p.Add("enable_history", "1")
	p.Add("keyword", query)
	p.Add("search_source", "normal_search")
	p.Add("query_correct_type", "1")
	p.Add("is_filter_search", isFilter)
	p.Add("from_group_id", "")
	p.Add("disable_rs", "0")
	p.Add("offset", offset)
	p.Add("count", "15")
	p.Add("need_filter_settings", needFilter)
	p.Add("list_type", "single")
	p.Add("pc_search_top_1_params", `{"enable_ai_search_top_1":1}`)
	p.Add("search_id", "")
	// 搜索系接口 version_code=190600/19.6.0.
	p.WithPlatform("0", "190600", "19.6.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	// 搜索接口的 verifyFp / fp 在 a_bogus **之后**.
	p.WithVerifyFP(c)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// SearchSomeGeneralWork pages through general search results up to num.
func (c *Client) SearchSomeGeneralWork(ctx context.Context, query string, num int, sortType, publishTime, filterDuration, searchRange, contentType string) ([]any, error) {
	offset := "0"
	var out []any
	for {
		res, err := c.SearchGeneralWork(ctx, query, sortType, publishTime, offset, filterDuration, searchRange, contentType)
		if err != nil {
			return nil, err
		}
		data := duSlice(res["data"])
		for _, item := range data {
			work := duMap(item)
			if work != nil && work["aweme_info"] != nil {
				out = append(out, item)
			}
		}
		if !duHasMore(res) || len(out) >= num {
			break
		}
		offset = strconv.FormatInt(toInt64(offset)+int64(len(data)), 10)
	}
	if len(out) > num {
		out = out[:num]
	}
	return out, nil
}

// SearchVideoWork searches the video channel
// (`/aweme/v1/web/search/item/`). search_id pagination is not exposed here;
// use SearchVideoWorkWithSearchID for cursor-perfect paging.
func (c *Client) SearchVideoWork(ctx context.Context, query, offset, count, sortType, publishTime, filterDuration, searchRange string) (map[string]any, error) {
	res, _, err := c.searchVideoWorkRaw(ctx, query, offset, count, sortType, publishTime, filterDuration, searchRange, "")
	return res, err
}

// SearchVideoWorkWithSearchID is SearchVideoWork with the X-Tt-Logid search_id
// cursor threaded across pages.
func (c *Client) SearchVideoWorkWithSearchID(ctx context.Context, query, offset, count, sortType, publishTime, filterDuration, searchRange, searchID string) (map[string]any, error) {
	res, _, err := c.searchVideoWorkRaw(ctx, query, offset, count, sortType, publishTime, filterDuration, searchRange, searchID)
	return res, err
}

// searchVideoWorkRaw also returns the response's X-Tt-Logid, which the caller
// feeds back as search_id.
func (c *Client) searchVideoWorkRaw(ctx context.Context, query, offset, count, sortType, publishTime, filterDuration, searchRange, searchID string) (map[string]any, string, error) {
	const api = "/aweme/v1/web/search/item/"
	refer := douyinBase + "/search/" + duQuote(query) + "?aid=" + duUUID4() + "&type=video"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)

	needFilter := "0"
	if offset == "0" {
		needFilter = "1"
	}

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("search_channel", "aweme_video_web")
	p.Add("enable_history", "1")
	p.Add("sort_type", sortType)
	p.Add("publish_time", publishTime)
	p.Add("filter_duration", filterDuration)
	p.Add("search_range", searchRange)
	p.Add("keyword", query)
	p.Add("search_source", "normal_search")
	p.Add("query_correct_type", "1")
	p.Add("is_filter_search", "1")
	p.Add("from_group_id", "")
	p.Add("offset", offset)
	p.Add("count", count)
	p.Add("need_filter_settings", needFilter)
	if searchID != "" {
		p.Add("search_id", searchID)
	}
	p.Add("list_type", "single")
	p.Add("pc_search_top_1_params", "")
	p.WithPlatform("50", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	p.WithVerifyFP(c)

	resp, err := c.HTTP.Get(ctx, BuildURL(douyinBase+api, standardEncodeQuery(p)), headers, c.CookieStr())
	if err != nil {
		return nil, "", err
	}
	c.absorbCookies(resp)
	nextID := resp.HeaderGet("X-Tt-Logid")
	if err := CheckRisk(resp); err != nil {
		return nil, "", err
	}
	res, err := decodeJSONObject(resp.Body)
	return res, nextID, err
}

// SearchSomeVideoWork pages through video-channel search results up to num,
// threading the X-Tt-Logid search_id between pages.
func (c *Client) SearchSomeVideoWork(ctx context.Context, query string, num int, sortType, publishTime, filterDuration, searchRange string) ([]any, error) {
	offset := "0"
	count := "25"
	searchID := ""
	var out []any
	for {
		res, nextID, err := c.searchVideoWorkRaw(ctx, query, offset, count, sortType, publishTime, filterDuration, searchRange, searchID)
		if err != nil {
			return nil, err
		}
		out = append(out, duSlice(res["data"])...)
		searchID = nextID
		if !duHasMore(res) || len(out) >= num {
			break
		}
		offset = strconv.FormatInt(toInt64(offset)+toInt64(count), 10)
	}
	if len(out) > num {
		out = out[:num]
	}
	return out, nil
}

// SearchUser searches users (`/aweme/v1/web/discover/search/`).
func (c *Client) SearchUser(ctx context.Context, query, offset, num, douyinUserFans, douyinUserType string) (map[string]any, error) {
	const api = "/aweme/v1/web/discover/search/"
	refer := douyinBase + "/search/" + duQuote(query) + "?type=user"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	uifid := c.Cookie.Get("UIFID")
	if uifid != "" {
		headers.Set("uifid", uifid)
	}
	hasFilter := douyinUserFans != "" || douyinUserType != ""
	needFilter := "0"
	if offset == "0" {
		needFilter = "1"
	}

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("search_channel", "aweme_user_web")
	if hasFilter {
		p.Add("search_filter_value", `{"douyin_user_fans":["`+douyinUserFans+`"],"douyin_user_type":["`+douyinUserType+`"]}`)
	}
	p.Add("keyword", query)
	p.Add("search_source", "normal_search")
	p.Add("query_correct_type", "1")
	if hasFilter {
		p.Add("is_filter_search", "1")
	} else {
		p.Add("is_filter_search", "0")
	}
	p.Add("from_group_id", "")
	p.Add("disable_rs", "0")
	p.Add("offset", offset)
	p.Add("count", num)
	p.Add("need_filter_settings", needFilter)
	p.Add("list_type", "single")
	p.Add("pc_search_top_1_params", `{"enable_ai_search_top_1":1}`)
	// 该接口是手写公共组（不是 with_platform），round_trip_time=50.
	p.Add("update_version_code", "170400")
	p.Add("pc_client_type", "1")
	p.Add("pc_libra_divert", "Windows")
	p.Add("support_h265", "1")
	p.Add("support_dash", "1")
	p.Add("cpu_core_num", GetProfile().CpuCoreNum)
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
	p.Add("device_memory", GetProfile().DeviceMemory)
	p.Add("platform", "PC")
	p.Add("downlink", "10")
	p.Add("effective_type", "4g")
	p.Add("round_trip_time", "50")
	p.WithWebID(ctx, c, refer)
	if uifid != "" {
		p.Add("uifid", uifid)
	}
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	p.WithVerifyFP(c)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// SearchSomeUser pages through user search results up to num (count 25).
func (c *Client) SearchSomeUser(ctx context.Context, query string, num int) ([]any, error) {
	offset := "0"
	count := "25"
	var out []any
	for {
		res, err := c.SearchUser(ctx, query, offset, count, "", "")
		if err != nil {
			return nil, err
		}
		out = append(out, duSlice(res["user_list"])...)
		if !duHasMore(res) || len(out) >= num {
			break
		}
		offset = strconv.FormatInt(toInt64(offset)+toInt64(count), 10)
	}
	if len(out) > num {
		out = out[:num]
	}
	return out, nil
}

// SearchLive searches live rooms (`/aweme/v1/web/live/search/`).
func (c *Client) SearchLive(ctx context.Context, query, offset, num string) (map[string]any, error) {
	const api = "/aweme/v1/web/live/search/"
	refer := douyinBase + "/search/" + duQuote(query) + "?aid=" + duUUID4() + "&type=live"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	needFilter := "0"
	if offset == "0" {
		needFilter = "1"
	}

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("search_channel", "aweme_live")
	p.Add("keyword", query)
	p.Add("search_source", "normal_search")
	p.Add("query_correct_type", "1")
	p.Add("is_filter_search", "0")
	p.Add("from_group_id", "")
	p.Add("disable_rs", "0")
	p.Add("offset", offset)
	p.Add("count", num)
	p.Add("need_filter_settings", needFilter)
	p.Add("list_type", "single")
	p.Add("pc_search_top_1_params", `{"enable_ai_search_top_1":1}`)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	// 实录里 verifyFp / fp 在 a_bogus 之后.
	p.WithVerifyFP(c)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// SearchSomeLive pages through live search results up to num (count 15).
func (c *Client) SearchSomeLive(ctx context.Context, query string, num int) ([]any, error) {
	offset := "0"
	count := "15"
	var out []any
	for {
		res, err := c.SearchLive(ctx, query, offset, count)
		if err != nil {
			return nil, err
		}
		out = append(out, duSlice(res["data"])...)
		if !duHasMore(res) || len(out) >= num {
			break
		}
		offset = strconv.FormatInt(toInt64(offset)+toInt64(count), 10)
	}
	if len(out) > num {
		out = out[:num]
	}
	return out, nil
}
