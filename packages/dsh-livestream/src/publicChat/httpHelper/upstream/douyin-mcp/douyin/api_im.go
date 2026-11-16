package douyin

// PC IM (private message) endpoints: conversation creation, conversation list,
// identity security token and raw message send plus the rich-message helpers,
// and the protobuf envelope builder.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	mrand "math/rand/v2"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/dynamicpb"
)

const (
	imapiBase                  = "https://imapi.douyin.com"
	imConversationCreatePath   = "/v2/conversation/create"
	imConversationInfoListPath = "/v2/conversation/get_info_list"
	imMessageSendPath          = "/v1/message/send"
	imIdentityTokenPath        = "/passport/safe/get_identity_security_token/"

	// Envelope constants for the PC IM client (independent of the main-site
	// version).
	imSDKVersion   = "0.1.8"
	imBuildNumber  = "0d50935:feat/pc-im-group"
	imVersionCode  = "360000"
	imDeviceIDHard = "0"
)

// imIdentityToken caches the short-lived identity-security material per client.
type imIdentityToken struct {
	token    string
	deviceID string
	ts       time.Time
}

var imIdentityCache sync.Map // *Client -> imIdentityToken

// ---------------------------------------------------------------------------
// Protobuf helpers
// ---------------------------------------------------------------------------

func pbFD(m *dynamicpb.Message, name string) protoreflect.FieldDescriptor {
	return m.Descriptor().Fields().ByName(protoreflect.Name(name))
}

func pbSub(m *dynamicpb.Message, name string) (*dynamicpb.Message, error) {
	fd := pbFD(m, name)
	if fd == nil {
		return nil, fmt.Errorf("proto field not found: %s", name)
	}
	sub, ok := m.Mutable(fd).Message().Interface().(*dynamicpb.Message)
	if !ok {
		return nil, fmt.Errorf("proto field %s is not a message", name)
	}
	return sub, nil
}

func pbSetMapString(m *dynamicpb.Message, field string, kv [][2]string) error {
	fd := pbFD(m, field)
	if fd == nil {
		return fmt.Errorf("proto field not found: %s", field)
	}
	mp := m.Mutable(fd).Map()
	for _, pair := range kv {
		mp.Set(protoreflect.ValueOfString(pair[0]).MapKey(), protoreflect.ValueOfString(pair[1]))
	}
	return nil
}

func pbAppendExt(m *dynamicpb.Message, key, value string) error {
	fd := pbFD(m, "ext")
	if fd == nil {
		return fmt.Errorf("proto field not found: ext")
	}
	ev := dynamicpb.NewMessage(fd.Message())
	if err := SetProtoField(ev, "key", key); err != nil {
		return err
	}
	if err := SetProtoField(ev, "value", value); err != nil {
		return err
	}
	m.Mutable(fd).List().Append(protoreflect.ValueOfMessage(ev))
	return nil
}

// imNewNormalRequest builds the shared PC IM envelope.
func imNewNormalRequest(cmd int64) (*dynamicpb.Message, error) {
	req, err := ProtoNew("Request")
	if err != nil {
		return nil, err
	}
	prof := GetProfile()
	browserVersion := strings.Replace(prof.UA, "Mozilla/", "", 1)
	scalars := []struct {
		name  string
		value any
	}{
		{"cmd", cmd},
		{"sequence_id", int64(mrand.IntN(1001) + 10000)},
		{"sdk_version", imSDKVersion},
		{"refer", int64(3)},
		{"inbox_type", int64(0)},
		{"build_number", imBuildNumber},
		{"device_id", imDeviceIDHard},
		{"device_platform", "douyin_pc"},
		{"version_code", imVersionCode},
		{"auth_type", int64(4)},
		{"biz", "douyin_web"},
		{"access", "web_sdk"},
	}
	for _, s := range scalars {
		if err := SetProtoField(req, s.name, s.value); err != nil {
			return nil, err
		}
	}
	headers := [][2]string{
		{"session_aid", "6383"},
		{"session_did", "0"},
		{"app_name", "douyin_pc"},
		{"priority_region", "cn"},
		{"user_agent", prof.UA},
		{"cookie_enabled", "true"},
		{"browser_language", "zh-CN"},
		{"browser_platform", "Win32"},
		{"browser_name", "Mozilla"},
		{"browser_version", browserVersion},
		{"browser_online", "true"},
		{"screen_width", prof.ScreenWidth},
		{"screen_height", prof.ScreenHeight},
		{"referer", "https://www.douyin.com/jingxuan"},
		{"timezone_name", "Asia/Shanghai"},
		{"deviceId", "0"},
		{"is-retry", "0"},
	}
	if err := pbSetMapString(req, "headers", headers); err != nil {
		return nil, err
	}
	return req, nil
}

