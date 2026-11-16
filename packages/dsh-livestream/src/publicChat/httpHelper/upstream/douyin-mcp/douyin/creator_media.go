package douyin

// Media upload for the creator publish flow: Volcengine ImageX (image
// collections) and VOD (video) gateways with AWS4-HMAC-SHA256 signing, plus
// the TOS byte uploads.

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
	_ "image/jpeg"
	_ "image/png"
	"io"
	"maps"
	"math/rand/v2"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
)

const (
	imagexHost    = "imagex.bytedanceapi.com"
	imagexRegion  = "cn-north-1"
	imagexService = "imagex"
	vodHost       = "vod.bytedanceapi.com"
	vodService    = "vod"
	vodSpaceName  = "aweme"
	vodAPIVersion = "2020-11-19"
	awsAlgorithm  = "AWS4-HMAC-SHA256"

	mb = 1024 * 1024
)

// --- STS credentials ---------------------------------------------------------

// GetCreatorUploadAuth fetches an ImageX/VOD STS credential set from
// /web/api/media/upload/auth/v5/. The same credential authorises both the
// ImageX and VOD actions.
func (c *Client) GetCreatorUploadAuth(ctx context.Context, referer string) (map[string]any, error) {
	return c.getCreatorUploadAuth(ctx, referer)
}

func (c *Client) getCreatorUploadAuth(ctx context.Context, referer string) (map[string]any, error) {
	if referer == "" {
		referer = postVideoReferer
	}
	res, err := c.creatorAPIRequest(ctx, fhttp.MethodGet, "/web/api/media/upload/auth/v5/",
		nil, true, true, true, "", "", referer, nil)
	if err != nil {
		return nil, err
	}
	if toInt64(res["status_code"]) != 0 {
		if _, ok := res["auth"]; !ok {
			return nil, fmt.Errorf("获取上传凭证失败: %v", res)
		}
	}
	rawAuth, ok := res["auth"].(string)
	if !ok || rawAuth == "" {
		return nil, fmt.Errorf("获取上传凭证失败: %v", res)
	}
	var sts map[string]any
	if err := json.Unmarshal([]byte(rawAuth), &sts); err != nil {
		return nil, fmt.Errorf("获取上传凭证失败: %w", err)
	}
	for _, key := range []string{"AccessKeyID", "SecretAccessKey", "SessionToken"} {
		if creatorMapStr(sts, key) == "" {
			return nil, fmt.Errorf("获取上传凭证失败: %v", res)
		}
	}
	return sts, nil
}

// --- AWS4-HMAC-SHA256 gateway signing ---------------------------------------

func creatorSHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func creatorHMACSHA256(key []byte, msg string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(msg))
	return mac.Sum(nil)
}

// creatorAWSQuote mirrors urllib.parse.quote(value, safe="-_.~").
func creatorAWSQuote(s string) string {
	const upperhex = "0123456789ABCDEF"
	var sb strings.Builder
	for i := range len(s) {
		ch := s[i]
		if ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' ||
			ch == '-' || ch == '_' || ch == '.' || ch == '~' {
			sb.WriteByte(ch)
			continue
		}
		sb.WriteByte('%')
		sb.WriteByte(upperhex[ch>>4])
		sb.WriteByte(upperhex[ch&15])
	}
	return sb.String()
}

func creatorAWSCanonicalQuery(p *Params) string {
	type pair struct{ k, v string }
	pairs := make([]pair, 0, p.Len())
	for _, key := range p.Keys() {
		val, _ := p.Get(key)
		pairs = append(pairs, pair{creatorAWSQuote(key), creatorAWSQuote(val)})
	}
	slices.SortFunc(pairs, func(a, b pair) int {
		if c := cmp.Compare(a.k, b.k); c != 0 {
			return c
		}
		return cmp.Compare(a.v, b.v)
	})
	parts := make([]string, 0, len(pairs))
	for _, kv := range pairs {
		parts = append(parts, kv.k+"="+kv.v)
	}
	return strings.Join(parts, "&")
}

