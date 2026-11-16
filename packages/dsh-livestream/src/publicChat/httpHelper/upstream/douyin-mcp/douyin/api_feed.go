package douyin

// Home recommendation feed (抖音 Web 端).

import (
	"context"
)

// GetFeed returns the home recommendation feed
// (`/aweme/v1/web/module/feed/`).
func (c *Client) GetFeed(ctx context.Context, count, refreshIndex string) (map[string]any, error) {
	const api = "/aweme/v1/web/module/feed/"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)

	prof := GetProfile()
	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("module_id", "3003101")
	p.Add("count", count)
	p.Add("filterGids", "")
	p.Add("presented_ids", "")
	p.Add("refresh_index", refreshIndex)
	p.Add("refer_id", "")
	p.Add("refer_type", "10")
	p.Add("awemePcRecRawData", `{"is_client":false}`)
	p.Add("Seo-Flag", "0")
	p.Add("install_time", "1715480185")
	p.Add("pc_client_type", "1")
	p.Add("update_version_code", "170400")
	p.Add("version_code", "170400")
	p.Add("version_name", "17.4.0")
	p.Add("cookie_enabled", "true")
	p.Add("screen_width", prof.ScreenWidth)
	p.Add("screen_height", prof.ScreenHeight)
	p.Add("browser_language", "zh-CN")
	p.Add("browser_platform", "Win32")
	p.Add("browser_name", prof.BrowserName)
	p.Add("browser_version", prof.BrowserVersion)
	p.Add("browser_online", "true")
	p.Add("engine_name", "Blink")
	p.Add("engine_version", prof.EngineVersion)
	p.Add("os_name", "Windows")
	p.Add("os_version", "10")
	p.Add("cpu_core_num", prof.CpuCoreNum)
	p.Add("device_memory", prof.DeviceMemory)
	p.Add("platform", "PC")
	p.Add("downlink", "10")
	p.Add("effective_type", "4g")
	p.Add("round_trip_time", "100")
	p.WithWebID(ctx, c, refer)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	p.WithVerifyFP(c)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}
