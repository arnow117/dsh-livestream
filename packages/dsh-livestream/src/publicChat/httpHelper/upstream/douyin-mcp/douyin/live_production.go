package douyin

// Live-room e-commerce APIs (小黄车): the running promotion list, a promotion's
// detail and product comments/counters.

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// liveEcomHeaders mirrors _live_ecom_headers(): the live e-commerce endpoints
// send uifid / referer / user-agent / accept only — the three sec-ch-ua
// headers are deliberately absent.
func liveEcomHeaders(pageURL string) Headers {
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(pageURL)
	for _, key := range []string{"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"} {
		headers.Del(key)
	}
	return headers
}

// GetLiveProduction returns the promotions currently shown on the live room's
// popup card. The endpoint returns the whole carousel at once; offset is kept
// for signature compatibility and ignored.
func (c *Client) GetLiveProduction(ctx context.Context, pageURL, roomID, authorID, offset string) (map[string]any, error) {
	const api = "/live/promotions/pop/v3/"
	_ = offset

	headers := liveEcomHeaders(pageURL)
	headers.WithUIFID(c)
	// entrance_info is a JSON string that the browser sends fully URL-encoded;
	// SpliceURL performs that encoding, so it is added raw here to avoid a
	// double encode (and to keep the wire query identical to the signed bytes).
	entranceInfo := fmt.Sprintf(
		`{"room_id":%s,"anchor_id":%s,"carrier_type":"live_popup_card","ecom_scene_id":%s}`,
		strconv.Quote(roomID), strconv.Quote(authorID), strconv.Quote("1001"))

	p := NewParams()
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.Add("room_id", roomID)
	p.Add("author_id", authorID)
	p.Add("live_scene_id", "0")
	p.Add("entrance_info", entranceInfo)
	p.WithLivePlatform("50")
	p.WithWebID(ctx, c, pageURL)
	p.WithUIFID(c)
	p.Add("msToken", c.MsToken())
	p.WithABogusHost(c, nil, liveSubHost)

	// a_bogus signs p.SpliceURL(); send exactly those bytes (see liveWeb).
	resp, err := c.HTTP.Get(ctx, BuildURL(liveBase+api, p.SpliceURL()), headers, c.CookieStr())
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if len(resp.Body) == 0 {
		// A room without promotions answers with an empty body; that is not a
		// signature failure.
		return map[string]any{"promotions": []any{}}, nil
	}
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	return liveDecodeJSON(resp.Body)
}

// GetAllLiveProduction resolves the room and returns its promotion list.
func (c *Client) GetAllLiveProduction(ctx context.Context, pageURL string) ([]any, error) {
	segment := pageURL
	if i := strings.LastIndex(segment, "/"); i >= 0 {
		segment = segment[i+1:]
	}
	if before, _, ok := strings.Cut(segment, "?"); ok {
		segment = before
	}
	roomInfo, err := c.GetLiveInfo(ctx, segment)
	if err != nil {
		return nil, fmt.Errorf("未能解析直播间信息: %s", pageURL)
	}
	roomID := liveString(roomInfo["room_id"])
	authorID := liveString(roomInfo["anchor_id"])
	result, err := c.GetLiveProduction(ctx, pageURL, roomID, authorID, "0")
	if err != nil {
		return nil, err
	}
	if promotions := liveArr(result["promotions"]); promotions != nil {
		return promotions, nil
	}
	return []any{}, nil
}

// GetLiveProductionDetail returns a promotion's detail (detail images, specs
// and jump URL). originType is 638303 for live-room cards.
func (c *Client) GetLiveProductionDetail(ctx context.Context, pageURL, promotionID, originType string) (map[string]any, error) {
	const api = "/aweme/v2/shop/promotion/pack/detail/"
	headers := BuildHeaders(HeaderFORM)
	headers.Set("origin", liveBase)
	headers.SetReferer(pageURL)
	c.liveCSRFHeader(ctx, &headers, liveBase, api)
	headers.WithUIFID(c)
	for _, key := range []string{"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"} {
		headers.Del(key)
	}

	p := NewParams()
	p.Add("is_h5", "1")
	p.Add("origin_type", originType)
	p.Add("device_platform", "webapp")
	p.Add("aid", "6383")
	p.Add("channel", "channel_pc_web")
	p.WithLivePlatform("50")
	p.WithWebID(ctx, c, pageURL)
	p.WithUIFID(c)
	p.Add("msToken", c.MsToken())

	body := NewParams()
	body.Add("is_h5", "1")
	body.Add("bff_type", "2")
	body.Add("origin_type", originType)
	body.Add("promotion_id", promotionID)
	p.WithABogusHost(c, body, liveSubHost)

	// Both the query and the form body were signed in their SpliceURL form:
	// send those exact bytes (see liveWeb for why the raw ToString() form is
	// rejected).
	resp, err := c.HTTP.PostJSON(ctx, BuildURL(liveBase+api, p.SpliceURL()), headers, c.CookieStr(),
		"", []byte(body.SpliceURL()))
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	return liveDecodeJSON(resp.Body)
}

// GetProductComments returns a product's reviews (data.Comments / data.Count /
// data.HasMore).
func (c *Client) GetProductComments(ctx context.Context, productID, shopID, cursor string) (map[string]any, error) {
	const api = "/aweme/v1/web/ecom/product/comments/"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("product_id", productID)
	p.Add("shop_id", shopID)
	p.Add("cursor", cursor)
	p.Add("count", "10")
	p.Add("stat_id", "")
	p.Add("tag_id", "")
	p.Add("sort_type", "0")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)

	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}

// GetProductCommentCounter returns the review tag counters (counter_info).
func (c *Client) GetProductCommentCounter(ctx context.Context, productID, shopID, statID string) (map[string]any, error) {
	const api = "/aweme/v1/web/ecom/product/comment/counter/"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("product_id", productID)
	p.Add("shop_id", shopID)
	p.Add("stat_id", statID)
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)

	return c.duGetJSON(ctx, douyinBase+api, p, headers)
}
