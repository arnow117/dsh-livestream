package douyin

// Passport (login) pure helpers.
//
//   - passport_encrypt: UTF-8 bytes XOR 5, concatenated as non-padded
//     lowercase hex (JS toString(16)).
//   - bd_ticket_guard_client_data: the client publishes its P-256 public key
//     through a Cookie *before* the login request, so the server can sign the
//     eventual ticket to that key.
//   - bd_ticket_guard_client_data_v2: HMAC-SHA256(ecdhKey, "sec_ts="+sec_ts).

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/url"
	"slices"
	"strconv"
	"strings"

	fhttp "github.com/bogdanfinn/fhttp"
)

// PassportEncrypt applies the passport field encoding.
func PassportEncrypt(text string) string {
	src := []byte(text)
	var sb strings.Builder
	sb.Grow(len(src) * 2)
	for _, b := range src {
		sb.WriteString(strconv.FormatInt(int64(b^5), 16))
	}
	return sb.String()
}

// percentDecode percent-decodes without turning '+' into space.
func percentDecode(s string) string {
	if out, err := url.PathUnescape(s); err == nil {
		return out
	}
	return s
}

// percentEncode percent-encodes every byte except the unreserved set.
func percentEncode(s string) string { return queryEscapeStrict(s) }

// GenerateECKeypair generates a P-256 keypair as SEC1 private PEM and PKIX
// public PEM.
func GenerateECKeypair() (privPEM, pubPEM string, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return "", "", err
	}
	privPEM = string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
	pubDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return "", "", err
	}
	pubPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER}))
	return privPEM, pubPEM, nil
}

// BuildClientDataCookie builds the bd-ticket-guard-client-data cookie.
func BuildClientDataCookie(privateKey string) string {
	payload := jObj()
	payload.set("bd-ticket-guard-version", jInt(2))
	payload.set("bd-ticket-guard-iteration-version", jInt(1))
	payload.set("bd-ticket-guard-ree-public-key", jStr(GenerateReeKey(privateKey)))
	payload.set("bd-ticket-guard-web-version", jInt(2))
	raw := payload.stringCompact()
	return percentEncode(base64.StdEncoding.EncodeToString([]byte(raw)))
}

// BuildClientDataV2Cookie builds the v2 bd-ticket-guard-client-data cookie.
func BuildClientDataV2Cookie(privateKey, secTS, serverCert, tsSign string) (string, error) {
	ecdhKey, err := DeriveECDHKey(privateKey, serverCert)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, ecdhKey)
	mac.Write([]byte("sec_ts=" + secTS))
	reqSign := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	payload := jObj()
	payload.set("ree_public_key", jStr(GenerateReeKey(privateKey)))
	if tsSign != "" {
		payload.set("ts_sign", jStr(tsSign))
	}
	payload.set("req_content", jStr("sec_ts"))
	payload.set("req_sign", jStr(reqSign))
	payload.set("sec_ts", jStr(secTS))
	raw := payload.stringCompact()
	return percentEncode(base64.StdEncoding.EncodeToString([]byte(raw))), nil
}

// TicketGuardInfo is the decoded bd-ticket-guard-server-data payload.
type TicketGuardInfo struct {
	Ticket     string
	TsSign     string
	ClientCert string
	CreateTime any
	LogID      string
}

// ParseTicketGuardServerData parses the bd-ticket-guard-server-data header.
func ParseTicketGuardServerData(resp *Response) *TicketGuardInfo {
	raw := resp.HeaderGet("bd-ticket-guard-server-data")
	if raw == "" {
		if i := slices.IndexFunc(resp.Cookies, func(ck *fhttp.Cookie) bool {
			return ck.Name == "bd_ticket_guard_server_data"
		}); i >= 0 {
			raw = resp.Cookies[i].Value
		}
	}
	if raw == "" {
		return nil
	}
	raw = percentDecode(raw)
	decoded, err := base64.StdEncoding.DecodeString(raw + strings.Repeat("=", (4-len(raw)%4)%4))
	if err != nil {
		return nil
	}
	var info struct {
		Ticket     string `json:"ticket"`
		TsSign     string `json:"ts_sign"`
		ClientCert string `json:"client_cert"`
		CreateTime any    `json:"create_time"`
		LogID      string `json:"log_id"`
	}
	if err := json.Unmarshal(decoded, &info); err != nil {
		return nil
	}
	if info.Ticket == "" {
		return nil
	}
	return &TicketGuardInfo{
		Ticket:     info.Ticket,
		TsSign:     info.TsSign,
		ClientCert: info.ClientCert,
		CreateTime: info.CreateTime,
		LogID:      info.LogID,
	}
}

// ApplyTicketGuard writes a freshly signed ticket back onto the client when
// the response carries one.
func ApplyTicketGuard(c *Client, resp *Response) bool {
	info := ParseTicketGuardServerData(resp)
	if info == nil {
		return false
	}
	c.Ticket = info.Ticket
	c.TsSign = info.TsSign
	c.ClientCert = info.ClientCert
	return true
}

// mergeLoginCookies merges Set-Cookie values: an empty value is a
// server-side deletion and removes the name instead of storing "".
func mergeLoginCookies(c *Client, resp *Response) map[string]string {
	got := map[string]string{}
	for _, ck := range resp.Cookies {
		if ck.Name == "" {
			continue
		}
		got[ck.Name] = ck.Value
		if ck.Value == "" {
			c.Cookie.Del(ck.Name)
			continue
		}
		c.Cookie.Set(ck.Name, ck.Value)
	}
	return got
}
