package douyin

// PC-IM read/management APIs discovered from the web client: conversation
// list, conversation info, message history, group participants, stranger
// conversations, read receipts and user-info (nicknames).

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

const (
	imBase     = "https://imapi.douyin.com"
	imHJBase   = "https://www-hj.douyin.com"
	imUserInfo = imHJBase + "/aweme/v1/web/im/user/info/"
)

// IMChatMessage is one IM message (group or direct).
type IMChatMessage struct {
	ConversationID      string         `json:"conversation_id"`
	ConversationType    int32          `json:"conversation_type"`
	ServerMessageID     int64          `json:"server_message_id"`
	Index               int64          `json:"index_in_conversation"`
	ConversationShortID int64          `json:"conversation_short_id"`
	MessageType         int32          `json:"message_type"`
	SenderUID           int64          `json:"sender"`
	SenderSecUID        string         `json:"sender_sec_uid,omitempty"`
	ContentJSON         string         `json:"-"`
	Content             map[string]any `json:"content,omitempty"`
	TimestampMs         int64          `json:"timestamp_ms"`
}

// Text is the plain text of the message when the payload carries one.
func (m IMChatMessage) Text() string {
	if m.Content == nil {
		return ""
	}
	if s, ok := m.Content["text"].(string); ok {
		return s
	}
	return ""
}

// IMConversation is a conversation entry with its display name.
type IMConversation struct {
	ConversationID      string `json:"conversation_id"`
	ConversationShortID int64  `json:"conversation_short_id"`
	ConversationType    int32  `json:"conversation_type"`
	Name                string `json:"name"`
	OwnerUID            int64  `json:"owner_uid,omitempty"`
	OwnerSecUID         string `json:"owner_sec_uid,omitempty"`
	Ticket              string `json:"ticket,omitempty"`
	// Unread is the conversation's unread message count as the server reports
	// it for this account (message classes 1+2 of UnreadClasses).
	Unread int64 `json:"unread,omitempty"`
	// UnreadClasses is the raw per-class unread breakdown (field 11 of the
	// conversation core): {message class: count}. Class 2 carries ordinary chat
	// messages, class 1 notifications; 3/4 are group/system traffic.
	UnreadClasses map[int64]int64 `json:"unread_classes,omitempty"`
	// Cached marks a conversation that the server did not include in the latest
	// delta but that was seen earlier (the IM protocol only ships changes).
	Cached       bool            `json:"cached,omitempty"`
	LastMessages []IMChatMessage `json:"last_messages,omitempty"`
}

// IMParticipant is one group member.
type IMParticipant struct {
	UID      int64  `json:"uid"`
	SecUID   string `json:"sec_uid,omitempty"`
	Nickname string `json:"nickname,omitempty"`
	Role     int64  `json:"role,omitempty"`
}

// --- transport -------------------------------------------------------------

func (c *Client) imHeaders() Headers {
	prof := GetProfile()
	h := Headers{}
	h.Set("sec-ch-ua-platform", prof.SecCHUAPlatform)
	h.Set("referer", "https://www.douyin.com/")
	h.Set("accept-language", prof.AcceptLanguage)
	h.Set("sec-ch-ua", prof.SecCHUA)
	h.Set("sec-ch-ua-mobile", "?0")
	h.Set("user-agent", prof.UA)
	h.Set("accept", "application/x-protobuf")
	h.Set("content-type", "application/x-protobuf")
	h.Set("origin", "https://www.douyin.com")
	h.Set("priority", "u=1, i")
	h.Set("sec-fetch-dest", "empty")
	h.Set("sec-fetch-mode", "cors")
	h.Set("sec-fetch-site", "same-site")
	return h
}

