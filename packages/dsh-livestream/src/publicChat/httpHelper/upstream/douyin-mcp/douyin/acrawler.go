package douyin

// __ac_signature generation. The page's acrawler bundle is an obfuscated VMP
// that expects a DOM/navigator environment; like the passport challenge
// template in challenge.go, it is executed in a Node vm with the captured
// Chromium shapes, not reimplemented.
//
// Node is only needed when抖音 actually serves a challenge page; every other
// signature in this package is pure Go.

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

//go:embed profiles/acrawler/run_ac_node.js profiles/acrawler/ac_vm.js profiles/acrawler/browser_window_shape.json profiles/acrawler/canvas_actual_exact.json
var acrawlerFS embed.FS

// DefaultACVariant matches the verified browser capture.
const DefaultACVariant = "chrome-doc-native-proto"

// ACOptions carries the challenge inputs.
type ACOptions struct {
	Nonce    string
	Cookie   string // cookie header sent with the challenge request
	Href     string
	Referrer string
	UA       string
	Variant  string
	NowMS    int64
	// Strict makes every failure an error; otherwise a soft result with an
	// empty signature is returned.
	Strict bool
}

// NodeAvailable reports whether the acrawler runner can execute.
func NodeAvailable() bool {
	return resolveNode() != ""
}

// GenerateACSignature solves a page challenge and returns
// {sig, cookie_header, cookie, provenance, variant}.
func GenerateACSignature(ctx context.Context, opts ACOptions) (map[string]any, error) {
	soft := func(err error) (map[string]any, error) {
		if opts.Strict {
			return nil, err
		}
		cookies := map[string]any{}
		for name, value := range parseCookieHeader(opts.Cookie) {
			cookies[name] = value
		}
		return map[string]any{
			"sig":           "",
			"cookie_header": opts.Cookie,
			"cookie":        cookies,
			"provenance":    "unproven_synthetic",
		}, nil
	}
	if strings.TrimSpace(opts.Nonce) == "" {
		return soft(fmt.Errorf("ac_signature: nonce 不能为空"))
	}
	node, err := requireNode("page acrawler execution")
	if err != nil {
		return soft(err)
	}

	dir, err := os.MkdirTemp("", "dyac_")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	for _, name := range []string{"run_ac_node.js", "ac_vm.js", "browser_window_shape.json", "canvas_actual_exact.json"} {
		data, err := acrawlerFS.ReadFile("profiles/acrawler/" + name)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			return nil, err
		}
	}

	variant := opts.Variant
	if variant == "" {
		variant = DefaultACVariant
	}
	now := opts.NowMS
	if now == 0 {
		now = time.Now().UnixMilli()
	}
	env := append(os.Environ(),
		"AC_NONCE="+opts.Nonce,
		"AC_SIGN_NONCE="+opts.Nonce,
		"AC_COOKIE_ONLY="+opts.Cookie,
		"AC_HREF="+orDefault(opts.Href, "https://www.douyin.com/jingxuan"),
		"AC_REFERRER="+opts.Referrer,
		"AC_VARIANT="+variant,
		"AC_NOW="+fmt.Sprintf("%d", now),
	)
	if opts.UA != "" {
		env = append(env, "AC_UA="+opts.UA)
	}
	if canvas, err := acrawlerFS.ReadFile("profiles/acrawler/canvas_actual_exact.json"); err == nil {
		// The fixture is a JSON document; the runner wants the decoded string.
		var dataURL string
		if json.Unmarshal(canvas, &dataURL) == nil && dataURL != "" {
			env = append(env, "AC_CANVAS_DATA_URL="+dataURL)
		}
	}

	runCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(runCtx, node, filepath.Join(dir, "run_ac_node.js"))
	cmd.Dir = dir
	cmd.Env = env
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return soft(fmt.Errorf("acrawler Node runner 执行失败: %w", err))
	}

	payload := lastJSONLine(stdout.String())
	sig, _ := payload["sig"].(string)
	if !strings.HasPrefix(sig, "_") {
		return soft(fmt.Errorf("acrawler Node runner 未产出签名"))
	}
	cookieHeader, _ := payload["cookie"].(string)
	before := parseCookieHeader(opts.Cookie)
	out := parseCookieHeader(cookieHeader)
	mutations := map[string]any{}
	for name, value := range out {
		if before[name] != value {
			mutations[name] = value
		}
	}
	cookies := map[string]any{}
	for name, value := range out {
		cookies[name] = value
	}
	return map[string]any{
		"sig":              sig,
		"cookie_header":    cookieHeader,
		"cookie":           cookies,
		"cookie_mutations": mutations,
		"provenance":       "node_page_js",
		"variant":          variant,
	}, nil
}

// SolveACChallenge reads __ac_nonce out of a challenge body, solves it and
// merges the resulting cookies (__ac_signature) into the session.
func (c *Client) SolveACChallenge(ctx context.Context, body []byte) (map[string]any, error) {
	nonce := extractACNonce(string(body))
	if nonce == "" {
		return nil, fmt.Errorf("响应里没有 __ac_nonce，无法计算 __ac_signature")
	}
	prof := GetProfile()
	res, err := GenerateACSignature(ctx, ACOptions{
		Nonce:    nonce,
		Cookie:   c.CookieStr(),
		Referrer: douyinBase + "/",
		UA:       prof.UA,
		Strict:   true,
	})
	if err != nil {
		return nil, err
	}
	if cookies, ok := res["cookie"].(map[string]any); ok {
		for name, value := range cookies {
			if s, ok := value.(string); ok && s != "" {
				c.Cookie.Set(name, s)
			}
		}
	}
	return res, nil
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

func parseCookieHeader(header string) map[string]string {
	out := map[string]string{}
	for part := range strings.SplitSeq(header, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, value, found := strings.Cut(part, "=")
		if !found {
			continue
		}
		out[strings.TrimSpace(name)] = strings.TrimSpace(value)
	}
	return out
}

func lastJSONLine(stdout string) map[string]any {
	lines := strings.Split(stdout, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		var out map[string]any
		if json.Unmarshal([]byte(line), &out) == nil {
			return out
		}
	}
	return map[string]any{}
}

// extractACNonce pulls the nonce out of the acrawler challenge page.
func extractACNonce(body string) string {
	const marker = "__ac_nonce"
	_, after, ok := strings.Cut(body, marker)
	if !ok {
		return ""
	}
	// Forms seen in the wild: __ac_nonce="...", __ac_nonce='...', __ac_nonce=...,
	// and the JSON shape "__ac_nonce":"...".
	rest := strings.TrimLeft(after, " \t\r\n=:\"'")
	if end := strings.IndexAny(rest, "\"'; \t\r\n"); end >= 0 {
		rest = rest[:end]
	}
	if len(rest) > 64 {
		rest = rest[:64]
	}
	return rest
}
