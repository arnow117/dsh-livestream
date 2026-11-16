package douyin

// PC IM rich-media upload + share-card builders.

import (
	"bytes"
	"cmp"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	_ "image/gif"  // width/height probing
	_ "image/jpeg" // width/height probing
	_ "image/png"  // width/height probing
	"io"
	"maps"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	imOrigin           = "https://www.douyin.com"
	imReferer          = "https://www.douyin.com/chat?isPopup=1"
	imUploadConfigPath = "/aweme/v1/web/im/upload/config/v2"
	imVODAPIVersion    = "2020-11-19"
	imDirectUploadMax  = 3 * 1024 * 1024
	imMaxFileSize      = 10 * 1024 * 1024
	imVODHost          = "vod.bytedanceapi.com"
	imVODService       = "vod"
	imRegion           = "cn-north-1"
	imMB               = 1024 * 1024
)

// ---------------------------------------------------------------------------
// media sources
// ---------------------------------------------------------------------------

type imMediaSource struct {
	data []byte
	path string
	size int64
	name string
}

func imNewMediaSource(ctx context.Context, c *Client, src, defaultName string) (*imMediaSource, error) {
	if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
		resp, err := c.HTTP.Get(ctx, src, Headers{}, "")
		if err != nil {
			return nil, err
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("下载媒体失败 HTTP %d: %s", resp.StatusCode, src)
		}
		return &imMediaSource{data: resp.Body, size: int64(len(resp.Body)), name: defaultName}, nil
	}
	st, err := os.Stat(src)
	if err != nil {
		return nil, err
	}
	return &imMediaSource{path: src, size: st.Size(), name: filepath.Base(src)}, nil
}

func (s *imMediaSource) read(offset int64, length int) ([]byte, error) {
	if s.data != nil {
		if offset >= int64(len(s.data)) {
			return nil, nil
		}
		end := offset + int64(length)
		if end > int64(len(s.data)) {
			end = int64(len(s.data))
		}
		return s.data[offset:end], nil
	}
	f, err := os.Open(s.path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, length)
	n, err := f.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		return nil, err
	}
	return buf[:n], nil
}

func imCRC32Hex(data []byte) string { return fmt.Sprintf("%08x", crc32.ChecksumIEEE(data)) }

func imImageSize(data []byte) (int64, int64) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0
	}
	return int64(cfg.Width), int64(cfg.Height)
}

func imSliceSizeFor(size int64) int64 {
	switch {
	case size >= 500*imMB:
		return 10 * imMB
	case size >= 100*imMB:
		return 5 * imMB
	default:
		return 3 * imMB
	}
}

// ---------------------------------------------------------------------------
// STS / upload nodes
// ---------------------------------------------------------------------------

type imSTS struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	SpaceName       string
	ExpireAt        int64
}

type imUploadNode struct {
	StoreURI     string
	Auth         string
	UploadID     string
	UploadHost   string
	SessionKey   string
	UploadHeader map[string]string
}

type imUploadConfigEntry struct {
	config    map[string]any
	expireMax int64
}

var imUploadConfigCache sync.Map // *Client -> imUploadConfigEntry

func imTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != "" && t != "0"
	case float64:
		return t != 0
	case json.Number:
		f, _ := t.Float64()
		return f != 0
	default:
		return true
	}
}

func imSTSValue(cfg map[string]any, names ...string) string {
	for _, name := range names {
		if imTruthy(cfg[name]) {
			return imStr(cfg[name])
		}
	}
	return ""
}

func imAsIntDefault(v any, def int64) int64 {
	switch t := v.(type) {
	case nil:
		return def
	case float64:
		return int64(t)
	case int64:
		return t
	case int:
		return int64(t)
	case json.Number:
		n, err := t.Int64()
		if err != nil {
			return def
		}
		return n
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
		if err != nil {
			f, ferr := strconv.ParseFloat(strings.TrimSpace(t), 64)
			if ferr != nil {
				return def
			}
			return int64(f)
		}
		return n
	default:
		return def
	}
}

func imNormalizeSTS(cfg map[string]any) (imSTS, error) {
	sts := imSTS{
		AccessKeyID:     imSTSValue(cfg, "access_key_id", "AccessKeyID", "AccessKeyId"),
		SecretAccessKey: imSTSValue(cfg, "secret_access_key", "SecretAccessKey"),
		SessionToken:    imSTSValue(cfg, "session_token", "SessionToken"),
		SpaceName:       imSTSValue(cfg, "space_name", "SpaceName"),
	}
	exp := cfg["expire_at"]
	if !imTruthy(exp) {
		exp = cfg["ExpiredTime"]
	}
	sts.ExpireAt = imAsIntDefault(exp, 0)
	if sts.AccessKeyID == "" || sts.SecretAccessKey == "" || sts.SessionToken == "" || sts.SpaceName == "" {
		return imSTS{}, fmt.Errorf("IM 上传凭证字段不完整: %v", imMapKeys(cfg))
	}
	return sts, nil
}

func imMapKeys(m map[string]any) []string {
	return slices.Sorted(maps.Keys(m))
}

