package douyin

// Notification (通知) endpoints discovered from the current PC client:
//   /aweme/v1/web/notice/          列表（is_new_notice + is_mark_read）
//   /aweme/v1/web/notice/count/    未读数（含社交计数）
//   /aweme/v1/web/notice/digg/list/ 点赞通知
//   /aweme/v1/web/notice/detail/   通知详情
//   /aweme/v1/web/notice/del/      删除通知（action_type + notice_id_str）

import (
	"context"
	"fmt"
	"strings"
)

// NoticeGroups documents the notice_group values the web client uses.
const (
	NoticeGroupAll      = "700" // 全部消息
	NoticeGroupFans     = "401" // 粉丝
	NoticeGroupMentions = "601" // @我的
	NoticeGroupComments = "2"   // 评论
	NoticeGroupDiggs    = "3"   // 点赞
	NoticeGroupDanmaku  = "520" // 弹幕
)

// noticeParams builds the common notice query prefix.
func noticeParams() *Params {
	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	return p
}

func (c *Client) noticeFinish(ctx context.Context, p *Params, refer string) *Params {
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	p.WithVerifyFP(c)
	return p
}

// noticeStatusError turns a business status_code into an error so a failed
// notice call cannot be mistaken for an empty success.
func noticeStatusError(action string, res map[string]any) error {
	code := toInt64(res["status_code"])
	if code == 0 {
		return nil
	}
	msg, _ := res["status_msg"].(string)
	return fmt.Errorf("%s 失败: status_code=%d %s", action, code, msg)
}

// NoticeCount returns the unread notification counters (评论/赞/关注等).
func (c *Client) NoticeCount(ctx context.Context) (map[string]any, error) {
	const api = "/aweme/v1/web/notice/count/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderGET)
	headers.WithUIFID(c)
	headers.SetReferer(refer)

	p := noticeParams()
	p.Add("is_new_notice", "1")
	p.Add("need_social_count", "1")
	c.noticeFinish(ctx, p, refer)
	res, err := c.duGetJSON(ctx, douyinBase+api, p, headers)
	if err != nil {
		return nil, err
	}
	if err := noticeStatusError("获取通知未读数", res); err != nil {
		return nil, err
	}
	return res, nil
}

// NoticeDetail returns one notification's detail.
func (c *Client) NoticeDetail(ctx context.Context, noticeID string) (map[string]any, error) {
	if strings.TrimSpace(noticeID) == "" {
		return nil, fmt.Errorf("notice_id_str 不能为空")
	}
	const api = "/aweme/v1/web/notice/detail/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderGET)
	headers.WithUIFID(c)
	headers.SetReferer(refer)

	p := noticeParams()
	p.Add("notice_id_str", noticeID)
	c.noticeFinish(ctx, p, refer)
	res, err := c.duGetJSON(ctx, douyinBase+api, p, headers)
	if err != nil {
		return nil, err
	}
	if err := noticeStatusError("获取通知详情", res); err != nil {
		return nil, err
	}
	return res, nil
}

// NoticeDelete removes a notification (form POST, action_type + notice_id_str).
func (c *Client) NoticeDelete(ctx context.Context, actionType, noticeID string) (map[string]any, error) {
	if noticeID == "" {
		return nil, fmt.Errorf("notice_id_str 不能为空")
	}
	const api = "/aweme/v1/web/notice/del/"
	refer := douyinBase + "/?recommend=1"
	headers := BuildHeaders(HeaderFORM)
	headers.WithUIFID(c)
	headers.SetReferer(refer)
	headers.Set("origin", douyinBase)

	p := noticeParams()
	c.noticeFinish(ctx, p, refer)

	body := fmt.Sprintf("action_type=%s&notice_id_str=%s", quoteStrict(actionType), quoteStrict(noticeID))
	resp, err := c.PostForm(ctx, douyinBase+api, p, headers, body)
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	res, err := decodeJSONObject(resp.Body)
	if err != nil {
		return nil, err
	}
	if err := noticeStatusError("删除通知", res); err != nil {
		return nil, err
	}
	return res, nil
}