// imEncodeContent mirrors build_send_message_request's content encoding: maps
// and lists become compact JSON, strings pass through verbatim.
func imEncodeContent(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprint(v)
		}
		return string(b)
	}
}

// imUUID4 returns a random UUID-v4 string.
func imUUID4() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// Fall back to a time-seeded value; UUIDs here are only correlation ids.
		return fmt.Sprintf("%d-%d", time.Now().UnixNano(), mrand.Int64())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// imTraceID8 mirrors uuid.uuid4().hex[:8].
func imTraceID8() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%08x", mrand.Uint32())
	}
	return hex.EncodeToString(b)[:8]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// CreateConversation creates a 1:1 private-message conversation and returns
// its id, short id and ticket.
func (c *Client) CreateConversation(ctx context.Context, toUserID int64) (conversationID string, conversationShortID int64, ticket string, err error) {
	myID, err := c.UID(ctx)
	if err != nil {
		return "", 0, "", err
	}
	req, err := imNewNormalRequest(609)
	if err != nil {
		return "", 0, "", err
	}
	body, err := pbSub(req, "body")
	if err != nil {
		return "", 0, "", err
	}
	conv, err := pbSub(body, "create_conversation_v2_body")
	if err != nil {
		return "", 0, "", err
	}
	if err := SetProtoField(conv, "conversation_type", int64(1)); err != nil {
		return "", 0, "", err
	}
	parts := conv.Mutable(pbFD(conv, "participants")).List()
	parts.Append(protoreflect.ValueOfInt64(toUserID))
	parts.Append(protoreflect.ValueOfInt64(myID))

	// The create-conversation request signs this exact ordered JSON object (a
	// Go map would sort the keys, so the order is fixed literally).
	signInput := fmt.Sprintf(
		`{"sign_data":"avatar_url=&idempotent_id=&name=&participants=%d,%d","certType":"cookie","scene":"web_protect"}`,
		toUserID, myID,
	)
	sign, err := GetReqSign(signInput, c.PrivateKey)
	if err != nil {
		return "", 0, "", err
	}
	if err := SetProtoField(req, "reuqest_sign", sign); err != nil {
		return "", 0, "", err
	}

	payload, err := ProtoMarshal(req)
	if err != nil {
		return "", 0, "", err
	}
	headers := BuildHeaders(HeaderPROTOBUF)
	headers.SetReferer("https://www.douyin.com/")
	resp, err := c.HTTP.PostJSON(ctx, imapiBase+imConversationCreatePath, headers, c.CookieStr(), "", payload)
	if err != nil {
		return "", 0, "", err
	}
	respMsg, err := ProtoUnmarshal("Response", resp.Body)
	if err != nil {
		return "", 0, "", err
	}
	respJSON, err := ProtoToMap(respMsg)
	if err != nil {
		return "", 0, "", err
	}
	list := imDigList(respJSON, "body", "create_conversation_v2_body", "conversation_info_list")
	if len(list) == 0 {
		return "", 0, "", fmt.Errorf("创建会话响应缺少 conversation_info_list: %v", respJSON)
	}
	info, _ := list[0].(map[string]any)
	conversationID, _ = info["conversation_id"].(string)
	conversationShortID = toInt64(info["conversation_short_id"])
	ticket, _ = info["ticket"].(string)
	if conversationID == "" {
		return "", 0, "", fmt.Errorf("创建会话响应缺少 conversation_id: %v", respJSON)
	}
	return conversationID, conversationShortID, ticket, nil
}