func imSTSFromConfig(config map[string]any, name string) (imSTS, error) {
	raw, _ := config[name].(map[string]any)
	if _, ok := raw["AccessKeyID"]; ok {
		return imNormalizeSTS(raw)
	}
	return imNormalizeSTS(raw)
}

// ---------------------------------------------------------------------------
// Volcano VOD / ImageX gateway signing
// ---------------------------------------------------------------------------

type imKV struct{ k, v string }

func imSHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func imHMAC(key, msg []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(msg)
	return mac.Sum(nil)
}

func imCanonicalQuery(query []imKV) string {
	type pair struct{ k, v string }
	encoded := make([]pair, 0, len(query))
	for _, kv := range query {
		encoded = append(encoded, pair{quoteStrict(kv.k), quoteStrict(kv.v)})
	}
	slices.SortFunc(encoded, func(a, b pair) int {
		if c := cmp.Compare(a.k, b.k); c != 0 {
			return c
		}
		return cmp.Compare(a.v, b.v)
	})
	var sb strings.Builder
	for i, p := range encoded {
		if i > 0 {
			sb.WriteByte('&')
		}
		sb.WriteString(p.k)
		sb.WriteByte('=')
		sb.WriteString(p.v)
	}
	return sb.String()
}

func imSignVOD(accessKey, secretKey, sessionToken, method string, query []imKV, body []byte, service, region string) map[string]string {
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	payloadHash := imSHA256Hex(body)

	signedMap := map[string]string{
		"x-amz-date":           amzDate,
		"x-amz-security-token": sessionToken,
	}
	if method == "POST" {
		signedMap["x-amz-content-sha256"] = payloadHash
	}
	names := slices.Sorted(maps.Keys(signedMap))
	signedHeaders := strings.Join(names, ";")
	var canonicalHeaders strings.Builder
	for _, k := range names {
		canonicalHeaders.WriteString(k)
		canonicalHeaders.WriteByte(':')
		canonicalHeaders.WriteString(signedMap[k])
		canonicalHeaders.WriteByte('\n')
	}

	canonicalRequest := strings.Join([]string{
		method,
		"/",
		imCanonicalQuery(query),
		canonicalHeaders.String(),
		signedHeaders,
		payloadHash,
	}, "\n")

	credentialScope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, region, service)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		imSHA256Hex([]byte(canonicalRequest)),
	}, "\n")

	kDate := imHMAC([]byte("AWS4"+secretKey), []byte(dateStamp))
	kRegion := imHMAC(kDate, []byte(region))
	kService := imHMAC(kRegion, []byte(service))
	kSigning := imHMAC(kService, []byte("aws4_request"))
	signature := hex.EncodeToString(imHMAC(kSigning, []byte(stringToSign)))

	headers := map[string]string{
		"authorization":        fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", accessKey, credentialScope, signedHeaders, signature),
		"x-amz-date":           amzDate,
		"x-amz-security-token": sessionToken,
	}
	if method == "POST" {
		headers["x-amz-content-sha256"] = payloadHash
	}
	return headers
}

func imGatewayHeaders(signed map[string]string, contentType string) Headers {
	prof := GetProfile()
	h := Headers{}
	h.Set("accept", "*/*")
	h.Set("accept-language", prof.AcceptLanguage)
	h.Set("origin", imOrigin)
	h.Set("referer", imOrigin+"/")
	h.Set("user-agent", prof.UA)
	h.Set("sec-fetch-dest", "empty")
	h.Set("sec-fetch-mode", "cors")
	h.Set("sec-fetch-site", "cross-site")
	for _, k := range []string{"authorization", "x-amz-date", "x-amz-security-token", "x-amz-content-sha256"} {
		if v, ok := signed[k]; ok {
			h.Set(k, v)
		}
	}
	if contentType != "" {
		h.Set("content-type", contentType)
	}
	return h
}

func imTOSHeaders(node imUploadNode, userID, crc string) Headers {
	prof := GetProfile()
	h := Headers{}
	h.Set("authorization", node.Auth)
	h.Set("referer", imOrigin+"/")
	h.Set("user-agent", prof.UA)
	h.Set("x-storage-u", url.QueryEscape(userID))
	h.Set("content-type", "application/octet-stream")
	h.Set("accept", "*/*")
	h.Set("accept-language", prof.AcceptLanguage)
	h.Set("origin", imOrigin)
	h.Set("sec-fetch-dest", "empty")
	h.Set("sec-fetch-mode", "cors")
	h.Set("sec-fetch-site", "cross-site")
	if crc != "" {
		h.Set("content-crc32", crc)
	}
	for k, v := range node.UploadHeader {
		h.Set(k, v)
	}
	return h
}

func imEncodeKV(query []imKV) string {
	parts := make([]string, 0, len(query))
	for _, kv := range query {
		parts = append(parts, url.QueryEscape(kv.k)+"="+url.QueryEscape(kv.v))
	}
	return strings.Join(parts, "&")
}

// ---------------------------------------------------------------------------
// upload config
// ---------------------------------------------------------------------------

