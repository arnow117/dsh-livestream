package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"os"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const maxMaterialBytes = 1 << 16

// materialInput is only decoded from the inherited read-only material FD. It is
// not a public HTTP DTO and must never be put in a log or an operation journal.
type materialInput struct {
	Cookies         []cookieMaterial `json:"cookies"`
	UserAgent       string           `json:"userAgent"`
	BrowserName     string           `json:"browserName"`
	BrowserVersion  string           `json:"browserVersion"`
	BrowserLanguage string           `json:"browserLanguage"`
	EngineName      string           `json:"engineName"`
	EngineVersion   string           `json:"engineVersion"`
	OSName          string           `json:"osName"`
	OSVersion       string           `json:"osVersion"`
	CPUCoreNum      string           `json:"cpuCoreNum"`
	DeviceMemory    string           `json:"deviceMemory"`
	Platform        string           `json:"platform"`
	ScreenWidth     int              `json:"screenWidth"`
	ScreenHeight    int              `json:"screenHeight"`
	Geo             *[8]int          `json:"geo"`
	MsToken         string           `json:"msToken"`
	WebID           string           `json:"webId"`
	VerifyFP        string           `json:"verifyFp"`
	UIFID           string           `json:"uifid"`
	Ticket          string           `json:"ticket"`
	TsSign          string           `json:"tsSign"`
	PrivateKey      string           `json:"privateKey"`
	ServerCert      string           `json:"serverCert"`
	BDMode          string           `json:"bdMode"`
	CSRFToken       string           `json:"csrfToken"`
	CSRFOrigin      string           `json:"csrfOrigin"`
	CSRFPath        string           `json:"csrfPath"`
	CSRFExpiresMs   int64            `json:"csrfExpiresMs"`
	ExpiresAtMs     int64            `json:"expiresAtMs"`
}

type authContext struct {
	material       materialInput
	cookies        *frozenCookies
	contextID      string
	processNonce   string
	materialDigest string
	certNotAfterMs int64
	ecdhKey        []byte
}

func validMaterialString(value string, maximum int) bool {
	return len(value) > 0 && len(value) <= maximum && !strings.ContainsAny(value, "\r\n\x00")
}

