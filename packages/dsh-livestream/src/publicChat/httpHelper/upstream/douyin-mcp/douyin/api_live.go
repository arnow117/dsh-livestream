package douyin

// Live-room REST APIs: room info, the live IM fetch, digg/chat writes, the
// webcast rank endpoints and the PK context/rank discovery (抖音 Web 直播端).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// liveSubHost is the live subdomain whose (aid, page_id) pair the a_bogus
// signer embeds. www/creator use different values.
const liveSubHost = "live.douyin.com"

// LivePKAPIError reports a failed PK context query. The upstream business code
// and the raw response are kept so callers can tell "not in PK" apart from
// "login required".
type LivePKAPIError struct {
	Endpoint   string
	Response   map[string]any
	StatusCode int64
}

func (e *LivePKAPIError) Error() string {
	return fmt.Sprintf("%s: status_code=%d", e.Endpoint, e.StatusCode)
}

var (
	reLiveScript     = regexp.MustCompile(`(?s)<script[^>]*\snonce\b[^>]*>(.*?)</script>`)
	reLiveUserUnique = regexp.MustCompile(`\\"user_unique_id\\":\\"(\d+)\\"`)
	reLiveRoomID     = regexp.MustCompile(`\\"roomId\\":\\"(\d+)\\"`)
	reLiveRoomInfo   = regexp.MustCompile(`\\"roomInfo\\":\{\\"room\\":\{\\"id_str\\":\\".*?\\",\\"status\\":(.*?),\\"status_str\\":\\".*?\\",\\"title\\":\\"(.*?)\\"`)
	reLiveAnchorID   = regexp.MustCompile(`\\"anchor\\":\{\\"id_str\\":\\"(\d+)\\"`)
	reLiveSecUID     = regexp.MustCompile(`\\"sec_uid\\":\\"(.*?)\\"`)

	reLiveRoomIDLoose     = regexp.MustCompile(`\\"roomId\\"\s*:\s*\\"(\d+)\\"`)
	reLiveUserUniqueLoose = regexp.MustCompile(`\\"user_unique_id\\"\s*:\s*\\"(\d+)\\"`)
	reLiveAnchorIDLoose   = regexp.MustCompile(`\\"anchor\\"\s*:\s*\{[^{}]*?\\"id_str\\"\s*:\s*\\"(\d+)\\"`)
	reLiveSecUIDLoose     = regexp.MustCompile(`\\"sec_uid\\"\s*:\s*\\"([^"]+)\\"`)
)

// liveObj returns v as a JSON object (nil when it is not one).
func liveObj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// liveArr returns v as a JSON array (nil when it is not one).
func liveArr(v any) []any {
	l, _ := v.([]any)
	return l
}

// liveTruthy reports whether a JSON-decoded value is truthy.
func liveTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case int64:
		return t != 0
	case int:
		return t != 0
	case float64:
		return t != 0
	case json.Number:
		return t.String() != "" && t.String() != "0"
	}
	return true
}

// liveString renders a JSON-decoded value as a string.
func liveString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case int64:
		return strconv.FormatInt(t, 10)
	case int:
		return strconv.Itoa(t)
	case float64:
		if !math.IsInf(t, 0) && !math.IsNaN(t) && t == math.Trunc(t) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	}
	return fmt.Sprintf("%v", v)
}

// liveIDOf ports _live_id(): it prefers "<name>_str", then "<name>", and
// returns nil for absent/empty/"0" values. The result is a string or nil.
func liveIDOf(obj map[string]any, name string) any {
	if obj == nil {
		return nil
	}
	value, ok := obj[name+"_str"]
	if !ok || !liveTruthy(value) {
		value, ok = obj[name]
	}
	if !ok || !liveTruthy(value) {
		return nil
	}
	s := liveString(value)
	if s == "" || s == "0" {
		return nil
	}
	return s
}

// liveIDText is liveIDOf for callers that only need the string form.
func liveIDText(obj map[string]any, name string) string {
	return liveString(liveIDOf(obj, name))
}

// liveDecodeJSON decodes a JSON object while preserving 64-bit integer ids.
// encoding/json would decode every number into float64 and silently corrupt
// ids above 2^53, which the live APIs are full of.
func liveDecodeJSON(body []byte) (map[string]any, error) {
	var raw any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode json: %w", err)
	}
	converted, _ := liveConvertNumbers(raw).(map[string]any)
	if converted == nil {
		return nil, fmt.Errorf("decode json: 顶层不是对象")
	}
	return converted, nil
}

