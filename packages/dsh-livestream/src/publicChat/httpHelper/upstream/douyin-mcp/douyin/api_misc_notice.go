package douyin

import (
	"context"
)

// GetNoticeDiggList returns the likers of a 点赞通知
// (`/aweme/v1/web/notice/digg/list/`, bundle 里的 getCommentDiggUserList)。
//
// 参数坑：同一模块的其它通知接口用 `nid_str` / `notice_id_str`，但**这个接口只认
// `notice_id`** —— 传 nid_str/notice_id_str/cid/item_id 等一律 `status_code=5
// 参数不合法`（2026-10-07 用真实通知逐项实测确认）。返回体字段为
// `digg_list` / `user_list` / `total` / `has_more` / `max_time` / `min_time`。
func (c *Client) GetNoticeDiggList(ctx context.Context, noticeID, count, maxTime, minTime string) (map[string]any, error) {
	const api = "/aweme/v1/web/notice/digg/list/"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	if count == "" {
		count = "20"
	}
	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	// 与通知列表同一套公共块（实测浏览器在通知面板里就是这么带的）。
	p.Add("is_new_notice", "1")
	p.Add("is_mark_read", "1")
	p.Add("notice_id", noticeID)
	p.Add("count", count)
	p.Add("max_time", maxTime)
	p.Add("min_time", minTime)
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}
