package douyin

// HTTP transport. Douyin risk control inspects the TLS/HTTP2 fingerprint, so
// requests must go through a Chrome-impersonating client.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

// Header is an ordered request header.
type Header struct {
	Name  string
	Value string
}

// Headers is an ordered header list.
type Headers []Header

// Set adds or replaces a header (appends if new).
func (h *Headers) Set(name, value string) {
	for i := range *h {
		if strings.EqualFold((*h)[i].Name, name) {
			(*h)[i].Value = value
			return
		}
	}
	*h = append(*h, Header{Name: name, Value: value})
}

// Get returns the value for a header name.
func (h Headers) Get(name string) (string, bool) {
	for _, kv := range h {
		if strings.EqualFold(kv.Name, name) {
			return kv.Value, true
		}
	}
	return "", false
}

// Del removes a header.
func (h *Headers) Del(name string) {
	out := (*h)[:0]
	for _, kv := range *h {
		if !strings.EqualFold(kv.Name, name) {
			out = append(out, kv)
		}
	}
	*h = out
}

// Response is a minimal HTTP response.
type Response struct {
	StatusCode int
	Header     fhttp.Header
	Body       []byte
	Cookies    []*fhttp.Cookie
}

// Text returns the body as a string.
func (r *Response) Text() string { return string(r.Body) }

// HeaderGet returns a response header value.
func (r *Response) HeaderGet(name string) string { return r.Header.Get(name) }

// Transport is the HTTP transport a Client sends requests through.
//
// *HTTPClient is the production implementation (Chrome-impersonating TLS).
// Tests substitute their own Transport so the request/response handling of
// every API method can be exercised without touching the network.
type Transport interface {
	Do(ctx context.Context, method, rawURL string, headers Headers, cookieHeader string, body []byte) (*Response, error)
	Get(ctx context.Context, rawURL string, headers Headers, cookieHeader string) (*Response, error)
	PostJSON(ctx context.Context, rawURL string, headers Headers, cookieHeader, contentType string, body []byte) (*Response, error)
}

// noRedirectTransport is implemented by transports that can issue a request
// without following redirects, so intermediate 30x Set-Cookie headers can be
// captured. Transports that don't implement it fall back to Get.
type noRedirectTransport interface {
	GetNoRedirect(ctx context.Context, rawURL string, headers Headers, cookieHeader string) (*Response, error)
}

// HTTPClient wraps a Chrome-impersonating transport.
type HTTPClient struct {
	client tls_client.HttpClient
	mu     sync.Mutex
	proxy  string
}

func resolveProfile() profiles.ClientProfile {
	name := strings.ToLower(strings.TrimSpace(os.Getenv("DY_HTTP_PROFILE")))
	if name == "" {
		return profiles.Chrome_150
	}
	if p, ok := profiles.MappedTLSClients[name]; ok {
		return p
	}
	return profiles.Chrome_150
}

// NewHTTPClient creates the shared HTTP client.
func NewHTTPClient(proxy string) (*HTTPClient, error) {
	opts := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(30),
		tls_client.WithClientProfile(resolveProfile()),
		tls_client.WithRandomTLSExtensionOrder(),
		tls_client.WithCatchPanics(),
		tls_client.WithNotFollowRedirects(),
	}
	if proxy != "" {
		opts = append(opts, tls_client.WithProxyUrl(normalizeProxy(proxy)))
	}
	client, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), opts...)
	if err != nil {
		return nil, fmt.Errorf("create tls client: %w", err)
	}
	return &HTTPClient{client: client, proxy: proxy}, nil
}

func normalizeProxy(p string) string {
	if strings.Contains(p, "://") {
		return p
	}
	return "http://" + p
}

// Do performs a request with ordered headers and an explicit Cookie header.
func (h *HTTPClient) Do(ctx context.Context, method, rawURL string, headers Headers, cookieHeader string, body []byte) (*Response, error) {
	req, err := fhttp.NewRequestWithContext(ctx, method, rawURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	order := make([]string, 0, len(headers)+3)
	for _, kv := range headers {
		if strings.EqualFold(kv.Name, "cookie") || strings.EqualFold(kv.Name, "content-length") {
			continue
		}
		req.Header.Set(kv.Name, kv.Value)
		order = append(order, kv.Name)
	}
	if cookieHeader != "" {
		req.Header.Set("cookie", cookieHeader)
		order = append(order, "cookie")
	}
	// content-length is deliberately not set: fhttp/HTTP-2 computes it, and
	// setting it by hand emits a duplicate header that Douyin's CDN rejects
	// with HTTP 400 on every body-bearing POST.
	req.Header[fhttp.HeaderOrderKey] = order

	// Session helper never writes request URLs or metadata to debug logs.

	resp, err := h.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
	if err != nil || len(data) > 2<<20 {
		return nil, fmt.Errorf("session response unavailable")
	}
	return &Response{
		StatusCode: resp.StatusCode,
		Header:     resp.Header,
		Body:       data,
		Cookies:    resp.Cookies(),
	}, nil
}

// logRequestLine appends one JSON line describing an outgoing request. It is a
// calibration/debug aid enabled with DOUYIN_DEBUG_REQUESTS=<file>.
func logRequestLine(path string, rec map[string]any) {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	b, err := json.Marshal(rec)
	if err != nil {
		return
	}
	f.Write(b)
	f.Write([]byte("\n"))
}

// Get is a convenience helper.
func (h *HTTPClient) Get(ctx context.Context, rawURL string, headers Headers, cookieHeader string) (*Response, error) {
	return h.Do(ctx, fhttp.MethodGet, rawURL, headers, cookieHeader, nil)
}

// GetNoRedirect issues a GET that does not auto-follow redirects, so the
// intermediate 30x Set-Cookie headers can be captured.
func (h *HTTPClient) GetNoRedirect(ctx context.Context, rawURL string, headers Headers, cookieHeader string) (*Response, error) {
	opts := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(30),
		tls_client.WithClientProfile(resolveProfile()),
		tls_client.WithRandomTLSExtensionOrder(),
		tls_client.WithCatchPanics(),
		tls_client.WithNotFollowRedirects(),
	}
	if h.proxy != "" {
		opts = append(opts, tls_client.WithProxyUrl(normalizeProxy(h.proxy)))
	}
	client, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), opts...)
	if err != nil {
		return nil, err
	}
	hc := &HTTPClient{client: client, proxy: h.proxy}
	return hc.Get(ctx, rawURL, headers, cookieHeader)
}

// PostJSON posts a body with the given content type.
func (h *HTTPClient) PostJSON(ctx context.Context, rawURL string, headers Headers, cookieHeader, contentType string, body []byte) (*Response, error) {
	if contentType != "" {
		headers.Set("content-type", contentType)
	}
	return h.Do(ctx, fhttp.MethodPost, rawURL, headers, cookieHeader, body)
}

// BuildURL joins a base URL and a query string.
func BuildURL(base, query string) string {
	if query == "" {
		return base
	}
	return base + "?" + query
}

// EscapePathValue percent-encodes a path segment value.
func EscapePathValue(v string) string { return url.PathEscape(v) }

// SleepMS sleeps for the given number of milliseconds.
func SleepMS(ms int) { time.Sleep(time.Duration(ms) * time.Millisecond) }
