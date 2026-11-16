package douyin

import (
	"context"
)

// IM 管理类写操作：改群名/群公告、移除群成员、撤回消息、删除消息。
//
// cmd 与 body 包装字段号取自当前 PC 版（主站 douyin_web）IM 客户端的 protobuf 定义，
// 并用「不存在的会话 id」实测过路由（见 TestLiveIMAdminCmdRouting）：
//
//	cmd 902 / body 902   set_conversation_core_info（改名等，字段 4=name…）
//	cmd 651 / body 651   conversation_remove_participants（字段 4=participants 重复 int64）
//	cmd 702 / body 702   recall_message（字段 4=server_message_id）
//	cmd 701 / body 701   delete_message（字段 4=message_id）
//
// 用现代编号（7218/5210/5618/5610）会被服务端判成「body is nil / is empty」，实测确认。

// IMCoreInfoOptions 描述要改的会话核心信息；只有非 nil 的字段会被写入（同时带上 is_*_set 标记）。
type IMCoreInfoOptions struct {
	Name   *string // 群名
	Desc   *string // 群简介
	Icon   *string // 群头像
	Notice *string // 群公告
}

// --- 请求体构造（与测试共用同一份实现） -------------------------------------

// imCoreInfoBody 构造 cmd 902 的 body。
func imCoreInfoBody(conversationID string, shortID int64, convType int32, opts IMCoreInfoOptions) *pbw {
	body := imConversationRefBody(conversationID, shortID, convType)
	if opts.Name != nil {
		body.Str(4, *opts.Name)
		body.IntAlways(8, 1) // is_name_set
	}
	if opts.Desc != nil {
		body.Str(5, *opts.Desc)
		body.IntAlways(9, 1) // is_desc_set
	}
	if opts.Icon != nil {
		body.Str(6, *opts.Icon)
		body.IntAlways(10, 1) // is_icon_set
	}
	if opts.Notice != nil {
		body.Str(7, *opts.Notice)
		body.IntAlways(11, 1) // is_notice_set
	}
	return body
}

// imRemoveParticipantsBody 构造 cmd 651 的 body。
func imRemoveParticipantsBody(conversationID string, shortID int64, convType int32, uids []int64) *pbw {
	body := imConversationRefBody(conversationID, shortID, convType)
	for _, uid := range uids {
		body.IntAlways(4, uid)
	}
	return body
}

// imRecallMessageBody 构造 cmd 702 的 body。
func imRecallMessageBody(conversationID string, shortID int64, convType int32, serverMessageID int64) *pbw {
	body := imConversationRefBody(conversationID, shortID, convType)
	body.IntAlways(4, serverMessageID)
	return body
}

// imDeleteMessageBody 构造 cmd 701 的 body。
func imDeleteMessageBody(conversationID string, shortID int64, convType int32, messageID int64) *pbw {
	body := imConversationRefBody(conversationID, shortID, convType)
	body.IntAlways(4, messageID)
	return body
}

// --- 对外方法 ---------------------------------------------------------------

// IMSetConversationCoreInfo 改群名/群简介/群头像/群公告（cmd 902）。
func (c *Client) IMSetConversationCoreInfo(ctx context.Context, conversationID string, shortID int64, convType int32, opts IMCoreInfoOptions) (map[string]any, error) {
	out, err := c.imCall(ctx, "/v1/conversation/set_core_info", 902, 1, 902,
		imCoreInfoBody(conversationID, shortID, convType, opts), 902)
	if err != nil {
		return nil, err
	}
	return pbMapToAny(out), nil
}

// IMRemoveParticipants 把若干成员移出群（cmd 651，需群主/管理员权限）。
func (c *Client) IMRemoveParticipants(ctx context.Context, conversationID string, shortID int64, convType int32, uids []int64) (map[string]any, error) {
	out, err := c.imCall(ctx, "/v1/conversation/remove_participants", 651, 1, 651,
		imRemoveParticipantsBody(conversationID, shortID, convType, uids), 651)
	if err != nil {
		return nil, err
	}
	return pbMapToAny(out), nil
}

// IMRecallMessage 撤回一条消息（cmd 702，需 server_message_id，服务端限 3 分钟内）。
func (c *Client) IMRecallMessage(ctx context.Context, conversationID string, shortID int64, convType int32, serverMessageID int64) (map[string]any, error) {
	out, err := c.imCall(ctx, "/v1/message/recall", 702, 1, 702,
		imRecallMessageBody(conversationID, shortID, convType, serverMessageID), 702)
	if err != nil {
		return nil, err
	}
	return pbMapToAny(out), nil
}

// IMDeleteMessage 删除一条消息（cmd 701，只影响自己侧）。
func (c *Client) IMDeleteMessage(ctx context.Context, conversationID string, shortID int64, convType int32, messageID int64) (map[string]any, error) {
	out, err := c.imCall(ctx, "/v1/message/delete", 701, 1, 701,
		imDeleteMessageBody(conversationID, shortID, convType, messageID), 701)
	if err != nil {
		return nil, err
	}
	return pbMapToAny(out), nil
}