func (c *Client) imGetUploadConfig(ctx context.Context, force bool) (map[string]any, error) {
	if !force {
		if cached, ok := imUploadConfigCache.Load(c); ok {
			if e, ok := cached.(imUploadConfigEntry); ok && e.config != nil {
				if e.expireMax != 0 {
					now := time.Now().Unix()
					if e.expireMax > 100_000_000_000 {
						now = time.Now().UnixMilli()
					}
					if e.expireMax-now > 30 {
						return e.config, nil
					}
				}
			}
		}
	}

	headers := BuildHeaders(HeaderGET)
	headers.SetReferer(imReferer)
	if err := headers.WithBD(ctx, c, imUploadConfigPath, 6383, douyinBase, false); err != nil {
		return nil, err
	}
	p := NewParams()
	p.WithPlatform("0", "170400", "17.4.0")
	p.WithWebID(ctx, c, imReferer)
	p.WithUIFID(c)
	p.WithVerifyFP(c)
	p.Add("msToken", c.MsToken())
	p.WithABogus(c, nil)

	resp, err := c.HTTP.Get(ctx, BuildURL(imOrigin+imUploadConfigPath, standardEncodeQuery(p)), headers, c.CookieStr())
	if err != nil {
		return nil, err
	}
	c.absorbCookies(resp)
	if err := CheckRisk(resp); err != nil {
		return nil, err
	}
	payload, err := decodeJSONObject(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("IM 上传配置返回不可解析响应: %w", err)
	}
	if code, ok := payload["status_code"]; ok && toInt64(code) != 0 {
		return nil, fmt.Errorf("获取 IM 上传配置失败: %v", payload)
	}
	required := []string{"public_image_config", "inner_image_config", "public_file_config"}
	for _, name := range required {
		if !imTruthy(payload[name]) {
			return nil, fmt.Errorf("获取 IM 上传配置字段缺失: %v", imMapKeys(payload))
		}
	}
	config := map[string]any{}
	maps.Copy(config, payload)
	expireMax := int64(0)
	for _, name := range slices.Concat(required, []string{"public_image_config_v2"}) {
		raw, ok := config[name].(map[string]any)
		if !ok {
			continue
		}
		sts, err := imNormalizeSTS(raw)
		if err != nil {
			return nil, err
		}
		config[name] = map[string]any{
			"AccessKeyID":     sts.AccessKeyID,
			"SecretAccessKey": sts.SecretAccessKey,
			"SessionToken":    sts.SessionToken,
			"space_name":      sts.SpaceName,
			"expire_at":       sts.ExpireAt,
		}
		expireMax = max(expireMax, sts.ExpireAt)
	}
	imUploadConfigCache.Store(c, imUploadConfigEntry{config: config, expireMax: expireMax})
	return config, nil
}

// ---------------------------------------------------------------------------
// upload primitives
// ---------------------------------------------------------------------------

func (c *Client) imApplyUpload(ctx context.Context, sts imSTS, fileType string, size int64, userID string, gcm bool) (imUploadNode, error) {
	query := []imKV{
		{"Action", "ApplyUploadInner"},
		{"Version", imVODAPIVersion},
		{"SpaceName", sts.SpaceName},
		{"FileType", fileType},
		{"IsInner", "1"},
		{"NeedFallback", "true"},
		{"FileSize", strconv.FormatInt(size, 10)},
	}
	if gcm {
		query = append(query, imKV{"OpenGcmEnc", "true"})
	}
	signed := imSignVOD(sts.AccessKeyID, sts.SecretAccessKey, sts.SessionToken, "GET", query, nil, imVODService, imRegion)
	resp, err := c.HTTP.Get(ctx, "https://"+imVODHost+"/?"+imEncodeKV(query), imGatewayHeaders(signed, ""), "")
	if err != nil {
		return imUploadNode{}, err
	}
	payload, err := decodeJSONObject(resp.Body)
	if err != nil {
		return imUploadNode{}, fmt.Errorf("ApplyUploadInner 返回非 JSON: %w", err)
	}
	result, _ := payload["Result"].(map[string]any)
	inner, _ := result["InnerUploadAddress"].(map[string]any)
	nodes, _ := inner["UploadNodes"].([]any)
	if len(nodes) == 0 {
		return imUploadNode{}, fmt.Errorf("ApplyUploadInner(%s) 失败: %v", fileType, payload)
	}
	nodeMap, _ := nodes[0].(map[string]any)
	stores, _ := nodeMap["StoreInfos"].([]any)
	if len(stores) == 0 {
		return imUploadNode{}, fmt.Errorf("ApplyUploadInner(%s) 缺少 StoreInfos", fileType)
	}
	store, _ := stores[0].(map[string]any)
	node := imUploadNode{
		StoreURI:     imStr(store["StoreUri"]),
		Auth:         imStr(store["Auth"]),
		UploadID:     imStr(store["UploadID"]),
		UploadHost:   imStr(nodeMap["UploadHost"]),
		SessionKey:   imStr(nodeMap["SessionKey"]),
		UploadHeader: map[string]string{},
	}
	if uh, ok := nodeMap["UploadHeader"].(map[string]any); ok {
		for k, v := range uh {
			node.UploadHeader[k] = imStr(v)
		}
	}
	return node, nil
}