// GetConversationList queries a single conversation's info. Despite the name
// the endpoint returns one conversation; the owner uid/sec_uid fields are not
// covered by the shared .proto schema, so they are decoded from their wire
// field numbers.
func (c *Client) GetConversationList(ctx context.Context, toUserID int64, conversationShortID int64) (map[string]any, error) {
	myID, err := c.UID(ctx)
	if err != nil {
		return nil, err
	}
	req, err := imNewNormalRequest(610)
	if err != nil {
		return nil, err
	}
	body, err := pbSub(req, "body")
	if err != nil {
		return nil, err
	}
	listBody, err := pbSub(body, "get_conversation_info_list_v2_body")
	if err != nil {
		return nil, err
	}
	data, err := pbSub(listBody, "data")
	if err != nil {
		return nil, err
	}
	if err := SetProtoField(data, "conversation_id", fmt.Sprintf("0:1:%d:%d", myID, toUserID)); err != nil {
		return nil, err
	}
	if err := SetProtoField(data, "conversation_short_id", conversationShortID); err != nil {
		return nil, err
	}
	if err := SetProtoField(data, "conversation_type", int64(1)); err != nil {
		return nil, err
	}

	payload, err := ProtoMarshal(req)
	if err != nil {
		return nil, err
	}
	headers := BuildHeaders(HeaderPROTOBUF)
	headers.SetReferer("https://www.douyin.com/")
	resp, err := c.HTTP.PostJSON(ctx, imapiBase+imConversationInfoListPath, headers, c.CookieStr(), "", payload)
	if err != nil {
		return nil, err
	}

	root, err := imDecodeWire(resp.Body)
	if err != nil {
		return nil, err
	}
	body610, ok := imFirstWire(root, 6)
	if !ok || body610.bytes == nil {
		return nil, fmt.Errorf("会话信息查询失败%s: %x", imServerMessage(root), resp.Body)
	}
	lvl610, err := imDecodeWire(body610.bytes)
	if err != nil {
		return nil, err
	}
	node610, ok := imFirstWire(lvl610, 610)
	if !ok || node610.bytes == nil {
		return nil, fmt.Errorf("会话信息查询失败%s: %x", imServerMessage(root), resp.Body)
	}
	lvl1, err := imDecodeWire(node610.bytes)
	if err != nil {
		return nil, err
	}
	convBytes, ok := imFirstWire(lvl1, 1)
	if !ok || convBytes.bytes == nil {
		return nil, fmt.Errorf("会话信息查询失败%s；conversation_short_id 必须与 to_user_id 属于同一会话（从 list_conversations 取）: %x",
			imServerMessage(root), resp.Body)
	}
	conv, err := imDecodeWire(convBytes.bytes)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if f, ok := imFirstWire(conv, 1); ok {
		out["conversation_id"] = string(f.bytes)
	}
	if f, ok := imFirstWire(conv, 2); ok {
		out["conversation_short_id"] = int64(f.varint)
	}
	if coreBytes, ok := imFirstWire(conv, 50); ok && coreBytes.bytes != nil {
		core, err := imDecodeWire(coreBytes.bytes)
		if err == nil {
			if f, ok := imFirstWire(core, 12); ok {
				out["owner_uid"] = string(f.bytes)
			}
			if f, ok := imFirstWire(core, 13); ok {
				out["owner_sec_uid"] = string(f.bytes)
			}
		}
	}
	return out, nil
}

