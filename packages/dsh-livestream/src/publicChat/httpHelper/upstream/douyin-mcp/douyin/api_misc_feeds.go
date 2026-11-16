package douyin

// Feeds-tab ("精选"/"推荐") module & resource endpoints as the current PC
// client loads them. These complement api_feed.go (the V1 module feed) with
// the V2 module feed plus the auxiliary blocks the 精选 page requests
// (course tags / solution resources / multicast config / page-turn offline /
// emoji list / publish highlight / mix collection / SEO inner links / study
// notes).

import (
	"context"
	"encoding/base64"
	"strconv"
	"strings"
	"unicode/utf8"

	"google.golang.org/protobuf/encoding/protowire"
)

// duProtoMessageToMap converts an arbitrary protobuf message into a best-effort
// Go map. Field numbers are kept verbatim (field_<n>); length-delimited values
// are decoded recursively when they parse cleanly as a nested message, then as
// UTF-8 strings, otherwise base64. Used for endpoints (e.g. the V2 module feed)
// that answer with `application/x-protobuf` instead of JSON.
func duProtoMessageToMap(data []byte, depth int) map[string]any {
	fields, err := imDecodeWire(data)
	if err != nil || len(fields) == 0 {
		return nil
	}
	out := map[string]any{}
	for _, f := range fields {
		key := "field_" + strconv.Itoa(int(f.num))
		var val any
		switch f.wire {
		case protowire.VarintType:
			val = f.varint
		case protowire.BytesType:
			if depth > 0 {
				if nested := duProtoMessageToMap(f.bytes, depth-1); nested != nil {
					val = nested
				}
			}
			if val == nil {
				if utf8.Valid(f.bytes) {
					val = string(f.bytes)
				} else {
					val = base64.StdEncoding.EncodeToString(f.bytes)
				}
			}
		default:
			val = base64.StdEncoding.EncodeToString(f.bytes)
		}
		if prev, ok := out[key]; ok {
			if arr, ok := prev.([]any); ok {
				out[key] = append(arr, val)
			} else {
				out[key] = []any{prev, val}
			}
		} else {
			out[key] = val
		}
	}
	return out
}

// duDecodeProtoOrJSON decodes a response body that may be JSON or protobuf.
// Protobuf bodies (e.g. the V2 module feed) bypass CheckRisk, which only
// understands JSON payloads.
func duDecodeProtoOrJSON(resp *Response) (map[string]any, error) {
	if strings.Contains(strings.ToLower(resp.HeaderGet("content-type")), "protobuf") {
		if m := duProtoMessageToMap(resp.Body, 4); m != nil {
			if v, ok := m["field_1"]; ok {
				m["status_code"] = v
			}
			m["content_type"] = "application/x-protobuf"
			return m, nil
		}
	}
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	return decodeJSONObject(resp.Body)
}

// GetChannelModuleFeed returns one page of the V2 channel module feed
// (`POST /aweme/v2/web/module/feed/`, 精选/推荐 tab). Unlike the V1 GET in
// api_feed.go this one carries the extra pull/pre-item parameters and the
// obfuscated encoded_pre_item_ids always in the form body.
//
// useLiteType 对齐浏览器实录默认 "2"（服务端返回 protobuf，已自动解码为
// map）；传 "0"/"1" 时服务端返回 JSON 原始 feed。
func (c *Client) GetChannelModuleFeed(ctx context.Context, moduleID, count, refreshIndex, useLiteType, preItemIDs, preLogID, encodedPreItemIDs, encodedPreRoomIDs string) (map[string]any, error) {
	const api = "/aweme/v2/web/module/feed/"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)

	if moduleID == "" {
		// 精选/推荐 首页 feed 的模块号；实测 17 个分类 tab 发的都是这一个。
		moduleID = "3003101"
	}
	if count == "" {
		count = "20"
	}
	if refreshIndex == "" {
		refreshIndex = "1"
	}
	if useLiteType == "" {
		// 浏览器首屏会带上 SSR 预取的 pre_item_ids，用默认的 2（lite/protobuf）
		// 才拿得到内容；脱离首屏上下文（无 pre_item_ids）时 2 会回
		// "暂时没有更多了"，所以独立调用默认用 1：同样的参数下返回 JSON
		// 视频流（实测 19-20 条）。需要与浏览器逐字节一致时显式传 2。
		useLiteType = "1"
	}

	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.Add("module_id", moduleID)
	p.Add("count", count)
	p.Add("filterGids", "")
	p.Add("presented_ids", "")
	p.Add("refresh_index", refreshIndex)
	p.Add("refer_id", "")
	p.Add("refer_type", "10")
	p.Add("pull_type", "0")
	p.Add("awemePcRecRawData", `{"is_xigua_user":0,"danmaku_switch_status":0,"is_client":false}`)
	p.Add("use_lite_type", useLiteType)
	p.Add("pre_log_id", preLogID)
	p.Add("pre_item_ids", preItemIDs)
	p.Add("pre_room_ids", "")
	p.Add("pre_item_from", "sati")
	p.Add("xigua_user", "0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())

	data := NewParams()
	data.Add("encoded_pre_item_ids", encodedPreItemIDs)
	data.Add("encoded_pre_room_ids", encodedPreRoomIDs)
	p.WithABogus(c, data)

	resp, err := c.HTTP.PostJSON(ctx, BuildURL(douyinBase+api, standardEncodeQuery(p)), headers, c.CookieStr(), "", []byte(standardEncodeQuery(data)))
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	return duDecodeProtoOrJSON(resp)
}