func (c *Client) imTOSPost(ctx context.Context, rawURL string, headers Headers, data []byte) (map[string]any, error) {
	resp, err := c.HTTP.Do(ctx, "POST", rawURL, headers, "", data)
	if err != nil {
		return nil, err
	}
	payload, err := decodeJSONObject(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("IM TOS 返回非 JSON（HTTP %d）", resp.StatusCode)
	}
	if code, ok := payload["code"]; ok && code != nil && imStr(code) != "2000" {
		return nil, fmt.Errorf("IM TOS 上传失败: %v", payload)
	}
	return payload, nil
}

func (c *Client) imUploadSource(ctx context.Context, node imUploadNode, src *imMediaSource, userID string) error {
	base := fmt.Sprintf("https://%s/upload/v1/%s", node.UploadHost, node.StoreURI)
	if src.size <= imDirectUploadMax {
		data, err := src.read(0, int(src.size))
		if err != nil {
			return err
		}
		_, err = c.imTOSPost(ctx, base, imTOSHeaders(node, userID, imCRC32Hex(data)), data)
		return err
	}

	uploadID := node.UploadID
	if uploadID == "" {
		init, err := c.imTOSPost(ctx, base+"?uploadmode=part&phase=init", imTOSHeaders(node, userID, ""), nil)
		if err != nil {
			return err
		}
		data, _ := init["data"].(map[string]any)
		uploadID = imStr(data["uploadid"])
		if uploadID == "" {
			return fmt.Errorf("IM 分片初始化失败: %v", init)
		}
	}
	partSize := imSliceSizeFor(src.size)
	if partSize < 5*imMB {
		partSize = 5 * imMB
	}
	var crcList []string
	var offset int64
	partNo := 1
	for offset < src.size {
		n := int(partSize)
		if int64(n) > src.size-offset {
			n = int(src.size - offset)
		}
		chunk, err := src.read(offset, n)
		if err != nil {
			return err
		}
		if len(chunk) == 0 {
			return fmt.Errorf("IM 分片读取到空数据")
		}
		crc := imCRC32Hex(chunk)
		transferURL := fmt.Sprintf("%s?uploadid=%s&part_number=%d&phase=transfer&part_offset=%d",
			base, url.QueryEscape(uploadID), partNo, offset)
		if _, err := c.imTOSPost(ctx, transferURL, imTOSHeaders(node, userID, crc), chunk); err != nil {
			return err
		}
		crcList = append(crcList, crc)
		offset += int64(len(chunk))
		partNo++
	}
	var merge strings.Builder
	for i, crc := range crcList {
		if i > 0 {
			merge.WriteByte(',')
		}
		fmt.Fprintf(&merge, "%d:%s", i+1, crc)
	}
	finishURL := fmt.Sprintf("%s?uploadmode=part&phase=finish&uploadid=%s", base, url.QueryEscape(uploadID))
	_, err := c.imTOSPost(ctx, finishURL, imTOSHeaders(node, userID, ""), []byte(merge.String()))
	return err
}

func (c *Client) imCommitUpload(ctx context.Context, sts imSTS, node imUploadNode, processAction []any, userID string) (map[string]any, error) {
	if processAction == nil {
		processAction = []any{}
	}
	bodyObj := struct {
		SessionKey string `json:"SessionKey"`
		Functions  []any  `json:"Functions"`
	}{SessionKey: node.SessionKey, Functions: processAction}
	body, err := json.Marshal(bodyObj)
	if err != nil {
		return nil, err
	}
	query := []imKV{
		{"Action", "CommitUploadInner"},
		{"Version", imVODAPIVersion},
		{"SpaceName", sts.SpaceName},
	}
	signed := imSignVOD(sts.AccessKeyID, sts.SecretAccessKey, sts.SessionToken, "POST", query, body, imVODService, imRegion)
	resp, err := c.HTTP.Do(ctx, "POST", "https://"+imVODHost+"/?"+imEncodeKV(query),
		imGatewayHeaders(signed, "text/plain;charset=UTF-8"), "", body)
	if err != nil {
		return nil, err
	}
	payload, err := decodeJSONObject(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("CommitUploadInner 返回非 JSON: %w", err)
	}
	item := imResultItem(payload)
	if item == nil {
		return nil, fmt.Errorf("CommitUploadInner 失败: %v", payload)
	}
	return item, nil
}

func imResultItem(payload map[string]any) map[string]any {
	result, _ := payload["Result"].(map[string]any)
	if items, ok := result["Results"].([]any); ok && len(items) > 0 {
		item, _ := items[0].(map[string]any)
		return item
	}
	return result
}

func imEncryption(item map[string]any) map[string]any {
	enc, _ := item["Encryption"].(map[string]any)
	return enc
}

func imPlainURI(item map[string]any) string {
	enc := imEncryption(item)
	if v := imStr(enc["Uri"]); v != "" {
		return v
	}
	if v := imStr(item["Uri"]); v != "" {
		return v
	}
	return imStr(item["uri"])
}