// GetIdentitySecurityToken fetches the short-lived token required by PC IM
// sends. Results are cached for 240s unless force is set.
func (c *Client) GetIdentitySecurityToken(ctx context.Context, force bool) (token string, deviceID string, err error) {
	now := time.Now()
	if !force {
		if cached, ok := imIdentityCache.Load(c); ok {
			if e, ok := cached.(imIdentityToken); ok && e.token != "" && now.Sub(e.ts) < 240*time.Second {
				return e.token, e.deviceID, nil
			}
		}
	}

	referer := "https://www.douyin.com/chat?isPopup=1"
	traceID := imTraceID8()

	p := NewParams()
	p.Add("passport_jssdk_version", "4.2.3")
	p.Add("passport_jssdk_type", "lite")
	p.Add("is_from_ttaccountsdk", "1")
	p.Add("aid", "6383")
	p.Add("language", "zh")
	p.Add("scene", "web_im")
	p.Add("auto_retry_req", "0")
	p.Add("skip_verify", "false")
	p.Add("identity_token_force_get_tag", "0")
	p.Add("biz_trace_id", traceID)
	p.Add("id_token_version", "1.2.10")
	p.Add("msToken", c.MsToken())
	// The browser signs the query before appending a_bogus itself; no
	// verifyFp/fp fields are present on this passport endpoint.
	p.WithABogus(c, nil)

	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(referer)
	headers.Set("accept", "application/json, text/javascript")
	csrf := c.Cookie.Get("passport_csrf_token")
	if csrf == "" {
		csrf = c.Cookie.Get("passport_csrf_token_default")
	}
	headers.Set("x-tt-passport-csrf-token", csrf)
	headers.Set("x-tt-passport-trace-id", traceID)
	if err := headers.WithBD(ctx, c, imIdentityTokenPath, 6383, douyinBase, false); err != nil {
		return "", "", err
	}

	url := BuildURL(douyinBase+imIdentityTokenPath, standardEncodeQuery(p))
	resp, err := c.HTTP.Get(ctx, url, headers, c.CookieStr())
	if err != nil {
		return "", "", err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return "", "", err
	}
	payload, err := decodeJSONObject(resp.Body)
	if err != nil {
		return "", "", fmt.Errorf("身份安全 token 接口返回不可解析响应: %w", err)
	}
	data, _ := payload["data"].(map[string]any)
	token = imStr(data["identity_security_token"])
	deviceID = imStr(data["device_id"])
	if msg, ok := payload["message"]; ok && imStr(msg) != "success" || token == "" {
		hint := ""
		if toInt64(data["error_code"]) == 3 {
			var missing []string
			for _, name := range []string{"UIFID", "passport_mfa_token", "x_tt_token", "passport_csrf_token"} {
				if !c.Cookie.Has(name) {
					missing = append(missing, name)
				}
			}
			if len(missing) > 0 {
				hint = "; 当前会话缺少/未同步的浏览器 Cookie: " + strings.Join(missing, ", ")
			}
		}
		return "", "", fmt.Errorf("身份安全 token 获取失败: %v%s", payload, hint)
	}
	imIdentityCache.Store(c, imIdentityToken{token: token, deviceID: deviceID, ts: now})
	return token, deviceID, nil
}

// SendMsg sends a text message (message type 7). A plain string is wrapped in
// the browser text payload.
func (c *Client) SendMsg(ctx context.Context, conversationID string, conversationShortID int64, ticket, content string) (map[string]any, error) {
	payload := map[string]any{
		"aweType":       700,
		"type":          0,
		"richTextInfos": []any{},
		"text":          content,
	}
	return c.imSendMessageRaw(ctx, conversationID, conversationShortID, ticket, imText, payload)
}

// IMMediaKinds lists the attachment kinds the 私信媒体发送 path accepts. It is
// the single source of truth for validation and for the error message.
var IMMediaKinds = []string{"image", "video", "audio", "file"}

// ValidIMMediaKind reports whether kind is a supported 私信媒体类型.
// Callers must check this before creating a conversation, so an invalid kind
// never opens a session with the recipient.
func ValidIMMediaKind(kind string) bool {
	return slices.Contains(IMMediaKinds, kind)
}

// IMMediaKindList renders IMMediaKinds as "image|video|audio|file".
func IMMediaKindList() string { return strings.Join(IMMediaKinds, "|") }

// SendIMImage uploads and sends one image attachment (message type 27).
func (c *Client) SendIMImage(ctx context.Context, conversationID string, conversationShortID int64, ticket, imagePath string) (map[string]any, error) {
	content, err := c.imUploadImage(ctx, imagePath, nil)
	if err != nil {
		return nil, err
	}
	return c.imSendMessageRaw(ctx, conversationID, conversationShortID, ticket, imStoryPic, content)
}

