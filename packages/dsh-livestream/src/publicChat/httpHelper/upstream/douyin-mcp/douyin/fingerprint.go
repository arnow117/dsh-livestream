package douyin

// Browser fingerprint profile.
// Every request must report the same hardware/geometry as the browser that
// produced the cookies; DY_FP_* env vars override individual fields.

import (
	"cmp"
	"os"
	"strconv"
)

// Profile is the process-wide fingerprint档案.
type Profile struct {
	UA              string
	SecCHUA         string
	SecCHUAPlatform string
	BrowserName     string
	BrowserVersion  string
	EngineName      string
	EngineVersion   string
	OSName          string
	OSVersion       string
	Platform        string
	CpuCoreNum      string
	DeviceMemory    string
	WebGLVendor     string
	WebGLRenderer   string
	ScreenWidth     string
	ScreenHeight    string
	ScreenX         int
	ScreenY         int
	AcceptLanguage  string
	Geo             [8]int
}

var (
	defaultUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
	defaultAcceptLanguage = "zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7,ja;q=0.6"
	// 中性机型：常见的集显 + 常见分辨率，避免默认值暴露某一台具体机器。
	defaultWebGLVendor   = "Google Inc. (Intel)"
	defaultWebGLRenderer = "ANGLE (Intel, Intel(R) UHD Graphics 630 " +
		"Direct3D11 vs_5_0 ps_5_0, D3D11)"
)

func fpEnv(key, def string) string {
	return cmp.Or(os.Getenv("DY_FP_"+key), def)
}

func fpEnvInt(key string, def int) int {
	v := os.Getenv("DY_FP_" + key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

var profileCache *Profile

// GetProfile returns the singleton fingerprint profile.
func GetProfile() *Profile {
	if profileCache != nil {
		return profileCache
	}
	ua := fpEnv("UA", defaultUA)
	browserVersion := fpEnv("BROWSER_VERSION", "151.0.0.0")
	major := browserVersion
	for i := range len(major) {
		if major[i] == '.' {
			major = major[:i]
			break
		}
	}
	p := &Profile{
		UA:              ua,
		SecCHUA:         `"Not=A?Brand";v="99", "Google Chrome";v="` + major + `", "Chromium";v="` + major + `"`,
		SecCHUAPlatform: `"Windows"`,
		BrowserName:     "Chrome",
		BrowserVersion:  browserVersion,
		EngineName:      "Blink",
		EngineVersion:   fpEnv("ENGINE_VERSION", "151.0.0.0"),
		OSName:          "Windows",
		OSVersion:       "10",
		Platform:        "Win32",
		CpuCoreNum:      fpEnv("CPU_CORE_NUM", "8"),
		DeviceMemory:    fpEnv("DEVICE_MEMORY", "8"),
		WebGLVendor:     fpEnv("WEBGL_VENDOR", defaultWebGLVendor),
		WebGLRenderer:   fpEnv("WEBGL_RENDERER", defaultWebGLRenderer),
		ScreenWidth:     fpEnv("SCREEN_WIDTH", "1920"),
		ScreenHeight:    fpEnv("SCREEN_HEIGHT", "1080"),
		ScreenX:         fpEnvInt("SCREEN_X", 0),
		ScreenY:         fpEnvInt("SCREEN_Y", 0),
		AcceptLanguage:  fpEnv("ACCEPT_LANGUAGE", defaultAcceptLanguage),
	}
	w, _ := strconv.Atoi(p.ScreenWidth)
	h, _ := strconv.Atoi(p.ScreenHeight)
	innerW := fpEnvInt("INNER_WIDTH", w)
	innerH := fpEnvInt("INNER_HEIGHT", h-225)
	outerW := fpEnvInt("OUTER_WIDTH", w)
	outerH := fpEnvInt("OUTER_HEIGHT", h-48)
	availW := fpEnvInt("AVAIL_WIDTH", w)
	availH := fpEnvInt("AVAIL_HEIGHT", h-48)
	p.Geo = [8]int{innerW, innerH, outerW, outerH, availW, availH, w, h}
	profileCache = p
	return p
}