func imImageContent(item map[string]any, data []byte, gif bool) map[string]any {
	enc := imEncryption(item)
	extra, _ := enc["Extra"].(map[string]any)
	uri := imStr(enc["Uri"])
	if uri == "" {
		uri = imStr(item["Uri"])
	}
	md5 := imStr(enc["SourceMd5"])
	if md5 == "" {
		md5 = imStr(item["SourceMd5"])
	}
	secret := imStr(enc["SecretKey"])
	if secret == "" {
		secret = imStr(item["SecretKey"])
	}
	width, height := imImageSize(data)
	width = imAsIntDefault(extra["img_width"], width)
	height = imAsIntDefault(extra["img_height"], height)
	aweType := int64(2702)
	if gif {
		aweType = 2703
	}
	return map[string]any{
		"resource_url": map[string]any{
			"oid":       uri,
			"skey":      secret,
			"data_size": imAsIntDefault(extra["img_size"], int64(len(data))),
			"md5":       md5,
		},
		"cover_height": height,
		"cover_width":  width,
		"check_pics":   []any{},
		"md5":          md5,
		"from_gallery": 1,
		"aweType":      aweType,
	}
}

func (c *Client) imResolveUserID(ctx context.Context) string {
	if uid, err := c.UID(ctx); err == nil {
		return strconv.FormatInt(uid, 10)
	}
	return ""
}

func (c *Client) imUploadImage(ctx context.Context, imagePath string, gif *bool) (map[string]any, error) {
	userID := c.imResolveUserID(ctx)
	src, err := imNewMediaSource(ctx, c, imagePath, "file.bin")
	if err != nil {
		return nil, err
	}
	data, err := src.read(0, int(src.size))
	if err != nil {
		return nil, err
	}
	isGif := false
	if gif != nil {
		isGif = *gif
	} else {
		isGif = strings.HasSuffix(strings.ToLower(src.name), ".gif")
	}
	config, err := c.imGetUploadConfig(ctx, false)
	if err != nil {
		return nil, err
	}
	sts, err := imSTSFromConfig(config, "public_image_config")
	if err != nil {
		return nil, err
	}
	policy := map[string]any{"policy-set": "check,thumb,medium,large"}
	if isGif {
		policy = map[string]any{"policy-set": "still", "still-width": "480", "still-height": "480"}
	}
	action := []any{map[string]any{
		"name":         "Encryption",
		"input":        map[string]any{"Config": map[string]any{"copies": "cipher_v2"}},
		"PolicyParams": policy,
	}}
	node, err := c.imApplyUpload(ctx, sts, "image", int64(len(data)), userID, false)
	if err != nil {
		return nil, err
	}
	if err := c.imUploadSource(ctx, node, &imMediaSource{data: data, size: int64(len(data))}, userID); err != nil {
		return nil, err
	}
	item, err := c.imCommitUpload(ctx, sts, node, action, userID)
	if err != nil {
		return nil, err
	}
	return imImageContent(item, data, isGif), nil
}

func (c *Client) imUploadFile(ctx context.Context, filePath string) (map[string]any, error) {
	userID := c.imResolveUserID(ctx)
	src, err := imNewMediaSource(ctx, c, filePath, "file.bin")
	if err != nil {
		return nil, err
	}
	if src.size > imMaxFileSize {
		return nil, fmt.Errorf("抖音 PC IM 文件附件不能超过 10MB")
	}
	data, err := src.read(0, int(src.size))
	if err != nil {
		return nil, err
	}
	config, err := c.imGetUploadConfig(ctx, false)
	if err != nil {
		return nil, err
	}
	sts, err := imSTSFromConfig(config, "public_file_config")
	if err != nil {
		return nil, err
	}
	node, err := c.imApplyUpload(ctx, sts, "object", int64(len(data)), userID, true)
	if err != nil {
		return nil, err
	}
	if err := c.imUploadSource(ctx, node, &imMediaSource{data: data, size: int64(len(data))}, userID); err != nil {
		return nil, err
	}
	item, err := c.imCommitUpload(ctx, sts, node, nil, userID)
	if err != nil {
		return nil, err
	}
	enc := imEncryption(item)
	name := src.name
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	md5 := imStr(enc["SourceMd5"])
	if md5 == "" {
		md5 = imStr(item["SourceMd5"])
	}
	secret := imStr(enc["SecretKey"])
	if secret == "" {
		secret = imStr(item["SecretKey"])
	}
	return map[string]any{
		"aweType":   15001,
		"name":      name,
		"data_size": len(data),
		"md5":       md5,
		"skey":      secret,
		"uri":       imPlainURI(item),
		"format":    ext,
	}, nil
}

