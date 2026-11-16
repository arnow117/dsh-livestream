package douyin

// Personal-profile tabs as the current PC client loads them:
//   作品   /aweme/v1/web/aweme/post/                 (api_user.go)
//   喜欢   /aweme/v1/web/aweme/favorite/             (api_collect.go)
//   收藏   /aweme/v1/web/collects/list/              (api_collect.go, 收藏夹)
//          /aweme/v1/web/aweme/listcollection/       仅在浏览器链路可达，未纳入
//   观看历史 /aweme/v1/web/history/read/              (here)
//   稍后再看 /aweme/v1/web/watchlater/list/           (here)
//   我的预约 /aweme/v1/web/user/appointment/list/     (here)
// The 收藏/稍后再看 tabs are served from www-hj.douyin.com by the web client.

import (
	"context"
	"fmt"
)

const douyinHJBase = "https://www-hj.douyin.com"

// GetWatchHistory lists the "观看历史" tab.
func (c *Client) GetWatchHistory(ctx context.Context, cursor, count string) (map[string]any, error) {
	const api = "/aweme/v1/web/history/read/"
	refer := douyinBase + "/user/self?showTab=record"
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
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("cursor", cursor)
	p.Add("count", count)
	p.WithPlatform("50", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.GetJSON(ctx, douyinBase+api, p, headers)
}

// ClearWatchHistory empties the "观看历史" list.
func (c *Client) ClearWatchHistory(ctx context.Context) (map[string]any, error) {
	const api = "/aweme/v1/web/history/clear/"
	refer := douyinBase + "/user/self?showTab=record"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.WithPlatform("50", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.GetJSON(ctx, douyinBase+api, p, headers)
}

// GetWatchLater lists the "稍后再看" tab.
func (c *Client) GetWatchLater(ctx context.Context, offset string) (map[string]any, error) {
	const api = "/aweme/v1/web/watchlater/list/"
	refer := douyinBase + "/user/self?showTab=watch_later"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if offset == "" {
		offset = "0"
	}
	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("offset", offset)
	p.Add("list_type", "0")
	p.Add("operate_type", "0")
	p.WithPlatform("50", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.GetJSON(ctx, douyinHJBase+api, p, headers)
}

// GetAppointments lists the "我的预约" tab.
func (c *Client) GetAppointments(ctx context.Context, appointmentType string, count int) (map[string]any, error) {
	const api = "/aweme/v1/web/user/appointment/list/"
	refer := douyinBase + "/user/self?showTab=my_appointment"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if appointmentType == "" {
		appointmentType = "100"
	}
	countStr := fmt.Sprintf("%d", count)
	if count == 0 {
		countStr = "-1"
	}
	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("publish_video_strategy_type", "2")
	p.Add("appointment_type", appointmentType)
	p.Add("count", countStr)
	// 实测该接口用直播 SDK 版本号，而非主站的 170400.
	p.WithPlatform("50", "320600", "32.6.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.GetJSON(ctx, douyinBase+api, p, headers)
}
