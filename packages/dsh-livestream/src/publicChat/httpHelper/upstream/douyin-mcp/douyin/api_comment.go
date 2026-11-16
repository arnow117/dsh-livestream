package douyin

// Work comment endpoints: outer, inner and all-comment listings.

import (
	"context"
	"fmt"
	"slices"
)

// GetWorkOutComment returns one page of a work's top-level comments
// (`/aweme/v1/web/comment/list/`, bd-readonly headers, empty whale_cut_token/rcFT).
func (c *Client) GetWorkOutComment(ctx context.Context, workURL, cursor string) (map[string]any, error) {
	const api = "/aweme/v1/web/comment/list/"
	awemeID, refer, err := ParseAwemeID(workURL)
	if err != nil {
		return nil, err
	}
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)
	// 浏览器在这个接口上带 bd-ticket-guard 全套.
	headers.WithBDReadonly(c)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("aweme_id", awemeID)
	p.Add("cursor", cursor)
	p.Add("count", "5")
	p.Add("item_type", "0")
	// whale_cut_token / rcFT 是空值字段，浏览器确实发.
	p.Add("whale_cut_token", "")
	p.Add("cut_version", "1")
	p.Add("rcFT", "")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetWorkAllOutComment pages through a work's top-level comments up to limit.
func (c *Client) GetWorkAllOutComment(ctx context.Context, workURL string, limit int) ([]any, error) {
	cursor := "0"
	var out []any
	for {
		res, err := c.GetWorkOutComment(ctx, workURL, cursor)
		if err != nil {
			return nil, err
		}
		comments := duSlice(res["comments"])
		if v, ok := res["cursor"]; ok {
			cursor = duStr(v)
		}
		if len(comments) == 0 {
			break
		}
		out = append(out, comments...)
		if !duHasMore(res) {
			break
		}
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// GetWorkInnerComment returns one page of a comment's replies
// (`/aweme/v1/web/comment/list/reply/`; no uifid, verifyFp/fp after a_bogus).
func (c *Client) GetWorkInnerComment(ctx context.Context, comment map[string]any, cursor, count string) (map[string]any, error) {
	const api = "/aweme/v1/web/comment/list/reply/"
	awemeID := duStr(comment["aweme_id"])
	commentID := duStr(comment["cid"])
	refer := douyinBase + "/video/" + awemeID
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("item_id", awemeID)
	p.Add("comment_id", commentID)
	p.Add("cut_version", "1")
	p.Add("cursor", cursor)
	p.Add("count", count)
	p.Add("item_type", "0")
	// 这个端点严格校验 a_bogus：公共组 + **不带 uifid**.
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)
	// verifyFp / fp 放在 a_bogus **之后**，不参与签名.
	p.WithVerifyFP(c)
	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetWorkAllInnerComment pages through a comment's replies up to limit.
func (c *Client) GetWorkAllInnerComment(ctx context.Context, comment map[string]any, limit int) ([]any, error) {
	cursor := "0"
	count := "5"
	var out []any
	for {
		res, err := c.GetWorkInnerComment(ctx, comment, cursor, count)
		if err != nil {
			return nil, err
		}
		comments := duSlice(res["comments"])
		if v, ok := res["cursor"]; ok {
			cursor = duStr(v)
		}
		if len(comments) > 0 {
			out = append(out, comments...)
		}
		if !duHasMore(res) {
			break
		}
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// GetWorkAllComment returns a work's top-level comments; when includeReplies is
// true every comment also gets a `reply_comment` array.
func (c *Client) GetWorkAllComment(ctx context.Context, workURL string, limit int, includeReplies bool) ([]any, error) {
	out, err := c.GetWorkAllOutComment(ctx, workURL, limit)
	if err != nil {
		return nil, err
	}
	for _, item := range out {
		comment := duMap(item)
		if comment == nil {
			continue
		}
		comment["reply_comment"] = []any{}
		if !includeReplies {
			continue
		}
		if toInt64(comment["reply_comment_total"]) > 0 {
			inner, err := c.GetWorkAllInnerComment(ctx, comment, 0)
			if err != nil {
				return nil, err
			}
			comment["reply_comment"] = inner
		}
	}
	return out, nil
}

// FindComment locates a top-level comment by cid (or, failing that, by author
// nickname / uid) so callers can pass it to GetWorkInnerComment.
func (c *Client) FindComment(ctx context.Context, workURL, commentID string) (map[string]any, error) {
	cursor := "0"
	for {
		res, err := c.GetWorkOutComment(ctx, workURL, cursor)
		if err != nil {
			return nil, err
		}
		comments := duSlice(res["comments"])
		if i := slices.IndexFunc(comments, func(item any) bool {
			comment := duMap(item)
			if comment == nil {
				return false
			}
			if duStr(comment["cid"]) == commentID {
				return true
			}
			user := duMap(comment["user"])
			return user != nil && (duStr(user["nickname"]) == commentID || duStr(user["uid"]) == commentID)
		}); i >= 0 {
			return duMap(comments[i]), nil
		}
		if !duHasMore(res) {
			break
		}
		next := duStr(res["cursor"])
		if next == "" || next == cursor {
			break
		}
		cursor = next
	}
	return nil, fmt.Errorf("未找到评论 %s", commentID)
}