func (c *Client) imUploadVideo(ctx context.Context, videoPath, thumbPath string) (map[string]any, error) {
	userID := c.imResolveUserID(ctx)
	videoSrc, err := imNewMediaSource(ctx, c, videoPath, "video.mp4")
	if err != nil {
		return nil, err
	}
	if thumbPath == "" {
		return nil, fmt.Errorf("视频私信需要 thumb/封面图，且自动抽帧不可用")
	}
	thumbSrc, err := imNewMediaSource(ctx, c, thumbPath, "cover.jpg")
	if err != nil {
		return nil, err
	}
	coverData, err := thumbSrc.read(0, int(thumbSrc.size))
	if err != nil {
		return nil, err
	}
	config, err := c.imGetUploadConfig(ctx, false)
	if err != nil {
		return nil, err
	}
	publicSts, err := imSTSFromConfig(config, "public_image_config")
	if err != nil {
		return nil, err
	}
	// PC IM's getCheckPicUploader uses inner_image_config.space_name but signs
	// it with the STS fields from public_image_config; keep that byte-for-byte.
	innerCfg, err := imSTSFromConfig(config, "inner_image_config")
	if err != nil {
		return nil, err
	}
	innerSts := publicSts
	innerSts.SpaceName = innerCfg.SpaceName

	coverNode, err := c.imApplyUpload(ctx, innerSts, "image", int64(len(coverData)), userID, false)
	if err != nil {
		return nil, err
	}
	if err := c.imUploadSource(ctx, coverNode, &imMediaSource{data: coverData, size: int64(len(coverData))}, userID); err != nil {
		return nil, err
	}
	coverItem, err := c.imCommitUpload(ctx, innerSts, coverNode, nil, userID)
	if err != nil {
		return nil, err
	}
	coverURI := imPlainURI(coverItem)

	action := []any{map[string]any{
		"name": "Encryption",
		"input": map[string]any{"Config": map[string]any{
			"copies":         "cipher_v2",
			"aes_chunk_size": "524288",
		}},
		"PolicyParams": map[string]any{"policy-set": "medium"},
	}}
	videoNode, err := c.imApplyUpload(ctx, publicSts, "video", videoSrc.size, userID, false)
	if err != nil {
		return nil, err
	}
	if err := c.imUploadSource(ctx, videoNode, videoSrc, userID); err != nil {
		return nil, err
	}
	item, err := c.imCommitUpload(ctx, publicSts, videoNode, action, userID)
	if err != nil {
		return nil, err
	}
	enc := imEncryption(item)
	extra, _ := enc["Extra"].(map[string]any)
	meta, _ := item["VideoMeta"].(map[string]any)
	if meta == nil {
		meta, _ = item["SourceInfo"].(map[string]any)
	}
	checkPics := []any{}
	if coverURI != "" {
		checkPics = append(checkPics, coverURI)
	}
	return map[string]any{
		"video": map[string]any{
			"tkey": imStr(enc["Uri"]),
			"md5":  imStr(enc["SourceMd5"]),
			"skey": imStr(enc["SecretKey"]),
		},
		"poster": map[string]any{
			"oid":  imFallbackStr(extra["thumb_uri"], coverURI),
			"md5":  imStr(extra["thumb_md5"]),
			"skey": imStr(extra["thumb_secret"]),
		},
		"height":     imAsIntDefault(meta["Height"], 0),
		"width":      imAsIntDefault(meta["Width"], 0),
		"check_pics": checkPics,
	}, nil
}

// ---------------------------------------------------------------------------
// share card builders
// ---------------------------------------------------------------------------

func imFallbackStr(v any, def string) string {
	if s := imStr(v); s != "" {
		return s
	}
	return def
}

func imItemIDFromValue(value string) string {
	v := strings.TrimSpace(value)
	if v == "" {
		return ""
	}
	if _, err := strconv.ParseUint(v, 10, 64); err == nil {
		return v
	}
	if m := regexpAwemePath.FindStringSubmatch(v); m != nil {
		return m[1]
	}
	if m := regexpModalID.FindStringSubmatch(v); m != nil {
		return m[1]
	}
	return ""
}

func imURLObject(value any, width, height int64, dataSize *int64) map[string]any {
	switch t := value.(type) {
	case map[string]any:
		obj := map[string]any{}
		for k, v := range t {
			obj[k] = v
		}
		var urls []any
		switch u := obj["url_list"].(type) {
		case []any:
			urls = u
		case string:
			urls = []any{u}
		}
		if urls == nil {
			switch u := obj["urlList"].(type) {
			case []any:
				urls = u
			case string:
				urls = []any{u}
			}
		}
		if urls == nil {
			switch u := obj["urls"].(type) {
			case []any:
				urls = u
			case string:
				urls = []any{u}
			}
		}
		uri := imStr(obj["uri"])
		if uri == "" {
			uri = imStr(obj["url"])
		}
		if uri == "" && len(urls) > 0 {
			uri = imStr(urls[0])
		}
		obj["uri"] = uri
		if len(urls) == 0 && uri != "" {
			urls = []any{uri}
		}
		if urls == nil {
			urls = []any{}
		}
		obj["url_list"] = urls
		if width > 0 && !imTruthy(obj["width"]) {
			obj["width"] = width
		}
		if height > 0 && !imTruthy(obj["height"]) {
			obj["height"] = height
		}
		if dataSize != nil {
			if _, ok := obj["data_size"]; !ok {
				obj["data_size"] = *dataSize
			}
		}
		return obj
	case []any:
		if len(t) > 0 {
			value = t[0]
		} else {
			value = ""
		}
	}
	uri := ""
	if value != nil {
		uri = imStr(value)
	}
	urls := []any{}
	if uri != "" {
		urls = []any{uri}
	}
	obj := map[string]any{"uri": uri, "url_list": urls}
	if width > 0 {
		obj["width"] = width
	}
	if height > 0 {
		obj["height"] = height
	}
	if dataSize != nil {
		obj["data_size"] = *dataSize
	}
	return obj
}

