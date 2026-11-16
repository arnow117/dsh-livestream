package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image/png"
	"strings"
	"time"

	"github.com/yunsur/douyin-mcp/douyin"
)

// newSessionClient creates one private client for an entire login attempt.
// The supplied transport is a test seam; production uses the fixed upstream
// transport with redirects disabled and a private scoped-cookie adapter.
func newSessionClient(transport douyin.Transport) (*douyin.Client, *sessionTransport, error) {
	if transport == nil {
		var err error
		transport, err = douyin.NewHTTPClient("")
		if err != nil {
			return nil, nil, errors.New("session client unavailable")
		}
	}
	scoped, err := newSessionTransport(transport)
	if err != nil {
		return nil, nil, errors.New("session client unavailable")
	}
	client, err := douyin.NewClient("", douyin.Options{Transport: scoped})
	if err != nil {
		return nil, nil, errors.New("session client unavailable")
	}
	return client, scoped, nil
}

// captureSessionIdentity requires independent fresh profile and query results.
// Neither a cached client UID nor a caller-supplied UID can establish identity.
func captureSessionIdentity(ctx context.Context, client *douyin.Client) (string, error) {
	if client == nil {
		return "", errors.New("session identity unavailable")
	}
	profile, err := client.GetMyProfile(ctx)
	if err != nil {
		return "", errors.New("session identity unavailable")
	}
	user, ok := profile["user"].(map[string]any)
	if !ok {
		return "", errors.New("session identity unavailable")
	}
	profileUID, ok := principalUID(user["uid"])
	if !ok {
		return "", errors.New("session identity unavailable")
	}
	query, err := client.DSHQuerySessionUser(ctx)
	if err != nil {
		return "", errors.New("session identity unavailable")
	}
	queryUID, ok := principalUID(query["user_uid"])
	if !ok || queryUID != profileUID {
		return "", errors.New("session identity unavailable")
	}
	return queryUID, nil
}

var errSessionExpired = errors.New("session expired")

// loginAndCaptureSession keeps authentication and fresh identity reads on the
// same Client. Only a validated, locally re-encoded PNG is published to the
// owner-facing layer; raw QR response values never leave this function.
func loginAndCaptureSession(ctx context.Context, client *douyin.Client, publish func(string)) (string, error) {
	if client == nil || publish == nil {
		return "", errors.New("session unavailable")
	}
	attempt, cancel := context.WithTimeout(ctx, 300*time.Second)
	defer cancel()
	invalidQR := false
	loggedIn, err := client.LoginByQRCode(attempt, 300, func(data map[string]any) {
		image, ok := sessionQRImage(data)
		if !ok {
			invalidQR = true
			cancel()
			return
		}
		publish(image)
	})
	if errors.Is(attempt.Err(), context.DeadlineExceeded) {
		return "", errSessionExpired
	}
	if err != nil || invalidQR || loggedIn != client || attempt.Err() != nil {
		return "", errors.New("session login unavailable")
	}
	return captureSessionIdentity(attempt, client)
}

func sessionQRImage(data map[string]any) (string, bool) {
	var result string
	for _, value := range data {
		raw, ok := value.(string)
		if !ok || len(raw) == 0 || len(raw) > 48*1024 {
			continue
		}
		raw = strings.TrimPrefix(raw, "data:image/png;base64,")
		decoded, err := base64.StdEncoding.Strict().DecodeString(raw)
		if err != nil || len(decoded) == 0 || len(decoded) > 32*1024 {
			continue
		}
		config, err := png.DecodeConfig(bytes.NewReader(decoded))
		if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width > 1024 || config.Height > 1024 || config.Width*config.Height > 1024*1024 {
			continue
		}
		image, err := png.Decode(bytes.NewReader(decoded))
		if err != nil {
			continue
		}
		var clean bytes.Buffer
		if err := png.Encode(&clean, image); err != nil || clean.Len() > 32*1024 {
			continue
		}
		if result != "" {
			return "", false
		}
		result = "data:image/png;base64," + base64.StdEncoding.EncodeToString(clean.Bytes())
	}
	return result, result != ""
}
