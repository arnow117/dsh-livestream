package douyin

// bd-ticket-guard crypto.
// HMAC mode: ECDH(client priv, server cert) -> HKDF-SHA256 -> HMAC-SHA256.
// ECDSA mode: direct ECDSA-SHA256 (DER) fallback when no server cert.

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"strings"
)

const getClientCertAPI = "/passport/ticket_guard/get_client_cert/"

var p256SPKIPrefix = mustHex("3059301306072a8648ce3d020106082a8648ce3d03010703420004")

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func loadSigningKey(prv string) (*ecdsa.PrivateKey, error) {
	if strings.Contains(prv, "-----BEGIN") {
		block, _ := pem.Decode([]byte(prv))
		if block == nil {
			return nil, fmt.Errorf("invalid PEM private key")
		}
		if k, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
			return k, nil
		}
		k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		ec, ok := k.(*ecdsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("not an EC private key")
		}
		return ec, nil
	}
	raw, err := hex.DecodeString(strings.TrimSpace(prv))
	if err != nil {
		return nil, err
	}
	return parseRawP256(raw)
}

func parseRawP256(raw []byte) (*ecdsa.PrivateKey, error) {
	priv, err := ecdh.P256().NewPrivateKey(raw)
	if err != nil {
		return nil, err
	}
	// Reconstruct the ecdsa key from the ECDH key's big.Int.
	ec := &ecdsa.PrivateKey{}
	ec.Curve = elliptic.P256()
	ec.D = new(big.Int).SetBytes(priv.Bytes())
	ec.PublicKey.Curve = elliptic.P256()
	ec.PublicKey.X, ec.PublicKey.Y = elliptic.P256().ScalarBaseMult(raw)
	return ec, nil
}

func pemBody(pemStr string) ([]byte, error) {
	var sb strings.Builder
	for line := range strings.SplitSeq(strings.TrimSpace(pemStr), "\n") {
		if strings.Contains(line, "-----") {
			continue
		}
		sb.WriteString(strings.TrimSpace(line))
	}
	return base64.StdEncoding.DecodeString(sb.String())
}

func serverPubPoint(serverCert string) ([]byte, error) {
	if rest, ok := strings.CutPrefix(serverCert, "pub."); ok {
		return base64.StdEncoding.DecodeString(rest)
	}
	der, err := pemBody(serverCert)
	if err != nil {
		return nil, err
	}
	_, after, ok := strings.Cut(string(der), string(p256SPKIPrefix))
	if !ok {
		return nil, fmt.Errorf("服务端证书中未找到 P-256 公钥")
	}
	if len(after) < 64 {
		return nil, fmt.Errorf("服务端证书公钥长度不足")
	}
	return append([]byte{0x04}, after[:64]...), nil
}

func hkdfSHA256(ikm []byte, length int, salt, info []byte) []byte {
	if len(salt) == 0 {
		salt = make([]byte, sha256.Size)
	}
	mac := hmac.New(sha256.New, salt)
	mac.Write(ikm)
	prk := mac.Sum(nil)
	var okm, block []byte
	for counter := byte(1); len(okm) < length; counter++ {
		m := hmac.New(sha256.New, prk)
		m.Write(block)
		m.Write(info)
		m.Write([]byte{counter})
		block = m.Sum(nil)
		okm = append(okm, block...)
	}
	return okm[:length]
}

// DeriveECDHKey returns the 32-byte HKDF key from client priv + server cert.
func DeriveECDHKey(prv, serverCert string) ([]byte, error) {
	key, err := loadSigningKey(prv)
	if err != nil {
		return nil, err
	}
	point, err := serverPubPoint(serverCert)
	if err != nil {
		return nil, err
	}
	priv, err := ecdh.P256().NewPrivateKey(key.D.Bytes())
	if err != nil {
		return nil, err
	}
	pub, err := ecdh.P256().NewPublicKey(point)
	if err != nil {
		return nil, err
	}
	shared, err := priv.ECDH(pub)
	if err != nil {
		return nil, err
	}
	// Only the X coordinate (32 bytes) is hashed, which is what ECDH
	// returns for P-256.
	return hkdfSHA256(shared, 32, nil, nil), nil
}

// GenerateReeKey returns base64(0x04||X||Y) of the client public key.
func GenerateReeKey(prv string) string {
	key, err := loadSigningKey(prv)
	if err != nil {
		return ""
	}
	raw := elliptic.Marshal(elliptic.P256(), key.PublicKey.X, key.PublicKey.Y)
	return base64.StdEncoding.EncodeToString(raw)
}

// TicketGuardVersion returns "1" for ts.1* signatures, else "2".
func TicketGuardVersion(tsSign string) string {
	if strings.HasPrefix(tsSign, "ts.1") {
		return "1"
	}
	return "2"
}

func jsonCompact(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

// GetReqSign signs e with the client EC private key (ASN.1 DER, base64).
func GetReqSign(e any, prv string) (string, error) {
	msg := ""
	switch t := e.(type) {
	case string:
		msg = t
	default:
		msg = jsonCompact(v2any(t))
	}
	key, err := loadSigningKey(prv)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(msg))
	sig, err := ecdsa.SignASN1(rand.Reader, key, sum[:])
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(sig), nil
}

func v2any(v any) any {
	if s, ok := v.(string); ok {
		var out any
		if json.Unmarshal([]byte(s), &out) == nil {
			return out
		}
	}
	return v
}

// GetReqSignHMAC signs e with the derived ECDH key.
func GetReqSignHMAC(e any, ecdhKey []byte) string {
	msg := ""
	switch t := e.(type) {
	case string:
		msg = t
	default:
		msg = jsonCompact(v2any(t))
	}
	mac := hmac.New(sha256.New, ecdhKey)
	mac.Write([]byte(msg))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// GenerateBDTicketClientData builds the bd-ticket-guard-client-data header.
// Returns (clientDataBase64, algoType) where algoType is "hmac" or "ecdsa".
func GenerateBDTicketClientData(api, ticket, tsSign, prv string, ecdhKey []byte, timestamp int64, tTrust *int) (string, string, error) {
	if timestamp == 0 {
		timestamp = nowUnix()
	}
	resSign := fmt.Sprintf("ticket=%s&path=%s&timestamp=%d", ticket, api, timestamp)
	var reqSign, algoType string
	if len(ecdhKey) > 0 {
		reqSign, algoType = GetReqSignHMAC(resSign, ecdhKey), "hmac"
	} else {
		var err error
		reqSign, err = GetReqSign(resSign, prv)
		if err != nil {
			return "", "", err
		}
		algoType = "ecdsa"
	}
	payload := map[string]any{
		"ts_sign":     tsSign,
		"req_content": "ticket,path,timestamp",
		"req_sign":    reqSign,
		"timestamp":   timestamp,
	}
	if tTrust != nil {
		payload["t_trust"] = *tTrust
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(b), algoType, nil
}