func materialFromFD(file *os.File, now time.Time) (*authContext, error) {
	if file == nil {
		return nil, errors.New("material unavailable")
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return nil, errors.New("unsafe material descriptor")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, file.Fd(), syscall.F_GETFL, 0)
	if !ok || stat.Nlink != 1 || stat.Uid != uint32(os.Getuid()) || errno != 0 || flags&syscall.O_ACCMODE != syscall.O_RDONLY {
		return nil, errors.New("unsafe material descriptor")
	}
	if offset, err := file.Seek(0, io.SeekCurrent); err != nil || offset != 0 {
		return nil, errors.New("invalid material offset")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxMaterialBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxMaterialBytes || !utf8.Valid(data) || !validUnicodeEscapes(data) {
		return nil, errors.New("invalid material encoding")
	}
	return freezeAuthContext(data, now)
}

func freezeAuthContext(data []byte, now time.Time) (*authContext, error) {
	if len(data) == 0 || len(data) > maxMaterialBytes || !utf8.Valid(data) || !validUnicodeEscapes(data) {
		return nil, errors.New("invalid material encoding")
	}
	check := json.NewDecoder(bytes.NewReader(data))
	check.UseNumber()
	if _, err := strictValue(check, 0); err != nil {
		return nil, errors.New("invalid material object")
	}
	if _, err := check.Token(); err != io.EOF {
		return nil, errors.New("invalid material object")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var material materialInput
	if err := decoder.Decode(&material); err != nil {
		return nil, errors.New("invalid material object")
	}
	nowMs := now.UnixMilli()
	if nowMs <= 0 || material.ExpiresAtMs <= nowMs || material.CSRFExpiresMs <= nowMs ||
		material.CSRFOrigin != "https://live.douyin.com" || material.CSRFPath != "/webcast/room/chat/" ||
		material.ScreenWidth <= 0 || material.ScreenWidth > 32768 || material.ScreenHeight <= 0 || material.ScreenHeight > 32768 || material.Geo == nil ||
		(material.BDMode != "hmac" && material.BDMode != "ecdsa") {
		return nil, errors.New("invalid material scope or expiry")
	}
	for _, value := range []string{material.UserAgent, material.BrowserName, material.BrowserVersion, material.BrowserLanguage,
		material.EngineName, material.EngineVersion, material.OSName, material.OSVersion, material.CPUCoreNum, material.DeviceMemory, material.Platform,
		material.MsToken, material.WebID, material.VerifyFP, material.UIFID, material.Ticket,
		material.TsSign, material.CSRFToken} {
		if !validMaterialString(value, 8192) {
			return nil, errors.New("missing material")
		}
	}
	if len(material.PrivateKey) == 0 || len(material.PrivateKey) > 8192 || strings.ContainsAny(material.PrivateKey, "\r\x00") {
		return nil, errors.New("missing key material")
	}
	cookies, err := freezeCookies(material.Cookies, nowMs)
	if err != nil {
		return nil, errors.New("invalid cookie material")
	}
	for _, item := range cookies.entries {
		switch item.Name {
		case "UIFID":
			if item.Value != material.UIFID {
				return nil, errors.New("conflicting material")
			}
		case "s_v_web_id":
			if item.Value != material.VerifyFP {
				return nil, errors.New("conflicting material")
			}
		case "msToken":
			if item.Value != material.MsToken {
				return nil, errors.New("conflicting material")
			}
		}
	}
	privateKey, err := loadSigningKey(material.PrivateKey)
	if err != nil || privateKey.Curve != elliptic.P256() || privateKey.D == nil || privateKey.D.Sign() <= 0 ||
		privateKey.D.Cmp(elliptic.P256().Params().N) >= 0 {
		return nil, errors.New("invalid signing key")
	}
	x, y := elliptic.P256().ScalarBaseMult(privateKey.D.FillBytes(make([]byte, 32)))
	if !privateKey.PublicKey.Equal(&ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}) {
		return nil, errors.New("signing key mismatch")
	}
	var shared []byte
	certNotAfterMs := material.ExpiresAtMs
	if material.BDMode == "hmac" {
		if len(material.ServerCert) == 0 || len(material.ServerCert) > 8192 || strings.ContainsAny(material.ServerCert, "\r\x00") {
			return nil, errors.New("missing server material")
		}
		if strings.HasPrefix(material.ServerCert, "-----BEGIN") {
			block, rest := pem.Decode([]byte(material.ServerCert))
			if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
				return nil, errors.New("invalid server certificate")
			}
			cert, err := x509.ParseCertificate(block.Bytes)
			if err != nil || now.Before(cert.NotBefore) || !now.Before(cert.NotAfter) {
				return nil, errors.New("invalid server certificate")
			}
			certNotAfterMs = cert.NotAfter.UnixMilli()
		}
		shared, err = DeriveECDHKey(material.PrivateKey, material.ServerCert)
		if err != nil || len(shared) == 0 {
			return nil, errors.New("invalid server material")
		}
	} else if material.ServerCert != "" {
		return nil, errors.New("unexpected server material")
	}
	var random [64]byte
	if _, err = rand.Read(random[:]); err != nil {
		return nil, errors.New("random source unavailable")
	}
	hash := sha256.New()
	hash.Write(random[32:])
	hash.Write(data)
	material.Cookies = nil
	geo := *material.Geo
	material.Geo = &geo
	return &authContext{
		material: material, cookies: cookies, contextID: hex.EncodeToString(random[:16]),
		processNonce: hex.EncodeToString(random[16:32]), materialDigest: hex.EncodeToString(hash.Sum(nil)),
		certNotAfterMs: certNotAfterMs, ecdhKey: append([]byte(nil), shared...),
	}, nil
}

func (c *authContext) validAt(now time.Time) bool {
	if c == nil {
		return false
	}
	nowMs := now.UnixMilli()
	return nowMs > 0 && nowMs < c.material.ExpiresAtMs && nowMs < c.material.CSRFExpiresMs &&
		nowMs < c.certNotAfterMs && c.cookies.validAt(nowMs)
}