// imCall posts one cmd envelope and returns the cmd-specific response body.
// bodyField is the Request.body wrapper id (usually the cmd, but e.g. 604 for
// mark_read and 1000 for the stranger list) and respField is the matching id in
// the Response.
func (c *Client) imCall(ctx context.Context, path string, cmd, inboxType, bodyField int64, body *pbw, respField int64) (map[int]any, error) {
	wrapped := &pbw{}
	wrapped.Msg(int(bodyField), body)
	envelope := imEnvelope(cmd, inboxType, wrapped)
	resp, err := c.HTTP.Do(ctx, "POST", imBase+path, c.imHeaders(), c.CookieStr(), envelope)
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	parsed, code, msg, err := imResponseBody(resp.Body)
	if err != nil {
		head := resp.Body
		if len(head) > 160 {
			head = head[:160]
		}
		return nil, fmt.Errorf("im %s: HTTP %d, 解析响应失败: %w (前 160 字节: %q)", path, resp.StatusCode, err, head)
	}
	if code != 0 {
		return nil, fmt.Errorf("im %s: 错误码 %d %s", path, code, msg)
	}
	if parsed == nil {
		return nil, fmt.Errorf("im %s: 空响应", path)
	}
	return imCmdBody(parsed, int(respField)), nil
}

// --- parsers ---------------------------------------------------------------

func imParseMessage(m map[int]any) IMChatMessage {
	msg := IMChatMessage{
		ConversationID:      pbString(m, 1),
		ConversationType:    int32(pbInt(m, 2)),
		ServerMessageID:     pbInt(m, 3),
		Index:               pbInt(m, 4),
		ConversationShortID: pbInt(m, 5),
		MessageType:         int32(pbInt(m, 6)),
		SenderUID:           pbInt(m, 7),
		SenderSecUID:        pbString(m, 14),
		ContentJSON:         pbString(m, 8),
		TimestampMs:         pbInt(m, 10),
	}
	if msg.ContentJSON != "" {
		var content map[string]any
		if json.Unmarshal([]byte(msg.ContentJSON), &content) == nil {
			msg.Content = content
		}
	}
	return msg
}

func imParseMessages(list []any) []IMChatMessage {
	out := make([]IMChatMessage, 0, len(list))
	for _, item := range list {
		b, ok := item.([]byte)
		if !ok {
			continue
		}
		m, err := pbParse(b)
		if err != nil {
			continue
		}
		out = append(out, imParseMessage(m))
	}
	return out
}