func imMapGetFirst(detail map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := detail[k]; ok && v != nil {
			return v
		}
	}
	return nil
}

func imAuthorValues(detail map[string]any) (uid, secUID, name string) {
	author, _ := imMapGetFirst(detail, "author", "user").(map[string]any)
	if author == nil {
		author = map[string]any{}
	}
	uid = imStr(imMapGetFirst(author, "uid", "user_id"))
	if uid == "" {
		uid = imStr(imMapGetFirst(detail, "uid", "profile_uid"))
	}
	secUID = imStr(imMapGetFirst(author, "sec_uid", "sec_user_id"))
	if secUID == "" {
		secUID = imStr(imMapGetFirst(detail, "secUID", "sec_uid"))
	}
	name = imStr(imMapGetFirst(author, "nickname", "name"))
	if name == "" {
		name = imStr(detail["content_name"])
	}
	return uid, secUID, name
}

func imDetailCover(detail map[string]any, photos bool) (map[string]any, int64, int64) {
	video, _ := detail["video"].(map[string]any)
	if video == nil {
		video = map[string]any{}
	}
	var value any
	var width, height int64
	if photos {
		images, _ := imMapGetFirst(detail, "images", "image_list", "image_infos").([]any)
		var first map[string]any
		if len(images) > 0 {
			first, _ = images[0].(map[string]any)
		}
		if first == nil {
			if len(images) > 0 {
				first = map[string]any{"url_list": images[0]}
			} else {
				first = map[string]any{}
			}
		}
		value = imMapGetFirst(first, "display_image", "cover")
		if value == nil {
			value = first
		}
		width = imAsIntDefault(imMapGetFirst(first, "width"), 0)
		if width == 0 {
			width = imAsIntDefault(imMapGetFirst(detail, "cover_width"), 0)
		}
		height = imAsIntDefault(imMapGetFirst(first, "height"), 0)
		if height == 0 {
			height = imAsIntDefault(imMapGetFirst(detail, "cover_height"), 0)
		}
	} else {
		cover, _ := imMapGetFirst(video, "cover", "origin_cover").(map[string]any)
		if cover != nil {
			value = cover
		}
		if value == nil {
			value = imMapGetFirst(detail, "cover_url", "cover")
		}
		width = imAsIntDefault(video["width"], 0)
		if width == 0 && cover != nil {
			width = imAsIntDefault(cover["width"], 0)
		}
		if width == 0 {
			width = imAsIntDefault(imMapGetFirst(detail, "cover_width"), 0)
		}
		height = imAsIntDefault(video["height"], 0)
		if height == 0 && cover != nil {
			height = imAsIntDefault(cover["height"], 0)
		}
		if height == 0 {
			height = imAsIntDefault(imMapGetFirst(detail, "cover_height"), 0)
		}
	}
	if width == 0 {
		if m, ok := value.(map[string]any); ok {
			width = imAsIntDefault(m["width"], 0)
		}
	}
	if height == 0 {
		if m, ok := value.(map[string]any); ok {
			height = imAsIntDefault(m["height"], 0)
		}
	}
	return imURLObject(value, width, height, nil), width, height
}

func imBool(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case nil:
		return false
	case float64:
		return t != 0
	default:
		return imTruthy(v)
	}
}

func imAIExt(detail map[string]any) string {
	v := detail["ai_ext"]
	if v == nil {
		return "{}"
	}
	switch t := v.(type) {
	case map[string]any, []any:
		b, err := json.Marshal(t)
		if err != nil {
			return "{}"
		}
		return string(b)
	default:
		return imStr(v)
	}
}

func imShareID(uid, itemID string, timestamp *int64) string {
	if uid == "" || itemID == "" {
		return ""
	}
	ts := time.Now().UnixMilli()
	if timestamp != nil {
		ts = *timestamp
	}
	return fmt.Sprintf("%s_%d_%s", uid, ts, itemID)
}

func imDetailString(detail map[string]any, keys ...string) string {
	for _, k := range keys {
		if imTruthy(detail[k]) {
			return imStr(detail[k])
		}
	}
	return ""
}