// creatorSignGateway returns the Volcengine V4 signing headers.
func creatorSignGateway(accessKey, secretKey, sessionToken, method string, query *Params,
	body []byte, service, region string, now time.Time) map[string]string {
	method = strings.ToUpper(method)
	utc := now.UTC()
	amzDate := utc.Format("20060102T150405Z")
	dateStamp := utc.Format("20060102")
	payloadHash := creatorSHA256Hex(body)

	signedMap := map[string]string{
		"x-amz-date":           amzDate,
		"x-amz-security-token": sessionToken,
	}
	if method == "POST" {
		signedMap["x-amz-content-sha256"] = payloadHash
	}
	keys := slices.Sorted(maps.Keys(signedMap))
	signedHeaders := strings.Join(keys, ";")
	var canonicalHeaders strings.Builder
	for _, k := range keys {
		canonicalHeaders.WriteString(k + ":" + signedMap[k] + "\n")
	}

	canonicalRequest := strings.Join([]string{
		method, "/", creatorAWSCanonicalQuery(query), canonicalHeaders.String(), signedHeaders, payloadHash,
	}, "\n")
	credentialScope := dateStamp + "/" + region + "/" + service + "/aws4_request"
	stringToSign := strings.Join([]string{
		awsAlgorithm, amzDate, credentialScope, creatorSHA256Hex([]byte(canonicalRequest)),
	}, "\n")

	kDate := creatorHMACSHA256([]byte("AWS4"+secretKey), dateStamp)
	kRegion := creatorHMACSHA256(kDate, region)
	kService := creatorHMACSHA256(kRegion, service)
	kSigning := creatorHMACSHA256(kService, "aws4_request")
	signature := hex.EncodeToString(creatorHMACSHA256(kSigning, stringToSign))

	authorization := fmt.Sprintf("%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		awsAlgorithm, accessKey, credentialScope, signedHeaders, signature)

	out := map[string]string{
		"authorization":        authorization,
		"x-amz-date":           amzDate,
		"x-amz-security-token": sessionToken,
	}
	if method == "POST" {
		out["x-amz-content-sha256"] = payloadHash
	}
	return out
}

// creatorGatewayHeaders mirrors _gateway_headers (cross-origin ImageX/VOD XHR).
func creatorGatewayHeaders(sign map[string]string, contentType string) Headers {
	prof := GetProfile()
	h := Headers{}
	if v, ok := sign["x-amz-content-sha256"]; ok {
		h.Set("x-amz-content-sha256", v)
	}
	h.Set("x-amz-security-token", sign["x-amz-security-token"])
	h.Set("x-amz-date", sign["x-amz-date"])
	h.Set("referer", creatorOrigin+"/")
	h.Set("authorization", sign["authorization"])
	h.Set("user-agent", prof.UA)
	if contentType != "" {
		h.Set("content-type", contentType)
	}
	h.Set("accept", "*/*")
	h.Set("accept-language", prof.AcceptLanguage)
	h.Set("origin", creatorOrigin)
	h.Set("priority", "u=1, i")
	h.Set("sec-fetch-dest", "empty")
	h.Set("sec-fetch-mode", "cors")
	h.Set("sec-fetch-site", "cross-site")
	return h
}

// --- ImageX image upload -----------------------------------------------------

// UploadImageX uploads a single image (local path or http(s) URL) and returns
// {uri,width,height,format,size}.
func (c *Client) UploadImageX(ctx context.Context, file string) (map[string]any, error) {
	sts, err := c.getCreatorUploadAuth(ctx, postVideoReferer)
	if err != nil {
		return nil, err
	}
	data, err := creatorReadMediaBytes(ctx, c, file)
	if err != nil {
		return nil, err
	}
	return c.uploadOneImage(ctx, sts, data, c.resolveUserID(ctx))
}

func (c *Client) applyImageUpload(ctx context.Context, sts map[string]any, userID, randomS string) (map[string]any, error) {
	if randomS == "" {
		randomS = creatorRandomS()
	}
	q := NewParams()
	q.Add("Action", "ApplyImageUpload")
	q.Add("Version", "2018-08-01")
	q.Add("ServiceId", imagexServiceID)
	q.Add("app_id", imagexAppID)
	q.Add("user_id", userID)
	q.Add("s", randomS)

	sign := creatorSignGateway(creatorMapStr(sts, "AccessKeyID"), creatorMapStr(sts, "SecretAccessKey"),
		creatorMapStr(sts, "SessionToken"), "GET", q, nil, imagexService, imagexRegion, time.Now())
	resp, err := c.HTTP.Get(ctx, BuildURL("https://"+imagexHost+"/", q.ToString()), creatorGatewayHeaders(sign, ""), "")
	if err != nil {
		return nil, err
	}
	res, err := creatorDecode(resp)
	if err != nil {
		return nil, err
	}
	result, _ := res["Result"].(map[string]any)
	if result == nil {
		return nil, fmt.Errorf("ApplyImageUpload 失败: %v", res)
	}
	addr, _ := result["UploadAddress"].(map[string]any)
	stores, _ := addr["StoreInfos"].([]any)
	if len(stores) == 0 {
		return nil, fmt.Errorf("ApplyImageUpload 失败: %v", res)
	}
	store, _ := stores[0].(map[string]any)
	hosts, _ := addr["UploadHosts"].([]any)
	return map[string]any{
		"store_uri":     creatorMapStr(store, "StoreUri"),
		"auth":          creatorMapStr(store, "Auth"),
		"upload_host":   creatorFirstURL(hosts),
		"session_key":   creatorMapStr(addr, "SessionKey"),
		"upload_id":     creatorMapStr(store, "UploadID"),
		"upload_header": creatorMapAny(addr, "UploadHeader"),
	}, nil
}

func (c *Client) uploadImageBytes(ctx context.Context, uploadHost, storeURI, ticket string, data []byte, userID string) (map[string]any, error) {
	prof := GetProfile()
	rawURL := "https://" + uploadHost + "/upload/v1/" + storeURI
	h := Headers{}
	h.Set("authorization", ticket)
	h.Set("referer", creatorOrigin+"/")
	h.Set("user-agent", prof.UA)
	h.Set("x-storage-u", url.PathEscape(userID))
	h.Set("content-crc32", fmt.Sprintf("%08x", crc32.ChecksumIEEE(data)))
	h.Set("content-type", "application/octet-stream")
	h.Set("content-disposition", `attachment; filename="undefined"`)
	h.Set("accept", "*/*")
	h.Set("accept-language", prof.AcceptLanguage)
	h.Set("origin", creatorOrigin)
	h.Set("sec-fetch-dest", "empty")
	h.Set("sec-fetch-mode", "cors")
	h.Set("sec-fetch-site", "cross-site")

	resp, err := c.HTTP.Do(ctx, fhttp.MethodPost, rawURL, h, "", data)
	if err != nil {
		return nil, err
	}
	res, err := creatorDecode(resp)
	if err != nil {
		return nil, err
	}
	if toInt64(res["code"]) != 2000 {
		return nil, fmt.Errorf("图片字节上传失败: %v", res)
	}
	return res, nil
}

func (c *Client) commitImageUpload(ctx context.Context, sts map[string]any, sessionKey, userID string) (map[string]any, error) {
	q := NewParams()
	q.Add("Action", "CommitImageUpload")
	q.Add("Version", "2018-08-01")
	q.Add("ServiceId", imagexServiceID)
	q.Add("app_id", imagexAppID)
	q.Add("user_id", userID)

	body := creatorJSON(map[string]any{"SessionKey": sessionKey})
	sign := creatorSignGateway(creatorMapStr(sts, "AccessKeyID"), creatorMapStr(sts, "SecretAccessKey"),
		creatorMapStr(sts, "SessionToken"), "POST", q, []byte(body), imagexService, imagexRegion, time.Now())
	resp, err := c.HTTP.Do(ctx, fhttp.MethodPost,
		BuildURL("https://"+imagexHost+"/", q.ToString()), creatorGatewayHeaders(sign, "application/json"), "", []byte(body))
	if err != nil {
		return nil, err
	}
	res, err := creatorDecode(resp)
	if err != nil {
		return nil, err
	}
	result, _ := res["Result"].(map[string]any)
	plugins, _ := result["PluginResult"].([]any)
	if len(plugins) == 0 {
		return nil, fmt.Errorf("CommitImageUpload 失败: %v", res)
	}
	info, _ := plugins[0].(map[string]any)
	return map[string]any{
		"uri":    creatorMapStr(info, "ImageUri"),
		"width":  toInt64(info["ImageWidth"]),
		"height": toInt64(info["ImageHeight"]),
		"format": creatorMapStr(info, "ImageFormat"),
		"size":   toInt64(info["ImageSize"]),
	}, nil
}

func (c *Client) uploadOneImage(ctx context.Context, sts map[string]any, data []byte, userID string) (map[string]any, error) {
	node, err := c.applyImageUpload(ctx, sts, userID, "")
	if err != nil {
		return nil, err
	}
	if _, err := c.uploadImageBytes(ctx, creatorMapStr(node, "upload_host"), creatorMapStr(node, "store_uri"),
		creatorMapStr(node, "auth"), data, userID); err != nil {
		return nil, err
	}
	info, err := c.commitImageUpload(ctx, sts, creatorMapStr(node, "session_key"), userID)
	if err != nil {
		return nil, err
	}
	if toInt64(info["width"]) == 0 || toInt64(info["height"]) == 0 {
		w, h := creatorImageDimensions(data)
		info["width"], info["height"] = w, h
	}
	return info, nil
}

// --- VOD video upload --------------------------------------------------------

// UploadVideoX uploads a single video (local path or http(s) URL) and returns
// the VOD commit info {vid,poster_uri,width,height,duration,size,format,md5}.
func (c *Client) UploadVideoX(ctx context.Context, file string) (map[string]any, error) {
	sts, err := c.getCreatorUploadAuth(ctx, postVideoReferer)
	if err != nil {
		return nil, err
	}
	source, err := creatorNewMediaSource(ctx, c, file)
	if err != nil {
		return nil, err
	}
	userID := c.resolveUserID(ctx)
	node, err := c.applyVideoUpload(ctx, sts, source.size, userID)
	if err != nil {
		return nil, err
	}
	return c.uploadVideo(ctx, sts, node, source, userID)
}

func (c *Client) applyVideoUpload(ctx context.Context, sts map[string]any, fileSize int64, userID string) (map[string]any, error) {
	q := NewParams()
	q.Add("Action", "ApplyUploadInner")
	q.Add("Version", vodAPIVersion)
	q.Add("SpaceName", vodSpaceName)
	q.Add("FileType", "video")
	q.Add("IsInner", "1")
	q.Add("FileSize", strconv.FormatInt(fileSize, 10))
	q.Add("app_id", imagexAppID)
	q.Add("user_id", userID)
	q.Add("s", creatorRandomS())

	sign := creatorSignGateway(creatorMapStr(sts, "AccessKeyID"), creatorMapStr(sts, "SecretAccessKey"),
		creatorMapStr(sts, "SessionToken"), "GET", q, nil, vodService, imagexRegion, time.Now())
	resp, err := c.HTTP.Get(ctx, BuildURL("https://"+vodHost+"/", q.ToString()), creatorGatewayHeaders(sign, ""), "")
	if err != nil {
		return nil, err
	}
	res, err := creatorDecode(resp)
	if err != nil {
		return nil, err
	}
	result, _ := res["Result"].(map[string]any)
	inner, _ := result["InnerUploadAddress"].(map[string]any)
	nodes, _ := inner["UploadNodes"].([]any)
	if len(nodes) == 0 {
		return nil, fmt.Errorf("ApplyUploadInner 失败: %v", res)
	}
	node, _ := nodes[0].(map[string]any)
	stores, _ := node["StoreInfos"].([]any)
	if len(stores) == 0 {
		return nil, fmt.Errorf("ApplyUploadInner 失败: %v", res)
	}
	store, _ := stores[0].(map[string]any)
	return map[string]any{
		"store_uri":     creatorMapStr(store, "StoreUri"),
		"auth":          creatorMapStr(store, "Auth"),
		"upload_id":     creatorMapStr(store, "UploadID"),
		"upload_host":   creatorMapStr(node, "UploadHost"),
		"session_key":   creatorMapStr(node, "SessionKey"),
		"upload_header": creatorMapAny(node, "UploadHeader"),
	}, nil
}

func (c *Client) commitVideoUpload(ctx context.Context, sts map[string]any, sessionKey, userID string) (map[string]any, error) {
	q := NewParams()
	q.Add("Action", "CommitUploadInner")
	q.Add("Version", vodAPIVersion)
	q.Add("SpaceName", vodSpaceName)
	q.Add("app_id", imagexAppID)
	q.Add("user_id", userID)

	body := creatorJSON(map[string]any{
		"SessionKey": sessionKey,
		"Functions": []any{
			map[string]any{"name": "GetMeta"},
			map[string]any{"name": "Snapshot", "input": map[string]any{"SnapshotTime": 0}},
		},
	})
	sign := creatorSignGateway(creatorMapStr(sts, "AccessKeyID"), creatorMapStr(sts, "SecretAccessKey"),
		creatorMapStr(sts, "SessionToken"), "POST", q, []byte(body), vodService, imagexRegion, time.Now())
	resp, err := c.HTTP.Do(ctx, fhttp.MethodPost,
		BuildURL("https://"+vodHost+"/", q.ToString()),
		creatorGatewayHeaders(sign, "text/plain;charset=UTF-8"), "", []byte(body))
	if err != nil {
		return nil, err
	}
	res, err := creatorDecode(resp)
	if err != nil {
		return nil, err
	}
	result, _ := res["Result"].(map[string]any)
	items, _ := result["Results"].([]any)
	if len(items) == 0 {
		return nil, fmt.Errorf("CommitUploadInner 失败: %v", res)
	}
	info, _ := items[0].(map[string]any)
	meta, _ := info["SourceInfo"].(map[string]any)
	if meta == nil {
		meta, _ = info["VideoMeta"].(map[string]any)
	}
	return map[string]any{
		"vid":        creatorFirstNonEmpty(creatorMapStr(info, "Vid"), creatorMapStr(meta, "Vid")),
		"poster_uri": creatorMapStr(info, "PosterUri"),
		"width":      toInt64(meta["Width"]),
		"height":     toInt64(meta["Height"]),
		"duration":   creatorToFloat64(meta["Duration"]),
		"size":       toInt64(meta["Size"]),
		"format":     creatorMapStr(meta, "Format"),
		"md5":        creatorMapStr(meta, "Md5"),
		"raw":        info,
	}, nil
}

func (c *Client) tosHeaders(node map[string]any, userID string, crc32Hex string) Headers {
	prof := GetProfile()
	h := Headers{}
	h.Set("authorization", creatorMapStr(node, "auth"))
	h.Set("referer", creatorOrigin+"/")
	h.Set("user-agent", prof.UA)
	h.Set("x-storage-u", url.PathEscape(userID))
	if crc32Hex != "" {
		h.Set("content-crc32", crc32Hex)
	}
	h.Set("content-type", "application/octet-stream")
	h.Set("accept", "*/*")
	h.Set("accept-language", prof.AcceptLanguage)
	h.Set("origin", creatorOrigin)
	h.Set("sec-fetch-dest", "empty")
	h.Set("sec-fetch-mode", "cors")
	h.Set("sec-fetch-site", "cross-site")
	if extra, ok := node["upload_header"].(map[string]any); ok {
		for _, k := range slices.Sorted(maps.Keys(extra)) {
			h.Set(k, creatorMapStr(extra, k))
		}
	}
	return h
}

func (c *Client) tosPost(ctx context.Context, rawURL string, headers Headers, data []byte) (map[string]any, error) {
	resp, err := c.HTTP.Do(ctx, fhttp.MethodPost, rawURL, headers, "", data)
	if err != nil {
		return nil, err
	}
	res, err := creatorDecode(resp)
	if err != nil {
		return nil, fmt.Errorf("TOS 返回异常（HTTP %d）: %w", resp.StatusCode, err)
	}
	if toInt64(res["code"]) != 2000 {
		return nil, fmt.Errorf("TOS 请求失败: %v", res)
	}
	return res, nil
}

func (c *Client) uploadVideoDirect(ctx context.Context, node map[string]any, source *creatorMediaSource, userID string) (map[string]any, error) {
	data, err := source.read(0, source.size)
	if err != nil {
		return nil, err
	}
	rawURL := "https://" + creatorMapStr(node, "upload_host") + "/upload/v1/" + creatorMapStr(node, "store_uri")
	return c.tosPost(ctx, rawURL, c.tosHeaders(node, userID, fmt.Sprintf("%08x", crc32.ChecksumIEEE(data))), data)
}

func (c *Client) uploadVideoParts(ctx context.Context, node map[string]any, source *creatorMediaSource, userID string, partSize int64) (map[string]any, error) {
	base := "https://" + creatorMapStr(node, "upload_host") + "/upload/v1/" + creatorMapStr(node, "store_uri")
	headers := c.tosHeaders(node, userID, "")

	uploadID := creatorMapStr(node, "upload_id")
	if uploadID == "" {
		init, err := c.tosPost(ctx, base+"?uploadmode=part&phase=init", headers, nil)
		if err != nil {
			return nil, err
		}
		data, _ := init["data"].(map[string]any)
		uploadID = creatorMapStr(data, "uploadid")
		if uploadID == "" {
			return nil, fmt.Errorf("初始化分片上传失败: %v", init)
		}
	}

	crcList := []string{}
	var offset int64
	index := 0
	for offset < source.size {
		chunk, err := source.read(offset, partSize)
		if err != nil {
			return nil, err
		}
		crc := fmt.Sprintf("%08x", crc32.ChecksumIEEE(chunk))
		partURL := fmt.Sprintf("%s?uploadid=%s&part_number=%d&phase=transfer&part_offset=%d",
			base, uploadID, index+1, offset)
		if _, err := c.tosPost(ctx, partURL, c.tosHeaders(node, userID, crc), chunk); err != nil {
			return nil, err
		}
		crcList = append(crcList, crc)
		offset += int64(len(chunk))
		index++
	}
	mergeParts := make([]string, 0, len(crcList))
	for i, crc := range crcList {
		mergeParts = append(mergeParts, fmt.Sprintf("%d:%s", i+1, crc))
	}
	finishURL := fmt.Sprintf("%s?uploadmode=part&phase=finish&uploadid=%s", base, uploadID)
	return c.tosPost(ctx, finishURL, headers, []byte(strings.Join(mergeParts, ",")))
}

// uploadVideo uploads the applied node's bytes then commits with a freshly
// fetched STS (the initial Apply credential is not reused for Commit).
func (c *Client) uploadVideo(ctx context.Context, sts map[string]any, node map[string]any, source *creatorMediaSource, userID string) (map[string]any, error) {
	sliceSize := creatorVideoSliceSize(source.size)
	if source.size <= sliceSize {
		if _, err := c.uploadVideoDirect(ctx, node, source, userID); err != nil {
			return nil, err
		}
	} else {
		partSize := sliceSize
		if partSize < 5*mb {
			partSize = 5 * mb
		}
		if _, err := c.uploadVideoParts(ctx, node, source, userID, partSize); err != nil {
			return nil, err
		}
	}

	commitSTS, err := c.getCreatorUploadAuth(ctx, postVideoReferer)
	if err != nil {
		return nil, err
	}
	info, err := c.commitVideoUpload(ctx, commitSTS, creatorMapStr(node, "session_key"), userID)
	if err != nil {
		return nil, err
	}
	if creatorMapStr(info, "vid") == "" {
		return nil, fmt.Errorf("提交后未拿到 vid: %v", info["raw"])
	}
	info["commit_sts"] = commitSTS
	return info, nil
}

func creatorVideoSliceSize(size int64) int64 {
	switch {
	case size >= 500*mb:
		return 10 * mb
	case size >= 100*mb:
		return 5 * mb
	default:
		return 3 * mb
	}
}

// --- media sources -----------------------------------------------------------

// creatorMediaSource unifies a local path, raw bytes or an http(s) URL, supporting
// ranged reads for local files (large videos never fully loaded into memory).
type creatorMediaSource struct {
	path string
	data []byte
	size int64
}

func creatorNewMediaSource(ctx context.Context, c *Client, src string) (*creatorMediaSource, error) {
	if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
		data, err := creatorReadMediaBytes(ctx, c, src)
		if err != nil {
			return nil, err
		}
		return &creatorMediaSource{data: data, size: int64(len(data))}, nil
	}
	info, err := os.Stat(src)
	if err != nil {
		return nil, err
	}
	return &creatorMediaSource{path: src, size: info.Size()}, nil
}