// liveConvertNumbers rewrites json.Number into int64 or float64, recursively.
func liveConvertNumbers(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k := range t {
			t[k] = liveConvertNumbers(t[k])
		}
		return t
	case []any:
		for i := range t {
			t[i] = liveConvertNumbers(t[i])
		}
		return t
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return n
		}
		if f, err := t.Float64(); err == nil {
			return f
		}
		return t.String()
	}
	return v
}

// liveFormEncode encodes query and form bodies like the web client
// (space becomes '+', everything outside A-Za-z0-9-_.~ is escaped).
func liveFormEncode(pairs [][2]string) string {
	var sb strings.Builder
	for i, kv := range pairs {
		if i > 0 {
			sb.WriteByte('&')
		}
		sb.WriteString(url.QueryEscape(kv[0]))
		sb.WriteByte('=')
		sb.WriteString(url.QueryEscape(kv[1]))
	}
	return sb.String()
}

// liveIsDigits reports whether s is a non-empty ASCII digit string.
func liveIsDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// LiveWebRID normalises a web_rid: either the room number itself or a
// https://live.douyin.com/<number> URL.
func (c *Client) LiveWebRID(value string) (string, error) {
	v := strings.TrimSpace(value)
	if liveIsDigits(v) {
		return v, nil
	}
	parsed, err := url.Parse(v)
	if err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Hostname() == liveSubHost {
		rid := strings.Trim(parsed.Path, "/")
		if liveIsDigits(rid) {
			return rid, nil
		}
	}
	return "", fmt.Errorf("web_rid 需要直播间号或 https://live.douyin.com/<直播间号>")
}

