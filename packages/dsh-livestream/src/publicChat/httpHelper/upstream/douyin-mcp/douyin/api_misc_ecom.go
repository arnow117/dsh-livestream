package douyin

// PC product-detail e-commerce APIs. On PC the product detail page is the real
// entry point for a product (the search page has no 商品 channel); the SKU/规格
// list behind 选择规格 lives at /aweme/v1/web/ecom/product/sku/list/.
//
// Wire shape (from the web bundle, module 844185 g / u.v_):
//
//	POST /aweme/v1/web/ecom/product/sku/list/
//	query: 平台块 + device_platform=webapp + webid/uifid/verifyFp + msToken + a_bogus
//	body:  JSON {product_id, shop_id}（Content-Type: application/json）
//
// The endpoint is only served by the www-hj.douyin.com cluster: the very same
// request against www.douyin.com answers 403 with an empty body (the browser's
// secsdk rewrites the URL to www-hj.douyin.com as well). a_bogus is signed with
// the www.douyin.com host config (www-hj has no separate config and falls back
// to it).

import (
	"context"
	"encoding/json"
)

// GetProductSKUList returns a product's SKU/规格 list (规格 → spec_items).
func (c *Client) GetProductSKUList(ctx context.Context, productID, shopID string) (map[string]any, error) {
	const api = "/aweme/v1/web/ecom/product/sku/list/"
	refer := douyinBase + "/"
	headers := BuildHeaders(HeaderPOST)
	headers.SetReferer(refer)
	headers.WithUIFID(c)

	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0") // 含 device_platform=webapp
	p.WithWebID(ctx, c, refer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())

	body, err := json.Marshal(map[string]string{
		"product_id": productID,
		"shop_id":    shopID,
	})
	if err != nil {
		return nil, err
	}
	// a_bogus 覆盖 query + 实际发送的 JSON body 字节。
	p.Add("a_bogus", c.Signer.SignQuery(p.SpliceURL(), string(body), "www.douyin.com"))

	resp, err := c.HTTP.PostJSON(ctx, BuildURL(douyinHJBase+api, standardEncodeQuery(p)), headers, c.CookieStr(), "", body)
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	return decodeJSONObject(resp.Body)
}
