package douyin

// Session-scoped endpoints: device id, own uid/sec_uid and the bd-ticket
// server-cert exchange.

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	fhttp "github.com/bogdanfinn/fhttp"
)

var (
	reSecUID     = regexp.MustCompile(`\\"secUid\\":\\"(.*?)\\"`)
	reUserUnique = regexp.MustCompile(`\\"user_unique_id\\":\\"(.*?)\\"`)
)

// GetDeviceID exchanges a real device webid via /aweme/v1/web/query/user.
func (c *Client) GetDeviceID(ctx context.Context) (string, error) {
	const api = "/aweme/v1/web/query/user"
	refer := "https://www.douyin.com/discover"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.Add("publish_video_strategy_type", "2")
	p.WithWebID(ctx, c, refer)
	token := c.MsToken()
	if token == "" {
		return "", fmt.Errorf("session token unavailable")
	}
	p.Add("msToken", token)
	p.WithVerifyFP(c)
	p.WithABogus(c, nil)

	resp, err := c.GetParams(ctx, douyinBase+api, p, headers)
	if err != nil {
		return "", err
	}
	if err := CheckRisk(resp); err != nil {
		return "", err
	}
	res, err := decodeJSONObject(resp.Body)
	if err != nil {
		return "", err
	}
	return duStr(res["id"]), nil
}

// GetMyUID returns the logged-in numeric user id.
func (c *Client) GetMyUID(ctx context.Context) (int64, error) {
	url := douyinBase + "/aweme/v1/web/query/user/"
	refer := "https://www.douyin.com/"
	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.Add("publish_video_strategy_type", "2")
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithUIFID(c)
	p.WithWebID(ctx, c, refer)
	p.WithVerifyFP(c)
	p.WithABogus(c, nil)

	resp, err := c.GetParams(ctx, url, p, headers)
	if err != nil {
		return 0, err
	}
	if err := CheckRisk(resp); err != nil {
		return 0, err
	}
	res, err := decodeJSONObject(resp.Body)
	if err != nil {
		return 0, err
	}
	return toInt64(res["user_uid"]), nil
}

// GetMySecUID resolves the logged-in sec_uid (creator API, HTML fallback).
func (c *Client) GetMySecUID(ctx context.Context) (string, error) {
	prof := GetProfile()
	headers := Headers{
		{Name: "accept", Value: "application/json, text/plain, */*"},
		{Name: "accept-language", Value: prof.AcceptLanguage},
		{Name: "referer", Value: "https://creator.douyin.com/creator-micro/home"},
		{Name: "user-agent", Value: prof.UA},
	}
	resp, err := c.HTTP.Get(ctx, creatorBase+"/web/api/media/user/info/", headers, c.CookieStr())
	if err == nil && resp.StatusCode == 200 {
		var res struct {
			User struct {
				SecUID string `json:"sec_uid"`
			} `json:"user"`
		}
		if json.Unmarshal(resp.Body, &res) == nil && res.User.SecUID != "" {
			return res.User.SecUID, nil
		}
	}

	docHeaders := BuildHeaders(HeaderGET)
	params := NewParams().Add("from_tab_name", "main")
	resp2, err := c.HTTP.Get(ctx, BuildURL(douyinBase+"/user/self", params.ToString()), docHeaders, c.CookieStr())
	if err != nil {
		return "", err
	}
	if m := reSecUID.FindStringSubmatch(resp2.Text()); m != nil {
		return m[1], nil
	}
	return "", fmt.Errorf("未取到 sec_uid：创作者接口与主站 HTML 都没拿到，请检查登录态")
}