// SendIMVideo uploads and sends one video attachment (message type 30). PC IM
// requires a cover image; Go has no built-in video frame extractor, so this
// entry point returns an error unless SendIMVideoWithThumb is used.
func (c *Client) SendIMVideo(ctx context.Context, conversationID string, conversationShortID int64, ticket, videoPath string) (map[string]any, error) {
	return c.SendIMVideoWithThumb(ctx, conversationID, conversationShortID, ticket, videoPath, "")
}

// SendIMVideoWithThumb is SendIMVideo with an explicit cover image instead of
// automatic frame extraction.
func (c *Client) SendIMVideoWithThumb(ctx context.Context, conversationID string, conversationShortID int64, ticket, videoPath, thumbPath string) (map[string]any, error) {
	content, err := c.imUploadVideo(ctx, videoPath, thumbPath)
	if err != nil {
		return nil, err
	}
	return c.imSendMessageRaw(ctx, conversationID, conversationShortID, ticket, imStoryVideo, content)
}

// SendIMAudio sends a voice message. The current PC IM web client exposes no
// reusable voice upload protocol, so audioPath must be a captured voice
// content JSON object; a file path fails because the current web client does
// not expose that protocol.
func (c *Client) SendIMAudio(ctx context.Context, conversationID string, conversationShortID int64, ticket, audioPath string) (map[string]any, error) {
	trimmed := strings.TrimSpace(audioPath)
	if strings.HasPrefix(trimmed, "{") {
		content, err := decodeJSONObject([]byte(trimmed))
		if err != nil {
			return nil, fmt.Errorf("语音 content 参数不是合法 JSON: %w", err)
		}
		return c.imSendMessageRaw(ctx, conversationID, conversationShortID, ticket, imEncryptVoice, content)
	}
	return nil, fmt.Errorf("当前 PC IM 网页端没有可复用的语音上传协议（VOD audio 被服务端拒绝）；请传入兼容客户端捕获的 voice content JSON，而非文件路径: %s", audioPath)
}

// SendIMFile uploads and sends a generic file attachment (message type 6).
func (c *Client) SendIMFile(ctx context.Context, conversationID string, conversationShortID int64, ticket, filePath string) (map[string]any, error) {
	content, err := c.imUploadFile(ctx, filePath)
	if err != nil {
		return nil, err
	}
	return c.imSendMessageRaw(ctx, conversationID, conversationShortID, ticket, imFile, content)
}

// SendIMSticker sends a BIG_EMOJI payload (message type 5). sticker must be a
// complete CDN metadata dict.
func (c *Client) SendIMSticker(ctx context.Context, conversationID string, conversationShortID int64, ticket string, sticker map[string]any) (map[string]any, error) {
	return c.imSendMessageRaw(ctx, conversationID, conversationShortID, ticket, imBigEmoji, sticker)
}

// SendIMCard sends a caller-supplied share/card payload. The message type is
// folded into the card map as "message_type" (or inferred from "aweType") to
// keep the required Go signature.
func (c *Client) SendIMCard(ctx context.Context, conversationID string, conversationShortID int64, ticket string, card map[string]any) (map[string]any, error) {
	messageType, err := imCardMessageType(card)
	if err != nil {
		return nil, err
	}
	return c.imSendMessageRaw(ctx, conversationID, conversationShortID, ticket, messageType, card)
}

// ShareAweme sends a video-share card (message type 8). awemeID may be a bare
// id or a /video|/note|/slides URL. The card does not resolve the work detail
// (get_work_info lives in another file); it is built from the id alone.
func (c *Client) ShareAweme(ctx context.Context, conversationID string, conversationShortID int64, ticket, awemeID string) (map[string]any, error) {
	itemID := imItemIDFromValue(awemeID)
	if itemID == "" {
		return nil, fmt.Errorf("无法从 %q 解析作品 ID", awemeID)
	}
	card := imBuildShareAwemeCard(itemID, c.imUIDString(ctx), nil)
	return c.imSendMessageRaw(ctx, conversationID, conversationShortID, ticket, imShareAweme, card)
}

