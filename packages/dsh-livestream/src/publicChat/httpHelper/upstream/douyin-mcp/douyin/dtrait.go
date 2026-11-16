package douyin

// x-tt-session-dtrait construction.
//
// Header shape: <pk1_version>_<b64(RSA_PKCS1v15(pk1, aes_key_hex))>_<b64(iv+AES128CBC(payload))>

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"slices"
	"strings"
	"time"
)

const defaultTraitSDKVersion = "1.0.0.16"

const builtinTraitPK1B64 = "LS0tLS1CRUdJTiBSU0EgUFVCTElDIEtFWS0tLS0tCk1JSUJDZ0tDQVFFQTQrZHZ2WTd1" +
	"TStvcGMrbkxHL0R1bVNlRm83YVZjSW0xTE8rbVVJcldwclJ6UDBhMUdwRVEKNHF0TzlN" +
	"UmYvbHdFSXgzOCs0Qlo0WE9HemV2VnR1VXZmSU9VRTdBVHRRVzdGS0pmNVBuU0xDSTYv" +
	"azB2bDFGQwpMVVNWbUVQNnFQSnJJalo0elhvcWkzeXVOWisxb2RiUkEvL0dIZ2NnU3l5" +
	"eWFMcXp3amtwV0dYb3VNWW12WXNTCnBway9mdjJFV0FCc3RQTnhXYTRFT0JDYWRUVVBr" +
	"WE5RNzZOQkVQOXh6ZkpTMjB3aUR2MW9TL3ZLdnJTVXBXY0oKbmF6a2tCdnFRYmJBcVZi" +
	"UUZURi9EUGlrcHB1NlpUNmxHSVh2SktDcmVlRmlIQTJxSzZ0UzE4U1dWSFc5QVJ6MQor" +
	"cGpCMWVxSUlZdG9oV3BUMkI0ME9DNE84dFZlQkFuYmlRSURBUUFCCi0tLS0tRU5EIFJT" +
	"QSBQVUJMSUMgS0VZLS0tLS0="

// builtinTraitPubkey returns the d0 public key embedded in the login bundle.
func builtinTraitPubkey() (pem, version string, err error) {
	raw, err := base64.StdEncoding.DecodeString(builtinTraitPK1B64)
	if err != nil {
		return "", "", err
	}
	return string(raw), "d0", nil
}

func derLen(buf []byte, i int) (int, int) {
	n := int(buf[i])
	i++
	if n < 0x80 {
		return n, i
	}
	k := n & 0x7F
	v := 0
	for j := range k {
		v = v<<8 | int(buf[i+j])
	}
	return v, i + k
}

// parseRSAPublicKey parses a PKCS#1 "BEGIN RSA PUBLIC KEY" PEM into (n, e).
func parseRSAPublicKey(pemStr string) (*rsa.PublicKey, error) {
	var body strings.Builder
	for line := range strings.SplitSeq(strings.TrimSpace(pemStr), "\n") {
		if strings.Contains(line, "-----") {
			continue
		}
		body.WriteString(strings.TrimSpace(line))
	}
	der, err := base64.StdEncoding.DecodeString(body.String())
	if err != nil {
		return nil, err
	}
	if der[0] != 0x30 {
		return nil, fmt.Errorf("不是合法的 DER SEQUENCE")
	}
	_, i := derLen(der, 1)
	if der[i] != 0x02 {
		return nil, fmt.Errorf("缺少 modulus")
	}
	ln, i := derLen(der, i+1)
	n := new(big.Int).SetBytes(der[i : i+ln])
	i += ln
	if der[i] != 0x02 {
		return nil, fmt.Errorf("缺少 exponent")
	}
	le, i := derLen(der, i+1)
	e := new(big.Int).SetBytes(der[i : i+le])
	return &rsa.PublicKey{N: n, E: int(e.Int64())}, nil
}

func aesCBCEncrypt(key, iv, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	pad := aes.BlockSize - len(plaintext)%aes.BlockSize
	padded := slices.Concat(plaintext, make([]byte, pad))
	for i := len(padded) - pad; i < len(padded); i++ {
		padded[i] = byte(pad)
	}
	out := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, padded)
	return out, nil
}

// buildSessionDtrait builds (and caches) the header for a request path.
func (c *Client) buildSessionDtrait(path string, aid int, origin string) (string, error) {
	pk1, version, err := builtinTraitPubkey()
	if err != nil {
		return "", err
	}
	pub, err := parseRSAPublicKey(pk1)
	if err != nil {
		return "", err
	}

	cacheKey := fmt.Sprintf("%d|%s|%s", aid, origin, MD5Hex(c.DtraitBlob))
	c.mu.Lock()
	material, ok := c.dtraitMat[cacheKey]
	c.mu.Unlock()
	if !ok {
		keyRaw := make([]byte, 16)
		if _, err := rand.Read(keyRaw); err != nil {
			return "", err
		}
		keyHex := hex.EncodeToString(keyRaw)
		encKey, err := rsa.EncryptPKCS1v15(rand.Reader, pub, []byte(keyHex))
		if err != nil {
			return "", err
		}
		material = [2]string{keyHex, base64.StdEncoding.EncodeToString(encKey)}
		c.mu.Lock()
		if c.dtraitMat == nil {
			c.dtraitMat = map[string][2]string{}
		}
		c.dtraitMat[cacheKey] = material
		c.mu.Unlock()
	}

	key, err := hex.DecodeString(material[0])
	if err != nil {
		return "", err
	}
	iv := make([]byte, 16)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	payload, err := json.Marshal(struct {
		Dtrait     string `json:"dtrait"`
		Timestamp  int64  `json:"timestamp"`
		SDKVersion string `json:"sdkVersion"`
		Path       string `json:"path"`
	}{c.DtraitBlob, time.Now().Unix(), defaultTraitSDKVersion, path})
	if err != nil {
		return "", err
	}
	cipherBytes, err := aesCBCEncrypt(key, iv, payload)
	if err != nil {
		return "", err
	}
	part2 := base64.StdEncoding.EncodeToString(append(append([]byte{}, iv...), cipherBytes...))
	return fmt.Sprintf("%s_%s_%s", version, material[1], part2), nil
}
