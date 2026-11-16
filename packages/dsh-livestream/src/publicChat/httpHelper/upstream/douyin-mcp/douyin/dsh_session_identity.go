package douyin

import "context"

// DSHQuerySessionUser performs a fresh query and preserves JSON number tokens.
// It intentionally does not consult the cached UID on Client.
func (c *Client) DSHQuerySessionUser(ctx context.Context) (map[string]any, error) {
	const endpoint = douyinBase + "/aweme/v1/web/query/user/"
	const referer = douyinBase + "/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(referer)
	headers.WithUIFID(c)
	params := NewParams()
	params.Add("publish_video_strategy_type", "2")
	params.WithPlatform("0", "170400", "17.4.0")
	params.WithUIFID(c)
	params.WithWebID(ctx, c, referer)
	params.WithVerifyFP(c)
	params.WithABogus(c, nil)
	response, err := c.GetParams(ctx, endpoint, params, headers)
	if err != nil {
		return nil, err
	}
	if err := CheckRisk(response); err != nil {
		return nil, err
	}
	return decodeJSONObject(response.Body)
}
