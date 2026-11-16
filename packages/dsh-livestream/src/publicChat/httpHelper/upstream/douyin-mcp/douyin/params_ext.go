package douyin

// Query-parameter groups.

import (
	"context"
	"strings"
)

// WithPlatform adds the www.douyin.com common query group (order significant).
func (p *Params) WithPlatform(roundTripTime, versionCode, versionName string) *Params {
	prof := GetProfile()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("update_version_code", "170400")
	p.Add("pc_client_type", "1")
	p.Add("pc_libra_divert", "Windows")
	p.Add("support_h265", "1")
	p.Add("support_dash", "1")
	p.Add("cpu_core_num", prof.CpuCoreNum)
	p.Add("version_code", versionCode)
	p.Add("version_name", versionName)
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
	p.Add("device_memory", prof.DeviceMemory)
	p.Add("platform", "PC")
	p.Add("downlink", "10")
	p.Add("effective_type", "4g")
	p.Add("round_trip_time", roundTripTime)
	return p
}

// WithLivePlatform adds the live.douyin.com e-commerce query group.
func (p *Params) WithLivePlatform(roundTripTime string) *Params {
	prof := GetProfile()
	p.Add("update_version_code", "170400")
	p.Add("pc_client_type", "1")
	p.Add("pc_libra_divert", "Windows")
	p.Add("support_h265", "1")
	p.Add("support_dash", "0")
	p.Add("cpu_core_num", prof.CpuCoreNum)
	p.Add("version_code", "320100")
	p.Add("version_name", "32.1.0")
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
	p.Add("device_memory", prof.DeviceMemory)
	p.Add("platform", "PC")
	p.Add("downlink", "10")
	p.Add("effective_type", "4g")
	p.Add("round_trip_time", roundTripTime)
	return p
}

// WithCreatorPlatform adds the creator.douyin.com query group.
func (p *Params) WithCreatorPlatform() *Params {
	prof := GetProfile()
	p.Add("cookie_enabled", "true")
	p.Add("screen_width", prof.ScreenWidth)
	p.Add("screen_height", prof.ScreenHeight)
	p.Add("browser_language", "zh-CN")
	p.Add("browser_platform", "Win32")
	p.Add("browser_name", "Mozilla")
	p.Add("browser_version", strings.Replace(prof.UA, "Mozilla/", "", 1))
	p.Add("browser_online", "true")
	p.Add("timezone_name", "Asia/Shanghai")
	p.Add("aid", "1128")
	p.Add("support_h265", "1")
	return p
}

// WithUIFID appends uifid from the UIFID cookie when present.
func (p *Params) WithUIFID(c *Client) *Params {
	if v := c.Cookie.Get("UIFID"); v != "" {
		p.Add("uifid", v)
	}
	return p
}

// WithVerifyFP appends verifyFp/fp from s_v_web_id.
func (p *Params) WithVerifyFP(c *Client) *Params {
	fp := c.Cookie.Get("s_v_web_id")
	if fp != "" {
		p.Add("verifyFp", fp)
		p.Add("fp", fp)
	}
	return p
}

// WithWebID appends the real device webid.
func (p *Params) WithWebID(ctx context.Context, c *Client, pageURL string) *Params {
	p.Add("webid", c.WebID(ctx))
	return p
}

// WithMsToken appends a fresh random msToken.
func (p *Params) WithMsToken() *Params {
	p.Add("msToken", GenerateMsToken())
	return p
}

// WithABogus appends a_bogus for www.douyin.com.
func (p *Params) WithABogus(c *Client, body *Params) *Params {
	return p.WithABogusHost(c, body, "www.douyin.com")
}

// WithABogusHost appends a_bogus for an explicit subdomain.
func (p *Params) WithABogusHost(c *Client, body *Params, host string) *Params {
	query := p.SpliceURL()
	bodyStr := ""
	if body != nil {
		bodyStr = body.SpliceURL()
	}
	p.Add("a_bogus", c.Signer.SignQuery(query, bodyStr, host))
	return p
}

// SignedURL returns the web-signed URL that must be sent verbatim.
func (p *Params) SignedURL(base string, c *Client, ts int64) string {
	return SignWebURL(BuildURL(base, p.ToString()), ts, c.Cookie.Get("UIFID"))
}
