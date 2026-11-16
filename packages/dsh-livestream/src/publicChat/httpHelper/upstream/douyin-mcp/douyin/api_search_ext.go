package douyin

// Extra search surfaces the current PC client exposes besides the four tab
// searches (general / video / user / live):
//   联想建议  /aweme/v1/web/search/sug/            (+ /aweme/v1/web/api/suggest_words/)
//   热搜榜    /aweme/v1/web/hot/search/list/
//   话题搜索  /aweme/v1/web/challenge/search/
// Not shipped (unreachable from a non-browser transport here):
//   音乐搜索  /aweme/v1/web/music/list/        → signed path returns 404 Unsupported path(Janus)
//   热搜视频  /aweme/v1/web/hot/search/video/list/ → bdturing 人机验证 on every attempt

import (
	"context"
)

// searchCommon builds the shared search query prefix.
func searchCommon() *Params {
	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	return p
}

// SearchSuggest returns the search-box suggestions for a keyword.
func (c *Client) SearchSuggest(ctx context.Context, keyword string) (map[string]any, error) {
	const api = "/aweme/v1/web/search/sug/"
	refer := douyinBase + "/search/" + quoteStrict(keyword)
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := searchCommon()
	p.Add("keyword", keyword)
	p.Add("count", "10")
	p.Add("source", "normal_search")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	// music/list 在 secsdk webSign 策略表里，必须带 timestamp + 签名.
	return c.GetJSON(ctx, douyinBase+api, p, headers)
}

// HotSearchBoard returns the hot-search board (热搜榜).
func (c *Client) HotSearchBoard(ctx context.Context) (map[string]any, error) {
	const api = "/aweme/v1/web/hot/search/list/"
	refer := douyinBase + "/search/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := searchCommon()
	p.Add("detail_list", "1")
	p.Add("source", "6")
	p.Add("main_billboard_count", "5")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	// music/list 在 secsdk webSign 策略表里，必须带 timestamp + 签名.
	return c.GetJSON(ctx, douyinBase+api, p, headers)
}

// SearchChallenges searches hashtags/challenges (话题).
func (c *Client) SearchChallenges(ctx context.Context, keyword, cursor, count string) (map[string]any, error) {
	const api = "/aweme/v1/web/challenge/search/"
	refer := douyinBase + "/search/" + quoteStrict(keyword) + "?type=challenge"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if cursor == "" {
		cursor = "0"
	}
	if count == "" {
		count = "10"
	}
	p := searchCommon()
	p.Add("keyword", keyword)
	p.Add("cursor", cursor)
	p.Add("count", count)
	p.Add("search_source", "normal_search")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	// music/list 在 secsdk webSign 策略表里，必须带 timestamp + 签名.
	return c.GetJSON(ctx, douyinBase+api, p, headers)
}
