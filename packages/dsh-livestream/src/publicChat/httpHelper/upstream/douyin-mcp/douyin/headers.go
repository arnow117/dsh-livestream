package douyin

// Request header builders.

// HeaderTypes enumerates the header types.
type HeaderTypes int

const (
	HeaderGET HeaderTypes = iota
	HeaderPOST
	HeaderFORM
	HeaderDOC
	HeaderPROTOBUF
)

// BuildHeaders returns the browser-aligned XHR header set for a request kind.
func BuildHeaders(t HeaderTypes) Headers {
	prof := GetProfile()
	h := Headers{}
	h.Set("user-agent", prof.UA)
	switch t {
	case HeaderPOST:
		h.Set("accept", "*/*")
		h.Set("content-type", "application/json; charset=UTF-8")
	case HeaderFORM:
		h.Set("accept", "application/json, text/plain, */*")
		h.Set("content-type", "application/x-www-form-urlencoded; charset=UTF-8")
	case HeaderPROTOBUF:
		h.Set("accept", "application/x-protobuf")
		h.Set("content-type", "application/x-protobuf")
	case HeaderDOC:
		h = Headers{
			{Name: "accept", Value: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
			{Name: "accept-language", Value: prof.AcceptLanguage},
			{Name: "cache-control", Value: "no-cache"},
			{Name: "pragma", Value: "no-cache"},
			{Name: "priority", Value: "u=0, i"},
			{Name: "sec-ch-ua", Value: prof.SecCHUA},
			{Name: "sec-ch-ua-mobile", Value: "?0"},
			{Name: "sec-ch-ua-platform", Value: prof.SecCHUAPlatform},
			{Name: "sec-fetch-dest", Value: "document"},
			{Name: "sec-fetch-mode", Value: "navigate"},
			{Name: "sec-fetch-site", Value: "none"},
			{Name: "sec-fetch-user", Value: "?1"},
			{Name: "upgrade-insecure-requests", Value: "1"},
			{Name: "user-agent", Value: prof.UA},
		}
		return h
	default: // GET
		h.Set("accept", "application/json, text/plain, */*")
	}
	h.Set("sec-ch-ua", prof.SecCHUA)
	h.Set("sec-ch-ua-mobile", "?0")
	h.Set("sec-ch-ua-platform", prof.SecCHUAPlatform)
	h.Set("accept-language", prof.AcceptLanguage)
	h.Set("priority", "u=1, i")
	h.Set("sec-fetch-dest", "empty")
	h.Set("sec-fetch-mode", "cors")
	h.Set("sec-fetch-site", "same-origin")
	return h
}

// SetReferer sets the referer header.
func (h *Headers) SetReferer(url string) { h.Set("referer", url) }

// WithUIFID adds the uifid header from the UIFID cookie.
func (h *Headers) WithUIFID(a *Client) *Headers {
	if a == nil {
		return h
	}
	if v := a.Cookie.Get("UIFID"); v != "" {
		h.Set("uifid", v)
	}
	return h
}

// WithBDReadonly adds the four read-only bd-ticket-guard headers. It is a
// no-op when the session has no ticket-guard private key (cookie-only mode).
func (h *Headers) WithBDReadonly(a *Client) *Headers {
	if a == nil || a.PrivateKey == "" {
		return h
	}
	h.Set("bd-ticket-guard-ree-public-key", GenerateReeKey(a.PrivateKey))
	h.Set("bd-ticket-guard-version", "2")
	h.Set("bd-ticket-guard-web-version", TicketGuardVersion(a.TsSign))
	algo := "ecdsa"
	if len(a.ClientCert) > 4 && a.ClientCert[:4] == "pub." {
		algo = "hmac"
	}
	if algo == "hmac" {
		h.Set("bd-ticket-guard-web-sign-type", "1")
	} else {
		h.Set("bd-ticket-guard-web-sign-type", "0")
	}
	return h
}