// SharePhotos sends a photo/text share card (message type 77).
func (c *Client) SharePhotos(ctx context.Context, conversationID string, conversationShortID int64, ticket string, awemeID any) (map[string]any, error) {
	itemID := imItemIDFromValue(imStr(awemeID))
	if itemID == "" {
		return nil, fmt.Errorf("无法从 %v 解析作品 ID", awemeID)
	}
	card := imBuildSharePhotosCard(itemID, c.imUIDString(ctx), nil)
	return c.imSendMessageRaw(ctx, conversationID, conversationShortID, ticket, imSharePhotos, card)
}

// ShareWeb sends a web/link card (message type 26).
func (c *Client) ShareWeb(ctx context.Context, conversationID string, conversationShortID int64, ticket, url string) (map[string]any, error) {
	card := imBuildShareWebCard(url, "", "", "")
	return c.imSendMessageRaw(ctx, conversationID, conversationShortID, ticket, imShareWeb, card)
}

// SendUserCard sends a user-share card (message type 25).
func (c *Client) SendUserCard(ctx context.Context, conversationID string, conversationShortID int64, ticket, secUID string) (map[string]any, error) {
	card := imBuildUserCard("", secUID, "", nil, nil)
	return c.imSendMessageRaw(ctx, conversationID, conversationShortID, ticket, imShareUser, card)
}

// ---------------------------------------------------------------------------
// Raw send path
// ---------------------------------------------------------------------------

func (c *Client) imSendMessageRaw(ctx context.Context, conversationID string, conversationShortID int64, ticket string, messageType int, content any) (map[string]any, error) {
	req, err := imNewNormalRequest(100)
	if err != nil {
		return nil, err
	}
	body, err := pbSub(req, "body")
	if err != nil {
		return nil, err
	}
	send, err := pbSub(body, "send_message_body")
	if err != nil {
		return nil, err
	}
	if err := SetProtoField(send, "conversation_id", conversationID); err != nil {
		return nil, err
	}
	if err := SetProtoField(send, "conversation_type", int64(1)); err != nil {
		return nil, err
	}
	if err := SetProtoField(send, "conversation_short_id", conversationShortID); err != nil {
		return nil, err
	}
	if err := SetProtoField(send, "content", imEncodeContent(content)); err != nil {
		return nil, err
	}
	clientMessageID := imUUID4()
	if err := pbAppendExt(send, "s:mentioned_users", ""); err != nil {
		return nil, err
	}
	if err := pbAppendExt(send, "s:client_message_id", clientMessageID); err != nil {
		return nil, err
	}
	if err := pbAppendExt(send, "s:stime", fmt.Sprintf("%d.%05d", GenerateMillisecond(), mrand.IntN(100000))); err != nil {
		return nil, err
	}
	if err := SetProtoField(send, "message_type", int64(messageType)); err != nil {
		return nil, err
	}
	if err := SetProtoField(send, "ticket", ticket); err != nil {
		return nil, err
	}
	if err := SetProtoField(send, "client_message_id", clientMessageID); err != nil {
		return nil, err
	}

	headers := BuildHeaders(HeaderPROTOBUF)
	headers.SetReferer("https://www.douyin.com/")
	if err := headers.WithBD(ctx, c, imMessageSendPath, 6383, douyinBase, false); err != nil {
		return nil, err
	}
	identityToken, identityDeviceID, err := c.GetIdentitySecurityToken(ctx, false)
	if err != nil {
		return nil, err
	}
	tokenJSON, err := json.Marshal(map[string]string{"token": identityToken})
	if err != nil {
		return nil, err
	}
	identityHeaders := [][2]string{
		{"identity_security_token", string(tokenJSON)},
	}
	if identityDeviceID != "" {
		identityHeaders = append(identityHeaders, [2]string{"identity_security_device_id", identityDeviceID})
	}
	identityHeaders = append(identityHeaders, [2]string{"identity_security_aid", ""})
	if err := pbSetMapString(req, "headers", identityHeaders); err != nil {
		return nil, err
	}

	payload, err := ProtoMarshal(req)
	if err != nil {
		return nil, err
	}

	// Browser order is msToken -> a_bogus -> verifyFp -> fp. Only the first
	// field participates in the a_bogus input for this endpoint.
	p := NewParams()
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	fp := c.Cookie.Get("s_v_web_id")
	p.Add("verifyFp", fp)
	p.Add("fp", fp)

	url := BuildURL(imapiBase+imMessageSendPath, standardEncodeQuery(p))
	resp, err := c.HTTP.PostJSON(ctx, url, headers, c.CookieStr(), "", payload)
	if err != nil {
		return nil, err
	}
	respMsg, err := ProtoUnmarshal("Response", resp.Body)
	if err != nil {
		return nil, err
	}
	return ProtoToMap(respMsg)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func (c *Client) imUIDString(ctx context.Context) string {
	uid, err := c.UID(ctx)
	if err != nil || uid == 0 {
		return ""
	}
	return strconv.FormatInt(uid, 10)
}

func imStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatInt(int64(t), 10)
	case json.Number:
		return t.String()
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprint(t)
	}
}