// FetchServerCert performs the bd-ticket get_client_cert exchange.
func (c *Client) FetchServerCert(ctx context.Context, aid int, origin string) (string, string, error) {
	if origin == "" {
		origin = douyinBase
	}
	p := NewParams()
	p.Add("aid", fmt.Sprintf("%d", aid))
	p.Add("is_from_ttaccountsdk", "1")
	token := c.MsToken()
	if token == "" {
		return "", "", fmt.Errorf("session token unavailable")
	}
	p.Add("msToken", token)
	// This endpoint signs the standard urlencode() form, not splice_url().
	query := standardEncodeQuery(p)
	p.Add("a_bogus", c.Signer.SignQuery(query, "", "www.douyin.com"))
	url := BuildURL(origin+getClientCertAPI, standardEncodeQuery(p))

	prof := GetProfile()
	headers := Headers{
		{Name: "referer", Value: origin + "/"},
		{Name: "user-agent", Value: prof.UA},
		{Name: "accept", Value: "application/json"},
	}
	if csrf := c.CSRFToken(ctx, origin, "/service/2/abtest_config/"); csrf != "" {
		headers.Set("x-secsdk-csrf-token", csrf)
	}
	headers.Set("content-type", "application/x-www-form-urlencoded")
	headers.Set("accept-language", "zh-CN,zh;q=0.9")
	headers.Set("origin", origin)
	headers.Set("priority", "u=1, i")
	headers.Set("sec-fetch-dest", "empty")
	headers.Set("sec-fetch-mode", "cors")
	headers.Set("sec-fetch-site", "same-origin")

	body := fmt.Sprintf("server_data=1,aid=%d", aid)
	resp, err := c.HTTP.PostJSON(ctx, url, headers, c.CookieStr(), "", []byte(body))
	if err != nil {
		return "", "", err
	}
	var res struct {
		Message string `json:"message"`
		Data    struct {
			ServerCert string `json:"server_cert"`
			ServerSN   string `json:"server_sn"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp.Body, &res); err != nil {
		return "", "", fmt.Errorf("获取服务端证书失败: %w", err)
	}
	if res.Message != "success" {
		return "", "", fmt.Errorf("获取服务端证书失败: %s", resp.Text())
	}
	if res.Data.ServerCert == "" {
		return "", "", fmt.Errorf("服务端证书为空: %s", resp.Text())
	}
	return res.Data.ServerCert, res.Data.ServerSN, nil
}

// HTMLUserUniqueID scrapes user_unique_id from an SSR page.
func (c *Client) HTMLUserUniqueID(ctx context.Context, pageURL string) string {
	headers := BuildHeaders(HeaderDOC)
	headers.Set("cookie", c.CookieStr())
	headers.Set("upgrade-insecure-requests", "1")
	resp, err := c.HTTP.Get(ctx, pageURL, headers, c.CookieStr())
	if err != nil {
		return ""
	}
	if m := reUserUnique.FindStringSubmatch(resp.Text()); m != nil {
		return m[1]
	}
	return ""
}

// standardEncodeQuery encodes a query string with form-urlencoded
// (quote_plus) rules.
func standardEncodeQuery(p *Params) string {
	parts := make([]string, 0, p.Len())
	for _, k := range p.Keys() {
		v, _ := p.Get(k)
		parts = append(parts, quotePlus(k)+"="+quotePlus(v))
	}
	return strings.Join(parts, "&")
}

func quotePlus(s string) string {
	const upperhex = "0123456789ABCDEF"
	var sb strings.Builder
	for i := range len(s) {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
			c == '-' || c == '_' || c == '.' || c == '~':
			sb.WriteByte(c)
		case c == ' ':
			sb.WriteByte('+')
		default:
			sb.WriteByte('%')
			sb.WriteByte(upperhex[c>>4])
			sb.WriteByte(upperhex[c&15])
		}
	}
	return sb.String()
}

func toInt64(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case int64:
		return t
	case int:
		return int64(t)
	case string:
		var out int64
		fmt.Sscanf(t, "%d", &out)
		return out
	case json.Number:
		n, _ := t.Int64()
		return n
	}
	return 0
}

var _ = fhttp.MethodGet