func imBuildShareAwemeCard(itemID, uid string, detail map[string]any) map[string]any {
	if detail == nil {
		detail = map[string]any{}
	}
	authorUID, authorSec, authorName := imAuthorValues(detail)
	if uid == "" {
		uid = authorUID
	}
	secUID := authorSec
	name := authorName
	title := imDetailString(detail, "desc", "title", "content_title")
	cover, width, height := imDetailCover(detail, false)
	shareID := imShareID(uid, itemID, nil)
	payload := map[string]any{
		"aweType":              800,
		"awemeType":            0,
		"content_name":         name,
		"content_title":        title,
		"content_thumb":        cover,
		"cover_height":         height,
		"cover_url":            cover,
		"cover_width":          width,
		"itemId":               itemID,
		"secUID":               secUID,
		"uid":                  uid,
		"share_id":             shareID,
		"share_with_timestamp": 0,
		"is_aigc":              imBool(detail["is_aigc"]),
		"is_hot_spot_video":    imBool(detail["is_hot_spot_video"]),
		"is_live_photo":        imAsIntDefault(detail["is_live_photo"], 0),
		"is_slides":            imBool(detail["is_slides"]),
		"is_story":             imBool(detail["is_story"]),
		"is_text":              imAsIntDefault(detail["is_text"], 0),
		"create_id":            imStr(detail["create_id"]),
		"share_info":           imOrEmptyList(detail["share_info"]),
		"anchor_info":          imOrEmptyMap(detail["anchor_info"]),
		"poi_track_params":     imOrEmptyMap(detail["poi_track_params"]),
		"ai_ext":               imAIExt(detail),
	}
	imCopyDetailExtras(payload, detail)
	return payload
}

func imBuildSharePhotosCard(itemID, uid string, detail map[string]any) map[string]any {
	if detail == nil {
		detail = map[string]any{}
	}
	authorUID, authorSec, authorName := imAuthorValues(detail)
	if uid == "" {
		uid = authorUID
	}
	secUID := authorSec
	name := authorName
	title := imDetailString(detail, "desc", "title", "content_title")
	cover, width, height := imDetailCover(detail, true)
	images, _ := imMapGetFirst(detail, "images", "image_list", "image_infos").([]any)
	imageCount := imAsIntDefault(detail["image_count"], int64(len(images)))
	if imageCount == 0 {
		imageCount = 1
	}
	shareID := imShareID(uid, itemID, nil)
	payload := map[string]any{
		"aweType":              0,
		"awemeType":            68,
		"content_name":         name,
		"content_title":        title,
		"content_thumb":        cover,
		"cover_height":         height,
		"cover_url":            cover,
		"cover_url_v2":         cover,
		"cover_width":          width,
		"image_count":          imageCount,
		"image_index":          0,
		"itemId":               itemID,
		"secUID":               secUID,
		"uid":                  uid,
		"share_id":             shareID,
		"share_with_timestamp": 0,
		"is_aigc":              imBool(detail["is_aigc"]),
		"is_hot_spot_video":    imBool(detail["is_hot_spot_video"]),
		"is_live_photo":        imAsIntDefault(detail["is_live_photo"], 0),
		"is_slides":            imBool(detail["is_slides"]),
		"is_story":             imBool(detail["is_story"]),
		"is_text":              imAsIntDefault(detail["is_text"], 0),
		"share_info":           imOrEmptyList(detail["share_info"]),
		"anchor_info":          imOrEmptyMap(detail["anchor_info"]),
		"poi_track_params":     imOrEmptyMap(detail["poi_track_params"]),
		"ai_ext":               imAIExt(detail),
	}
	imCopyDetailExtras(payload, detail)
	return payload
}

func imCopyDetailExtras(payload, detail map[string]any) {
	for _, key := range []string{
		"profile_uid", "profile_sec_uid", "scene_type", "send_source",
		"publish_way", "hot_spot_create_time", "ecom_share_track_params",
	} {
		if v, ok := detail[key]; ok && v != nil {
			payload[key] = v
		}
	}
}

func imOrEmptyList(v any) any {
	if list, ok := v.([]any); ok {
		return list
	}
	return []any{}
}

func imOrEmptyMap(v any) any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func imBuildShareWebCard(content, title, desc, coverURL string) map[string]any {
	target := content
	if target == "" {
		target = ""
	}
	if target != "" {
		parsed, err := url.Parse(target)
		if err == nil {
			query := parsed.Query()
			if query.Get("pc_iframe_src") == "" {
				query.Set("pc_iframe_src", target)
				parsed.RawQuery = query.Encode()
				target = parsed.String()
			}
		}
	}
	payload := map[string]any{}
	payload["link_url"] = target
	payload["cover_url"] = coverURL
	payload["title"] = title
	payload["desc"] = desc
	return payload
}

func imBuildUserCard(uid, secUID, name string, avatar, coverItems any) map[string]any {
	avatarObj := imURLObject(avatar, 0, 0, nil)
	covers := coverItems
	var coverObjs []any
	switch t := covers.(type) {
	case []any:
		for _, v := range t {
			coverObjs = append(coverObjs, imURLObject(v, 0, 0, nil))
		}
	case nil:
	default:
		coverObjs = append(coverObjs, imURLObject(t, 0, 0, nil))
	}
	if coverObjs == nil {
		coverObjs = []any{}
	}
	items := []any{}
	return map[string]any{
		"uid":         uid,
		"secUID":      secUID,
		"name":        name,
		"avatar":      avatarObj,
		"cover_items": items,
		"cover_url":   coverObjs,
	}
}