// GetCourseCategoryTags lists the course category tags shown on the
// 精选-page course entry (`/aweme/v1/web/douyin/select/tab/course/catagory/tag/`).
func (c *Client) GetCourseCategoryTags(ctx context.Context, tabID string) (map[string]any, error) {
	const api = "/aweme/v1/web/douyin/select/tab/course/catagory/tag/"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if tabID == "" {
		tabID = "screen_course_page"
	}
	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.Add("tab_id", tabID)
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetCourseCategoryVideos lists the 公开课 category's videos on the 精选 page
// (`/aweme/v1/web/douyin/select/tab/course/catagory/video/`). The browser pages
// with offset/size, sends tag_id_list as a JSON array and repeats the ids it has
// already rendered in id_list. 精选 的其他分类没有独立接口（见 README）。
func (c *Client) GetCourseCategoryVideos(ctx context.Context, tabID, offset, size, tagIDList, idList string) (map[string]any, error) {
	const api = "/aweme/v1/web/douyin/select/tab/course/catagory/video/"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if tabID == "" {
		tabID = "screen_course_page"
	}
	if offset == "" {
		offset = "0"
	}
	if size == "" {
		size = "6"
	}
	if tagIDList == "" {
		tagIDList = "[0,0,0]"
	}
	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.Add("tab_id", tabID)
	p.Add("offset", offset)
	p.Add("size", size)
	p.Add("tag_id_list", tagIDList)
	p.Add("id_list", idList)
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetSolutionResources resolves 精选-page subtab resources by spot key
// (`/aweme/v1/web/solution/resource/list/`).
func (c *Client) GetSolutionResources(ctx context.Context, spotKeys, appID string) (map[string]any, error) {
	const api = "/aweme/v1/web/solution/resource/list/"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if spotKeys == "" {
		spotKeys = "7359502129541449780_douyin_pc_discover_subtab"
	}
	if appID == "" {
		appID = "6383"
	}
	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.Add("spot_keys", spotKeys)
	p.Add("app_id", appID)
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetMulticastConfig fetches the PC client's multicast/switchboard config
// (`/aweme/v1/web/multicast/query/`, 精选/推荐 tab).
func (c *Client) GetMulticastConfig(ctx context.Context) (map[string]any, error) {
	const api = "/aweme/v1/web/multicast/query/"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// PageTurnOffline records a page-turn breadcrumb used by the 推荐 refresh loop
// (`POST /aweme/v1/web/page/turn/offline`).
func (c *Client) PageTurnOffline(ctx context.Context) (map[string]any, error) {
	const api = "/aweme/v1/web/page/turn/offline"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)

	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duPostFormJSON(ctx, douyinBase+api, p, headers, nil)
}

// GetEmojiList returns the comment emoji list
// (`/aweme/v1/web/emoji/list`, need_all 控制是否返回全部表情).
func (c *Client) GetEmojiList(ctx context.Context, needAll string) (map[string]any, error) {
	const api = "/aweme/v1/web/emoji/list"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if needAll == "" {
		needAll = "true"
	}
	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.Add("need_all", needAll)
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetPublishHighlight returns the creator publish highlight config
// (`/aweme/v1/creator/external/highlight/`).
func (c *Client) GetPublishHighlight(ctx context.Context, highlightType string) (map[string]any, error) {
	const api = "/aweme/v1/creator/external/highlight/"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if highlightType == "" {
		highlightType = "app_publish_and_pc_not_publish"
	}
	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.Add("highlight_type", highlightType)
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetMixListCollection lists the user's mix (合集) collection
// (`/aweme/v1/web/mix/listcollection/`, requires x-secsdk-web-signature).
func (c *Client) GetMixListCollection(ctx context.Context, cursor, count string) (map[string]any, error) {
	const api = "/aweme/v1/web/mix/listcollection/"
	refer := douyinBase + "/"
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
	p.WithPlatform("0", "170400", "17.4.0")
	p.Add("cursor", cursor)
	p.Add("count", count)
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.GetJSONSigned(ctx, douyinBase+api, p, headers)
}

// GetSEOInnerLink returns the SEO inner-link block for the 精选 page
// (`/aweme/v1/web/seo/inner/link/`).
func (c *Client) GetSEOInnerLink(ctx context.Context) (map[string]any, error) {
	const api = "/aweme/v1/web/seo/inner/link/"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetStudyNotes lists the "学习" AI-assistant notes on the 精选 page
// (`/aweme/v1/web/douyin/select/study/ai_assistant/note/list`).
func (c *Client) GetStudyNotes(ctx context.Context, offset, count, filterDraft string) (map[string]any, error) {
	const api = "/aweme/v1/web/douyin/select/study/ai_assistant/note/list"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if offset == "" {
		offset = "0"
	}
	if count == "" {
		count = "1"
	}
	if filterDraft == "" {
		filterDraft = "true"
	}
	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.Add("offset", offset)
	p.Add("count", count)
	p.Add("filter_draft", filterDraft)
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}
