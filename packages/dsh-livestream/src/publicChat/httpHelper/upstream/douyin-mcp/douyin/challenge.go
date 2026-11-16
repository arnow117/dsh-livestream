package douyin

// Challenge body generation.
//
// The browser pipeline for /passport/web/challenge/ is deterministic for one
// device/browser bundle:
//   1. collectFingerprintInfo() returns the ordered 36-field device object;
//   2. key = SHA-256(userAgent), IV = key[16:];
//   3. plaintext = btoa(JSON.stringify(fingerprint));
//   4. AES-256-CBC/PKCS#7, serialized as Base64URL with padding;
//   5. sk = XOR5(encodeURIComponent(stack)) as non-padded hex.
//
// The challenge response also carries data.template (a server-side JS bundle)
// and data.passportiv. passportiv is encrypted locally into the bit_env
// cookie; the template is executed in a Node vm by runChallengeTemplate.

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed profiles/challenge_profile.json
var challengeProfileJSON []byte

//go:embed profiles/challenge_template_runner.js
var challengeTemplateRunnerJS []byte

// loadChallengeProfile parses the embedded profile once on first use.
var loadChallengeProfile = sync.OnceValues(func() (*jNode, error) {
	return parseOrderedJSON(challengeProfileJSON)
})

// buildChallengeSign builds the sign field of the challenge body.
func buildChallengeSign(fingerprint *jNode, ua string) (string, error) {
	if fingerprint == nil {
		root, err := loadChallengeProfile()
		if err != nil {
			return "", err
		}
		var ok bool
		fingerprint, ok = root.get("fingerprint")
		if !ok {
			return "", fmt.Errorf("challenge_profile.json 缺少 fingerprint")
		}
	}
	plaintext := base64.StdEncoding.EncodeToString([]byte(fingerprint.stringCompact()))
	ct, err := aesCBCPKCS7([]byte(plaintext), []byte(ua))
	if err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(ct), nil
}

// BuildBitEnv derives the bit_env cookie from the challenge passportiv.
func BuildBitEnv(passportiv, ua string) (string, error) {
	if passportiv == "" {
		return "", fmt.Errorf("challenge passportiv is required to derive bit_env")
	}
	ct, err := aesCBCPKCS7([]byte(passportiv), []byte(ua))
	if err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(ct), nil
}

func aesCBCPKCS7(plaintext, ua []byte) ([]byte, error) {
	key := sha256.Sum256(ua)
	padding := aes.BlockSize - len(plaintext)%aes.BlockSize
	padded := make([]byte, len(plaintext)+padding)
	copy(padded, plaintext)
	for i := len(plaintext); i < len(padded); i++ {
		padded[i] = byte(padding)
	}
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	out := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, key[16:]).CryptBlocks(out, padded)
	return out, nil
}

// BuildChallengeSk builds the sk field of the challenge body.
func BuildChallengeSk(stack string) (string, error) {
	if stack == "" {
		stack = os.Getenv("DY_PASSPORT_FIXED_CHALLENGE_STACK")
		if stack == "" {
			root, err := loadChallengeProfile()
			if err != nil {
				return "", err
			}
			profile := envOr("DY_PASSPORT_COOKIE_PROFILE", "chrome_current")
			node, _ := root.get("stack")
			if strings.EqualFold(profile, "chrome_current") {
				if cur, ok := root.get("stack_current"); ok {
					node = cur
				}
			}
			if node != nil {
				stack = node.str
			}
		}
	}
	encoded := escapeQuery(stack, "-_.!~*'()")
	return PassportEncrypt(encoded), nil
}

// BuildChallengeBody returns the urlencoded form body (sign then sk).
func BuildChallengeBody() (string, error) {
	sign, err := buildChallengeSign(nil, GetProfile().UA)
	if err != nil {
		return "", err
	}
	sk, err := BuildChallengeSk("")
	if err != nil {
		return "", err
	}
	return "sign=" + quotePlus(sign) + "&sk=" + quotePlus(sk), nil
}

// escapeQuery percent-encodes s, passing through the unreserved characters and
// any character listed in safe. Space becomes %20 (not +).
func escapeQuery(s, safe string) string {
	const upperhex = "0123456789ABCDEF"
	var sb strings.Builder
	for i := range len(s) {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
			c == '_' || c == '.' || c == '-' || c == '~' || strings.IndexByte(safe, c) >= 0 {
			sb.WriteByte(c)
			continue
		}
		sb.WriteByte('%')
		sb.WriteByte(upperhex[c>>4])
		sb.WriteByte(upperhex[c&15])
	}
	return sb.String()
}

// challengeDeviceProfile builds the device profile object consumed by
// challenge_template_runner.js.
func challengeDeviceProfile() map[string]any {
	p := GetProfile()
	g := p.Geo
	major := 0
	if i := strings.IndexByte(p.BrowserVersion, '.'); i > 0 {
		fmt.Sscanf(p.BrowserVersion[:i], "%d", &major)
	} else {
		fmt.Sscanf(p.BrowserVersion, "%d", &major)
	}
	return map[string]any{
		"ua":             p.UA,
		"browser_major":  major,
		"cpu_core_num":   atoiOr(p.CpuCoreNum, 0),
		"device_memory":  atoiOr(p.DeviceMemory, 0),
		"screen_width":   atoiOr(p.ScreenWidth, 0),
		"screen_height":  atoiOr(p.ScreenHeight, 0),
		"avail_width":    g[4],
		"avail_height":   g[5],
		"inner_width":    g[0],
		"inner_height":   g[1],
		"outer_width":    g[2],
		"outer_height":   g[3],
		"webgl_vendor":   p.WebGLVendor,
		"webgl_renderer": p.WebGLRenderer,
		"languages":      []string{"zh-CN", "zh", "en", "zh-TW", "ja"},
	}
}

// RunChallengeTemplate executes the server-issued challenge template in a Node
// vm and returns its {p_in, e_in} result.
func RunChallengeTemplate(templateJS string, timeoutSec int) (map[string]any, error) {
	node, err := requireNode("challenge template execution")
	if err != nil {
		return nil, err
	}
	if templateJS == "" {
		return nil, fmt.Errorf("challenge template is empty")
	}
	dir, err := os.MkdirTemp("", "dych_")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	runner := filepath.Join(dir, "runner.js")
	tpl := filepath.Join(dir, "t.js")
	prof := filepath.Join(dir, "p.json")
	if err := os.WriteFile(runner, challengeTemplateRunnerJS, 0o600); err != nil {
		return nil, err
	}
	if err := os.WriteFile(tpl, []byte(templateJS), 0o600); err != nil {
		return nil, err
	}
	profBytes, err := json.Marshal(challengeDeviceProfile())
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(prof, profBytes, 0o600); err != nil {
		return nil, err
	}
	cmd := exec.Command(node, runner, tpl, prof)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if timeoutSec <= 0 {
		timeoutSec = 60
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-time.After(time.Duration(timeoutSec) * time.Second):
		_ = cmd.Process.Kill()
		<-done
		return nil, fmt.Errorf("challenge template timed out")
	}
	if err != nil {
		return nil, fmt.Errorf("challenge template failed: %w", err)
	}
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		var payload struct {
			OK     bool           `json:"ok"`
			Result map[string]any `json:"result"`
		}
		if json.Unmarshal([]byte(line), &payload) != nil {
			continue
		}
		if !payload.OK {
			return nil, fmt.Errorf("challenge template returned ok=false")
		}
		return payload.Result, nil
	}
	return nil, fmt.Errorf("challenge template produced no JSON result")
}