func (m *creatorMediaSource) read(start, length int64) ([]byte, error) {
	if length <= 0 {
		length = m.size - start
	}
	if m.data != nil {
		if start >= int64(len(m.data)) {
			return nil, nil
		}
		end := start + length
		if end > int64(len(m.data)) {
			end = int64(len(m.data))
		}
		return m.data[start:end], nil
	}
	f, err := os.Open(m.path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Seek(start, 0); err != nil {
		return nil, err
	}
	buf := make([]byte, length)
	n, err := f.Read(buf)
	if err != nil && err != io.EOF {
		return nil, err
	}
	return buf[:n], nil
}

func (m *creatorMediaSource) name() string {
	if m.path != "" {
		return filepathBase(m.path)
	}
	return "video.mp4"
}

// creatorReadMediaBytes accepts a local path or an http(s) URL.
func creatorReadMediaBytes(ctx context.Context, c *Client, src string) ([]byte, error) {
	if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
		resp, err := c.HTTP.Get(ctx, src, Headers{}, "")
		if err != nil {
			return nil, err
		}
		if resp.StatusCode >= 400 {
			return nil, fmt.Errorf("下载媒体失败: HTTP %d", resp.StatusCode)
		}
		return resp.Body, nil
	}
	return os.ReadFile(src)
}

// --- misc helpers ------------------------------------------------------------

// creatorRandomS mirrors the base36 fallback for
// Math.random().toString(36).substr(2) (Node unavailable in-process).
func creatorRandomS() string {
	value := rand.Uint64() & ((1 << 53) - 1)
	if value == 0 {
		return "0"
	}
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	out := make([]byte, 0, 12)
	for value > 0 {
		out = append(out, alphabet[value%36])
		value /= 36
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

func creatorImageDimensions(data []byte) (int64, int64) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0
	}
	return int64(cfg.Width), int64(cfg.Height)
}

func creatorMapAny(m map[string]any, key string) map[string]any {
	if m == nil {
		return nil
	}
	if v, ok := m[key].(map[string]any); ok {
		return v
	}
	return nil
}

func creatorToFloat64(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case float32:
		return float64(t)
	case int64:
		return float64(t)
	case int:
		return float64(t)
	case string:
		f, _ := strconv.ParseFloat(t, 64)
		return f
	}
	return 0
}

func filepathBase(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' || p[i] == '\\' {
			return p[i+1:]
		}
	}
	return p
}