// GetLiveInfo loads the live landing page and extracts the ids the WebSocket
// handshake needs. The response rotates ttwid, so Set-Cookie is absorbed
// before reading it back.
func (c *Client) GetLiveInfo(ctx context.Context, liveID string) (map[string]any, error) {
	prof := GetProfile()
	headers := Headers{
		{Name: "accept", Value: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
		{Name: "accept-language", Value: "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7,ja;q=0.6"},
		{Name: "cache-control", Value: "no-cache"},
		{Name: "pragma", Value: "no-cache"},
		{Name: "priority", Value: "u=0, i"},
		{Name: "referer", Value: liveBase + "/?from_nav=1"},
		{Name: "sec-ch-ua", Value: `"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"`},
		{Name: "sec-ch-ua-mobile", Value: "?0"},
		{Name: "sec-ch-ua-platform", Value: `"Windows"`},
		{Name: "sec-fetch-dest", Value: "empty"},
		{Name: "sec-fetch-mode", Value: "navigate"},
		{Name: "sec-fetch-site", Value: "same-origin"},
		{Name: "upgrade-insecure-requests", Value: "1"},
		{Name: "user-agent", Value: prof.UA},
	}
	resp, err := c.HTTP.Get(ctx, liveBase+"/"+liveID, headers, c.CookieStr())
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	ttwid := ""
	for _, ck := range resp.Cookies {
		if ck.Name == "ttwid" && ck.Value != "" {
			ttwid = ck.Value
		}
	}
	if ttwid == "" {
		ttwid = c.Cookie.Get("ttwid")
	}
	if info, ok := parseLiveInfoPage(resp.Text(), ttwid); ok {
		return info, nil
	}
	return nil, fmt.Errorf("未能解析直播间信息: %s", liveID)
}

// parseLiveInfoPage extracts the ids from the SSR room page. It scans the
// nonce scripts first and falls back to the whole document for edges that
// return a server-rendered JSON blob without a nonce attribute.
func parseLiveInfoPage(text, ttwid string) (map[string]any, bool) {
	for _, match := range reLiveScript.FindAllStringSubmatch(text, -1) {
		script := match[1]
		if !strings.Contains(script, "roomId") {
			continue
		}
		roomID := sub1(reLiveRoomID, script)
		userID := sub1(reLiveUserUnique, script)
		roomInfo := reLiveRoomInfo.FindStringSubmatch(script)
		anchorID := sub1(reLiveAnchorID, script)
		secUID := sub1(reLiveSecUID, script)
		if roomID == "" || userID == "" || roomInfo == nil || anchorID == "" || secUID == "" {
			continue
		}
		return map[string]any{
			"room_id":        roomID,
			"user_id":        userID,
			"user_unique_id": userID,
			"anchor_id":      anchorID,
			"sec_uid":        secUID,
			"ttwid":          ttwid,
			// 2 是直播中 4 是未开播
			"room_status": roomInfo[1],
			"room_title":  roomInfo[2],
		}, true
	}
	if strings.Contains(text, "roomId") {
		roomID := sub1(reLiveRoomIDLoose, text)
		userID := sub1(reLiveUserUniqueLoose, text)
		anchorID := sub1(reLiveAnchorIDLoose, text)
		secUID := sub1(reLiveSecUIDLoose, text)
		if roomID != "" && userID != "" {
			if anchorID == "" {
				anchorID = userID
			}
			return map[string]any{
				"room_id":        roomID,
				"user_id":        userID,
				"user_unique_id": userID,
				"anchor_id":      anchorID,
				"sec_uid":        secUID,
				"ttwid":          ttwid,
			}, true
		}
	}
	return nil, false
}

func sub1(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

// liveCSRFHeader mirrors HeaderBuilder.with_csrf(): the live/XHR write paths
// carry x-secsdk-csrf-token. It is a no-op when the token cannot be fetched.
func (c *Client) liveCSRFHeader(ctx context.Context, headers *Headers, origin, path string) {
	if csrf := c.CSRFToken(ctx, origin, path); csrf != "" {
		headers.Set("x-secsdk-csrf-token", csrf)
	}
}

// GetWebcastDetail performs the /webcast/im/fetch/ protobuf handshake used to
// seed the WebSocket listener and returns the raw protobuf body.
func (c *Client) GetWebcastDetail(ctx context.Context, userID, roomID, pageURL string) ([]byte, error) {
	const api = "/webcast/im/fetch/"
	prof := GetProfile()
	headers := BuildHeaders(HeaderFORM)
	headers.Set("origin", liveBase)
	headers.SetReferer(pageURL)
	c.liveCSRFHeader(ctx, &headers, liveBase, api)

	p := NewParams()
	p.Add("resp_content_type", "protobuf")
	p.Add("did_rule", "3")
	p.Add("device_id", "")
	p.Add("app_name", "douyin_web")
	p.Add("endpoint", "live_pc")
	p.Add("support_wrds", "1")
	p.Add("user_unique_id", userID)
	p.Add("identity", "audience")
	p.Add("need_persist_msg_count", "15")
	p.Add("insert_task_id", "")
	p.Add("live_reason", "")
	p.Add("room_id", roomID)
	p.Add("version_code", "180800")
	p.Add("last_rtt", "0")
	p.Add("live_id", "1")
	p.Add("aid", "6383")
	p.Add("fetch_rule", "1")
	p.Add("cursor", "")
	p.Add("internal_ext", "")
	p.Add("device_platform", "web")
	p.Add("cookie_enabled", "true")
	p.Add("screen_width", prof.ScreenWidth)
	p.Add("screen_height", prof.ScreenHeight)
	p.Add("browser_language", "zh-CN")
	p.Add("browser_platform", prof.Platform)
	// webcast 这一路的 browser_version 传的是 navigator.appVersion（UA 去掉 Mozilla/ 前缀）
	p.Add("browser_name", "Mozilla")
	p.Add("browser_version", strings.Replace(prof.UA, "Mozilla/", "", 1))
	p.Add("browser_online", "true")
	p.Add("tz_name", "Asia/Shanghai")
	p.Add("msToken", c.MsToken())
	p.WithABogusHost(c, nil, liveSubHost)

	// browser_version carries spaces; the verbatim ToString() form would break
	// the request line, so send the percent-encoded query the signer hashed.
	resp, err := c.HTTP.Get(ctx, BuildURL(liveBase+api, p.SpliceURL()), headers, c.CookieStr())
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

// DiggLiveRoom sends room likes.
func (c *Client) DiggLiveRoom(ctx context.Context, roomID, count string) (map[string]any, error) {
	const api = "/webcast/room/like/"
	prof := GetProfile()
	headers := BuildHeaders(HeaderFORM)
	headers.Set("origin", douyinBase)
	c.liveCSRFHeader(ctx, &headers, liveBase, api)
	headers.SetReferer(liveBase + "/" + roomID)

	p := NewParams()
	p.Add("aid", "6383")
	p.Add("app_name", "douyin_web")
	p.Add("live_id", "1")
	p.Add("device_platform", "web")
	p.Add("language", "zh-CN")
	p.Add("enter_from", "web_live")
	p.Add("cookie_enabled", "true")
	p.Add("screen_width", prof.ScreenWidth)
	p.Add("screen_height", prof.ScreenHeight)
	p.Add("browser_language", "zh-CN")
	p.Add("browser_platform", "Win32")
	p.Add("browser_name", prof.BrowserName)
	p.Add("browser_version", prof.BrowserVersion)
	p.Add("room_id", roomID)
	p.Add("count", count)
	p.Add("msToken", c.MsToken())
	p.WithABogusHost(c, NewParams(), liveSubHost)

	resp, err := c.PostForm(ctx, liveBase+api, p, headers, "")
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	return liveDecodeJSON(resp.Body)
}

// SendMsgInRoom posts a danmaku comment. The live origin must be used for both
// the Origin header and the bd-ticket certificate exchange; reusing the main
// site origin yields an empty response.
func (c *Client) SendMsgInRoom(ctx context.Context, roomID, content string) (map[string]any, error) {
	const api = "/webcast/room/chat/"
	prof := GetProfile()
	headers := BuildHeaders(HeaderGET)
	headers.Set("Origin", liveBase)
	if err := headers.WithBD(ctx, c, api, 6383, liveBase, false); err != nil {
		return nil, err
	}
	c.liveCSRFHeader(ctx, &headers, liveBase, api)
	headers.SetReferer(liveBase + "/" + roomID)

	p := NewParams()
	p.Add("aid", "6383")
	p.Add("app_name", "douyin_web")
	p.Add("live_id", "1")
	p.Add("device_platform", "web")
	p.Add("language", "zh-CN")
	p.Add("enter_from", "link_share")
	p.Add("cookie_enabled", "true")
	p.Add("screen_width", prof.ScreenWidth)
	p.Add("screen_height", prof.ScreenHeight)
	p.Add("browser_language", "zh-CN")
	p.Add("browser_platform", "Win32")
	p.Add("browser_name", prof.BrowserName)
	p.Add("browser_version", prof.BrowserVersion)
	p.Add("room_id", roomID)
	p.Add("content", content)
	p.Add("type", "0")
	p.Add("msToken", c.MsToken())
	p.WithABogusHost(c, nil, liveSubHost)

	// a_bogus signs p.SpliceURL(), so the wire query must be byte-identical to
	// it. GetParams would send p.ToString() (raw values); the msToken "=" and
	// the browser_version spaces then stop matching the signature and the
	// webcast gateway answers HTTP 200 with an empty body.
	resp, err := c.HTTP.Get(ctx, BuildURL(liveBase+api, p.SpliceURL()), headers, c.CookieStr())
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	return liveDecodeJSON(resp.Body)
}

// liveWeb performs the shared live.douyin.com GET: the fixed common query
// block, then the endpoint params in the caller's order, msToken and a_bogus.
func (c *Client) liveWeb(ctx context.Context, api string, endpointParams [][2]string, webRID, enterFrom string) (map[string]any, error) {
	prof := GetProfile()
	headers := BuildHeaders(HeaderGET)
	referer := liveBase
	if webRID != "" {
		referer = liveBase + "/" + webRID
	}
	headers.SetReferer(referer)

	p := NewParams()
	for _, kv := range [][2]string{
		{"aid", "6383"},
		{"app_name", "douyin_web"},
		{"live_id", "1"},
		{"device_platform", "web"},
		{"language", "zh-CN"},
		{"enter_from", enterFrom},
		{"cookie_enabled", "true"},
		{"screen_width", prof.ScreenWidth},
		{"screen_height", prof.ScreenHeight},
		{"browser_language", "zh-CN"},
		{"browser_platform", prof.Platform},
		{"browser_name", prof.BrowserName},
		{"browser_version", prof.BrowserVersion},
		{"os_name", "Windows"},
		{"os_version", "10"},
	} {
		p.Add(kv[0], kv[1])
	}
	for _, kv := range endpointParams {
		p.Add(kv[0], kv[1])
	}
	p.Add("msToken", c.MsToken())
	p.WithABogusHost(c, nil, liveSubHost)

	// a_bogus signs p.SpliceURL(), so the wire query must be byte-identical to
	// it. GetParams would send p.ToString() (raw values); the msToken "=" and
	// the browser_version spaces then stop matching the signature and the
	// webcast gateway answers HTTP 200 with an empty body.
	resp, err := c.HTTP.Get(ctx, BuildURL(liveBase+api, p.SpliceURL()), headers, c.CookieStr())
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	return liveDecodeJSON(resp.Body)
}

// GetLiveRoomEnter returns the raw room profile (real room_id, owner and
// linker_map).
func (c *Client) GetLiveRoomEnter(ctx context.Context, webRID string) (map[string]any, error) {
	rid, err := c.LiveWebRID(webRID)
	if err != nil {
		return nil, err
	}
	return c.liveWeb(ctx, "/webcast/room/web/enter/", [][2]string{{"web_rid", rid}}, rid, "link_share")
}

// liveLinkmicList is the anchor-aware连麦 snapshot probe. anchorID is part of
// the wire contract but is not exposed by GetLiveLinkmicList's public
// signature; GetLivePKContext uses this variant.
func (c *Client) liveLinkmicList(ctx context.Context, roomID, channelID, anchorID, webRID string) (map[string]any, error) {
	return c.liveWeb(ctx, "/webcast/linkmic/list/", [][2]string{
		{"room_id", roomID},
		{"channel_id", channelID},
		{"offset", "0"},
		{"count", "50"},
		{"link_status", "4"},
		{"scene", "1"},
		{"request_source", "audience_enter_room"},
		{"anchor_id", anchorID},
	}, webRID, "link_share")
}

// GetLiveLinkmicList returns the raw连麦 snapshot. Without a battle_stats
// member there is no usable PK snapshot. The anchor_id filter the upstream
// endpoint expects is only available through GetLivePKContext.
func (c *Client) GetLiveLinkmicList(ctx context.Context, roomID, channelID string) (map[string]any, error) {
	return c.liveLinkmicList(ctx, roomID, channelID, "", "")
}

// livePKContributionRank keeps web_rid on the referer; only GetLivePKRank can
// supply it because GetLivePKContributionRank's public signature has none.
func (c *Client) livePKContributionRank(ctx context.Context, channelID, anchorID, webRID string) (map[string]any, error) {
	return c.liveWeb(ctx, "/webcast/linkmic/battle/ranklist_armies/", [][2]string{
		{"channel_id", channelID},
		{"anchor_id", anchorID},
	}, webRID, "link_share")
}

// GetLivePKContributionRank returns one side's PK contribution rank. It is not
// the room's regular contribution rank and exposes no battle_id.
func (c *Client) GetLivePKContributionRank(ctx context.Context, channelID, anchorID string) (map[string]any, error) {
	return c.livePKContributionRank(ctx, channelID, anchorID, "")
}

// GetLivePKContext discovers the current PK context for a room.
//
// A nil battle_id means there is no usable PK context. Upstream failures are
// returned as *LivePKAPIError so a login failure is never mistaken for "no
// PK". channelID may be "" to auto-discover it from the room's linker_map.
func (c *Client) GetLivePKContext(ctx context.Context, webRID, channelID string) (map[string]any, error) {
	rid, err := c.LiveWebRID(webRID)
	if err != nil {
		return nil, err
	}
	roomResponse, err := c.GetLiveRoomEnter(ctx, rid)
	if err != nil {
		return nil, err
	}
	if toInt64(roomResponse["status_code"]) != 0 {
		return nil, &LivePKAPIError{Endpoint: "room/web/enter", Response: roomResponse,
			StatusCode: toInt64(roomResponse["status_code"])}
	}
	state := newLivePKContext(rid, channelID, roomResponse)
	if !state.ready() {
		return state.result(), nil
	}
	snapshot, err := c.liveLinkmicList(ctx, liveString(state.context["room_id"]), state.channel,
		liveString(state.context["anchor_id"]), rid)
	if err != nil {
		return nil, err
	}
	if toInt64(snapshot["status_code"]) != 0 {
		return nil, &LivePKAPIError{Endpoint: "linkmic/list", Response: snapshot,
			StatusCode: toInt64(snapshot["status_code"])}
	}
	state.applySnapshot(snapshot)
	return state.result(), nil
}

// livePKContext accumulates the PK context while the room profile and the
// linkmic snapshot are read.
type livePKContext struct {
	context map[string]any
	anchors []map[string]any
	index   map[string]int
	channel string
}

// newLivePKContext ports the first half of get_live_pk_context: the room
// profile supplies room_id / anchor_id / channel_id and the owner anchor.
func newLivePKContext(webRID, channelID string, roomResponse map[string]any) *livePKContext {
	rooms := liveArr(liveObj(roomResponse["data"])["data"])
	var room map[string]any
	if len(rooms) > 0 {
		room = liveObj(rooms[0])
	}
	owner := liveObj(room["owner"])
	roomID := liveIDOf(room, "id")
	anchorID := liveIDOf(owner, "id")
	chID := channelID
	if chID == "" {
		chID = liveIDText(liveObj(room["linker_map"]), "1")
	}
	state := &livePKContext{
		context: map[string]any{
			"web_rid":      webRID,
			"room_id":      roomID,
			"anchor_id":    anchorID,
			"channel_id":   nilOrString(chID),
			"battle_id":    nil,
			"finished":     nil,
			"anchors":      []any{},
			"battle_stats": map[string]any{},
		},
		index:   map[string]int{},
		channel: chID,
	}
	state.addAnchor(liveString(anchorID), map[string]any{
		"anchor_id": anchorID,
		"nickname":  liveString(owner["nickname"]),
		"room_id":   roomID,
	})
	return state
}

func (s *livePKContext) addAnchor(id string, item map[string]any) {
	if id == "" {
		return
	}
	if at, ok := s.index[id]; ok {
		s.anchors[at] = item
		return
	}
	s.index[id] = len(s.anchors)
	s.anchors = append(s.anchors, item)
}

// ready reports whether the room profile identified the room, the anchor and
// the channel; otherwise the partial context is returned without querying the
// linkmic snapshot.
func (s *livePKContext) ready() bool {
	return liveString(s.context["room_id"]) != "" &&
		liveString(s.context["anchor_id"]) != "" && s.channel != ""
}

// applySnapshot ports the second half of get_live_pk_context: the linkmic
// snapshot fills the battle id and adds the identified anchors plus the
// conservative extras from scores/armies.
func (s *livePKContext) applySnapshot(snapshot map[string]any) {
	stats := liveObj(liveObj(snapshot["data"])["battle_stats"])
	if stats == nil {
		stats = map[string]any{}
	}
	settings := liveObj(stats["battle_settings"])
	channel := liveIDText(settings, "channel_id")
	if channel == "" {
		channel = s.channel
	}
	s.context["battle_id"] = liveIDOf(settings, "battle_id")
	s.context["channel_id"] = nilOrString(channel)
	s.context["finished"] = settings["finished"]
	s.context["battle_stats"] = stats

	userInfos := liveObj(stats["user_infos"])
	for _, uid := range sortedKeys(userInfos) {
		info := liveObj(userInfos[uid])
		user := liveObj(info["user"])
		id := liveIDText(user, "user_id")
		if id == "" {
			id = liveIDText(user, "id")
		}
		if id == "" {
			id = uid
		}
		nickname := liveString(user["nick_name"])
		if nickname == "" {
			nickname = liveString(user["nickname"])
		}
		s.addAnchor(id, map[string]any{
			"anchor_id": id,
			"nickname":  nickname,
			"room_id":   liveIDOf(info, "room_id"),
		})
	}
	// Some modes omit user_infos but still identify sides in scores/armies.
	rows := slices.Concat(liveArr(stats["battle_scores"]), liveArr(stats["battle_armies"]))
	for _, row := range rows {
		item := liveObj(row)
		uid := liveIDText(item, "user_id")
		if uid == "" {
			uid = liveIDText(item, "anchor_id")
		}
		if uid == "" {
			continue
		}
		if _, ok := s.index[uid]; ok {
			continue
		}
		s.addAnchor(uid, map[string]any{"anchor_id": uid, "nickname": "", "room_id": nil})
	}
}

// result renders the context with the anchors in insertion order.
func (s *livePKContext) result() map[string]any {
	out := make([]any, 0, len(s.anchors))
	for _, a := range s.anchors {
		out = append(out, a)
	}
	s.context["anchors"] = out
	return s.context
}

// nilOrString returns nil for the empty string so the context mirrors the
// JSON null values.
func nilOrString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// sortedKeys returns the object's keys in ascending order. Go maps have no
// inherent order, so a deterministic order is used.
func sortedKeys(obj map[string]any) []string {
	return slices.Sorted(maps.Keys(obj))
}

// GetLivePKRank queries the PK rank of the current battle, or of every
// anchor when side is "both". No polling is performed.
//
// state is one of ok / context_changed / api_error / not_in_pk. When
// context_changed, the ranks must not be attributed to the earlier battle.
func (c *Client) GetLivePKRank(ctx context.Context, webRID, side string) (map[string]any, error) {
	if side != "current" && side != "both" {
		return nil, fmt.Errorf("side 只支持 'current' 或 'both'")
	}
	before, err := c.GetLivePKContext(ctx, webRID, "")
	if err != nil {
		return nil, err
	}
	ranks := map[string]any{}
	result := map[string]any{
		"state":         "not_in_pk",
		"context":       before,
		"context_after": nil,
		"ranks":         ranks,
	}
	battleID := liveString(before["battle_id"])
	if battleID == "" {
		return result, nil
	}
	var anchorIDs []string
	if side == "current" {
		if id := liveString(before["anchor_id"]); id != "" {
			anchorIDs = append(anchorIDs, id)
		}
	} else {
		for _, item := range liveArr(before["anchors"]) {
			if id := liveString(liveObj(item)["anchor_id"]); id != "" {
				anchorIDs = append(anchorIDs, id)
			}
		}
	}
	channelID := liveString(before["channel_id"])
	rankWebRID := liveString(before["web_rid"])
	for _, anchorID := range anchorIDs {
		rank, err := c.livePKContributionRank(ctx, channelID, anchorID, rankWebRID)
		if err != nil {
			return nil, err
		}
		ranks[anchorID] = rank
	}
	after, err := c.GetLivePKContext(ctx, webRID, "")
	if err != nil {
		return nil, err
	}
	result["context_after"] = after
	changed := false
	for _, key := range []string{"room_id", "anchor_id", "channel_id", "battle_id"} {
		if liveString(before[key]) != liveString(after[key]) {
			changed = true
			break
		}
	}
	if changed {
		result["state"] = "context_changed"
		return result, nil
	}
	for _, value := range ranks {
		if toInt64(liveObj(value)["status_code"]) != 0 {
			result["state"] = "api_error"
			return result, nil
		}
	}
	result["state"] = "ok"
	return result, nil
}

// liveContributionRank is the anchor-aware /webcast/ranklist/audience/ query.
func (c *Client) liveContributionRank(ctx context.Context, roomID, anchorID, secAnchorID, webRID string) (map[string]any, error) {
	return c.liveWeb(ctx, "/webcast/ranklist/audience/", [][2]string{
		{"webcast_sdk_version", "2450"},
		{"room_id", roomID},
		{"anchor_id", anchorID},
		{"sec_anchor_id", secAnchorID},
		{"ignoreToast", "true"},
		{"rank_type", "30"},
	}, webRID, "web_live")
}

// GetLiveContributionRank returns the room's contribution rank.
func (c *Client) GetLiveContributionRank(ctx context.Context, roomID, anchorID string) (map[string]any, error) {
	return c.liveContributionRank(ctx, roomID, anchorID, "", "")
}

// GetLiveThousandTicketRank returns the "1000贡献用户" seat list. It requires a
// full login session (status_code=20003 means the cookies need refreshing).
func (c *Client) GetLiveThousandTicketRank(ctx context.Context, roomID, webRID string) (map[string]any, error) {
	return c.liveWeb(ctx, "/webcast/ranklist/paygrade_seats/", [][2]string{
		{"webcast_sdk_version", "2450"},
		{"room_id", roomID},
		{"seats_type", "2"},
	}, webRID, "web_live")
}

// GetRankList is the legacy alias of the contribution rank.
func (c *Client) GetRankList(ctx context.Context, roomID, anchorID, secAnchorID string) (map[string]any, error) {
	return c.liveContributionRank(ctx, roomID, anchorID, secAnchorID, "")
}