func imCardMessageType(card map[string]any) (int, error) {
	if v, ok := card["message_type"]; ok {
		if n := toInt64(v); n != 0 {
			return int(n), nil
		}
	}
	if v, ok := card["aweType"]; ok {
		switch toInt64(v) {
		case 800:
			return imShareAweme, nil
		case 510:
			return imBigEmoji, nil
		case 15001:
			return imFile, nil
		case 2702, 2703:
			return imStoryPic, nil
		case 700:
			return imText, nil
		}
	}
	if toInt64(card["awemeType"]) == 68 {
		return imSharePhotos, nil
	}
	return 0, fmt.Errorf("SendIMCard 需要 card[\"message_type\"]（或可推断的 aweType）")
}

// imDigList walks nested map[string]any keys and returns a []any list.
func imDigList(root map[string]any, keys ...string) []any {
	var cur any = root
	for _, k := range keys {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[k]
	}
	list, _ := cur.([]any)
	return list
}

// --- generic protobuf wire decoding (blackboxprotobuf-style navigation) ---

type imWireField struct {
	num    protowire.Number
	wire   protowire.Type
	varint uint64
	bytes  []byte
}

func imDecodeWire(data []byte) ([]imWireField, error) {
	var out []imWireField
	for len(data) > 0 {
		num, typ, n := protowire.ConsumeTag(data)
		if n < 0 {
			return nil, fmt.Errorf("proto: 非法 tag")
		}
		data = data[n:]
		f := imWireField{num: num, wire: typ}
		switch typ {
		case protowire.VarintType:
			v, m := protowire.ConsumeVarint(data)
			if m < 0 {
				return nil, fmt.Errorf("proto: 非法 varint")
			}
			f.varint = v
			data = data[m:]
		case protowire.Fixed32Type:
			_, m := protowire.ConsumeFixed32(data)
			if m < 0 {
				return nil, fmt.Errorf("proto: 非法 fixed32")
			}
			data = data[m:]
		case protowire.Fixed64Type:
			_, m := protowire.ConsumeFixed64(data)
			if m < 0 {
				return nil, fmt.Errorf("proto: 非法 fixed64")
			}
			data = data[m:]
		case protowire.BytesType:
			b, m := protowire.ConsumeBytes(data)
			if m < 0 {
				return nil, fmt.Errorf("proto: 非法 bytes")
			}
			f.bytes = b
			data = data[m:]
		default:
			m := protowire.ConsumeFieldValue(num, typ, data)
			if m < 0 {
				return nil, fmt.Errorf("proto: 非法字段值")
			}
			data = data[m:]
		}
		out = append(out, f)
	}
	return out, nil
}

func imFirstWire(fields []imWireField, num protowire.Number) (imWireField, bool) {
	for _, f := range fields {
		if f.num == num {
			return f, true
		}
	}
	return imWireField{}, false
}

// imServerMessage returns the Response.message field (number 4) as an error
// suffix, e.g. "（服务端: request.MGet empty）". Empty when the envelope
// carries no message.
func imServerMessage(root []imWireField) string {
	f, ok := imFirstWire(root, 4)
	if !ok || len(f.bytes) == 0 {
		return ""
	}
	msg := string(f.bytes)
	if len(msg) > 120 {
		msg = msg[:120]
	}
	return "（服务端: " + msg + "）"
}