// imParseConversationCore reads the shared conversation "core" message.
func imParseConversationCore(core map[int]any) IMConversation {
	conv := IMConversation{
		ConversationID:      pbString(core, 1),
		ConversationShortID: pbInt(core, 2),
		ConversationType:    int32(pbInt(core, 3)),
	}
	// field 4 is a ticket (string for group/init, numeric for some responses)
	if tb, ok := core[4].([]byte); ok {
		conv.Ticket = string(tb)
	} else if v := pbInt(core, 4); v != 0 {
		conv.Ticket = strconv.FormatInt(v, 10)
	}
	if meta, ok := pbMsg(core, 50); ok {
		conv.Name = firstNonEmpty(pbString(meta, 5), pbString(meta, 6))
		conv.OwnerUID = pbInt(meta, 12)
		conv.OwnerSecUID = pbString(meta, 13)
	}
	if conv.Name == "" {
		conv.Name = firstNonEmpty(pbString(core, 5), pbString(core, 6))
	}
	// Field 11 is a repeated {class, count} pair list carrying this account's
	// unread counters for the conversation (verified against the web UI badge:
	// BOBING group classes {1:4, 2:24} == badge 28).
	for _, item := range pbList(core, 11) {
		raw, ok := item.([]byte)
		if !ok {
			continue
		}
		pair, err := pbParse(raw)
		if err != nil {
			continue
		}
		class, count := pbInt(pair, 1), pbInt(pair, 2)
		if count <= 0 {
			continue
		}
		if conv.UnreadClasses == nil {
			conv.UnreadClasses = make(map[int64]int64, 2)
		}
		conv.UnreadClasses[class] = count
		if class == 1 || class == 2 {
			conv.Unread += count
		}
	}
	return conv
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// --- public API ------------------------------------------------------------

// IMListConversations returns the full conversation list (groups and direct
// chats) with display names, via the initial IM sync (cmd 2043).
func (c *Client) IMListConversations(ctx context.Context) ([]IMConversation, error) {
	body := &pbw{}
	body.IntAlways(2, 0)
	inner, err := c.imCall(ctx, "/v1/message/get_message_by_init", 2043, 1, 2043, body, 2043)
	if err != nil {
		return nil, err
	}
	entries := pbList(inner, 1)
	out := make([]IMConversation, 0, len(entries))
	for _, e := range entries {
		b, ok := e.([]byte)
		if !ok {
			continue
		}
		entry, err := pbParse(b)
		if err != nil {
			continue
		}
		core, ok := pbMsg(entry, 1)
		if !ok {
			continue
		}
		conv := imParseConversationCore(core)
		conv.LastMessages = imParseMessages(pbList(entry, 2))
		out = append(out, conv)
	}
	return out, nil
}

// IMConversationInfo fetches one conversation's info (cmd 610).
func (c *Client) IMConversationInfo(ctx context.Context, conversationID string, shortID int64, convType int32) (IMConversation, error) {
	data := &pbw{}
	data.Str(1, conversationID)
	data.IntAlways(2, shortID)
	data.IntAlways(3, int64(convType))
	body := &pbw{}
	body.Msg(1, data)
	inner, err := c.imCall(ctx, "/v2/conversation/get_info_list", 610, 0, 610, body, 610)
	if err != nil {
		return IMConversation{}, err
	}
	core, ok := pbMsg(inner, 1)
	if !ok {
		return IMConversation{}, fmt.Errorf("im: 会话信息为空")
	}
	return imParseConversationCore(core), nil
}

// IMConversationHistory fetches a page of messages (cmd 301). cursor=0 starts
// from the most recent page; the returned cursor pages further back.
func (c *Client) IMConversationHistory(ctx context.Context, conversationID string, shortID int64, convType int32, cursor int64, count int) ([]IMChatMessage, int64, error) {
	if count <= 0 || count > 50 {
		count = 50
	}
	body := &pbw{}
	body.Str(1, conversationID)
	body.IntAlways(2, int64(convType))
	body.IntAlways(3, shortID)
	body.IntAlways(4, 1)
	body.IntAlways(5, cursor)
	body.IntAlways(6, int64(count))
	inner, err := c.imCall(ctx, "/v1/message/get_by_conversation", 301, 0, 301, body, 301)
	if err != nil {
		return nil, 0, err
	}
	msgs := imParseMessages(pbList(inner, 1))
	next := pbInt(inner, 2)
	return msgs, next, nil
}

// IMParticipants lists a conversation's members (cmd 605).
func (c *Client) IMParticipants(ctx context.Context, conversationID string, shortID int64, convType int32, offset int64, count int) ([]IMParticipant, error) {
	if count <= 0 || count > 100 {
		count = 50
	}
	body := &pbw{}
	body.Str(1, conversationID)
	body.IntAlways(2, shortID)
	body.IntAlways(3, int64(convType))
	body.IntAlways(4, offset)
	body.IntAlways(5, int64(count))
	inner, err := c.imCall(ctx, "/v1/conversation/participants_list", 605, 0, 605, body, 605)
	if err != nil {
		return nil, err
	}
	data, ok := pbMsg(inner, 1)
	if !ok {
		return nil, nil
	}
	raw := pbList(data, 1)
	out := make([]IMParticipant, 0, len(raw))
	for _, item := range raw {
		b, ok := item.([]byte)
		if !ok {
			continue
		}
		m, err := pbParse(b)
		if err != nil {
			continue
		}
		out = append(out, IMParticipant{
			UID:      pbInt(m, 1),
			Nickname: pbString(m, 4),
			SecUID:   pbString(m, 5),
			Role:     pbInt(m, 3),
		})
	}
	return out, nil
}

// IMSetConversationSetting pins/unpins and mutes/unmutes a conversation
// (cmd 921). Only the pointers that are non-nil are sent, matching the web
// client which writes just the changed field.
func (c *Client) IMSetConversationSetting(ctx context.Context, conversationID string, shortID int64, convType int32, pin, mute *bool) (map[string]any, error) {
	out, err := c.imCall(ctx, "/v1/conversation/set_setting_info", 921, 1, 921, imSettingBody(conversationID, shortID, convType, pin, mute), 921)
	if err != nil {
		return nil, err
	}
	return pbMapToAny(out), nil
}

// IMLeaveConversation quits a group conversation (cmd 652).
func (c *Client) IMLeaveConversation(ctx context.Context, conversationID string, shortID int64, convType int32) (map[string]any, error) {
	out, err := c.imCall(ctx, "/v1/conversation/leave", 652, 1, 652, imConversationRefBody(conversationID, shortID, convType), 652)
	if err != nil {
		return nil, err
	}
	return pbMapToAny(out), nil
}

// imSettingBody builds the cmd-921 body: only the fields being changed are
// written, exactly like the web client.
func imSettingBody(conversationID string, shortID int64, convType int32, pin, mute *bool) *pbw {
	body := imConversationRefBody(conversationID, shortID, convType)
	if pin != nil {
		body.IntAlways(4, boolToInt(*pin))
	}
	if mute != nil {
		body.IntAlways(5, boolToInt(*mute))
	}
	return body
}

// imConversationRefBody is the shared {1: id, 2: short id, 3: type} body.
func imConversationRefBody(conversationID string, shortID int64, convType int32) *pbw {
	body := &pbw{}
	body.Str(1, conversationID)
	body.IntAlways(2, shortID)
	body.IntAlways(3, int64(convType))
	return body
}

func boolToInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// IMStrangerConversations returns conversations from accounts you don't follow
// (cmd 1001). The response is returned as decoded maps.
func (c *Client) IMStrangerConversations(ctx context.Context) (map[string]any, error) {
	inner := &pbw{}
	inner.IntAlways(1, 0)
	inner.IntAlways(2, 1)
	inner.IntAlways(3, 1)
	out, err := c.imCall(ctx, "/v1/stranger/get_conversation_list", 1001, 1, 1000, inner, 1000)
	if err != nil {
		return nil, err
	}
	return pbMapToAny(out), nil
}

// IMMarkRead clears the unread marker of a conversation (cmd 2002).
func (c *Client) IMMarkRead(ctx context.Context, conversationID string, shortID int64, convType int32, index int64) (map[string]any, error) {
	inner := &pbw{}
	inner.Str(1, conversationID)
	inner.IntAlways(2, shortID)
	inner.IntAlways(3, int64(convType))
	inner.IntAlways(4, index)
	inner.IntAlways(5, 0)
	inner.IntAlways(6, 140)
	mark := &pbw{}
	mark.IntAlways(1, 50)
	mark.IntAlways(2, 0)
	inner.Msg(11, mark)
	out, err := c.imCall(ctx, "/v3/conversation/mark_read", 2002, 1, 604, inner, 604)
	if err != nil {
		return nil, err
	}
	return pbMapToAny(out), nil
}

// IMUserInfo resolves nicknames/avatars for sec_uids (form POST, JSON response).
func (c *Client) IMUserInfo(ctx context.Context, secUIDs []string) ([]map[string]any, error) {
	if len(secUIDs) == 0 {
		return nil, nil
	}
	prof := GetProfile()
	refer := "https://www.douyin.com/friend"
	p := NewParams()
	p.WithPlatform("50", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)

	headers := BuildHeaders(HeaderFORM)
	headers.SetReferer(refer)
	headers.Set("origin", "https://www.douyin.com")

	encoded, _ := json.Marshal(secUIDs)
	form := "sec_user_ids=" + url.QueryEscape(string(encoded))
	resp, err := c.PostForm(ctx, imUserInfo, p, headers, form)
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	var out struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(resp.Body, &out); err != nil {
		return nil, fmt.Errorf("im user info: %w", err)
	}
	_ = prof
	return out.Data, nil
}

// pbMapToAny converts a field-number keyed map into a JSON-friendly map.
func pbMapToAny(m map[int]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[strconv.Itoa(k)] = pbValueToAny(v)
	}
	return out
}

func pbValueToAny(v any) any {
	switch t := v.(type) {
	case []byte:
		if inner, err := pbParse(t); err == nil {
			return pbMapToAny(inner)
		}
		s := string(t)
		if strings.HasPrefix(strings.TrimSpace(s), "{") || strings.HasPrefix(strings.TrimSpace(s), "[") {
			var j any
			if json.Unmarshal(t, &j) == nil {
				return j
			}
		}
		return s
	case []any:
		out := make([]any, 0, len(t))
		for _, item := range t {
			out = append(out, pbValueToAny(item))
		}
		return out
	default:
		return v
	}
}
