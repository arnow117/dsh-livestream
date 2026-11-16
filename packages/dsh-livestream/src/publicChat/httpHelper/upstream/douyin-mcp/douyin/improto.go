package douyin

// Generic protobuf wire-format helpers for the PC-IM protocol.
//
// The IM endpoints use a Request/Response envelope whose per-cmd bodies are
// only partially described upstream. Rather than carrying a .proto for every
// cmd, requests are written field-by-field and responses are decoded into
// field-number keyed maps, which also keeps 64-bit ids exact.

import (
	"encoding/binary"
	"errors"
	"math"
	"math/rand/v2"
	"strconv"
	"strings"
)

// --- writer ----------------------------------------------------------------

type pbw struct{ b []byte }

func (w *pbw) varint(v uint64) {
	for v >= 0x80 {
		w.b = append(w.b, byte(v)|0x80)
		v >>= 7
	}
	w.b = append(w.b, byte(v))
}

func (w *pbw) tag(field int, wire int) { w.varint(uint64(field)<<3 | uint64(wire)) }

func (w *pbw) Int(field int, v int64) {
	if v == 0 {
		return
	}
	w.tag(field, 0)
	w.varint(uint64(v))
}

// IntAlways writes a varint even when zero (some IM fields are significant at 0).
func (w *pbw) IntAlways(field int, v int64) {
	w.tag(field, 0)
	w.varint(uint64(v))
}

func (w *pbw) Str(field int, s string) {
	if s == "" {
		return
	}
	w.Bytes(field, []byte(s))
}

func (w *pbw) Bytes(field int, data []byte) {
	if len(data) == 0 {
		return
	}
	w.tag(field, 2)
	w.varint(uint64(len(data)))
	w.b = append(w.b, data...)
}

func (w *pbw) Msg(field int, inner *pbw) { w.Bytes(field, inner.b) }

// --- reader ----------------------------------------------------------------

// pbParse decodes a protobuf message into field number -> value. Varints
// become int64, length-delimited fields become []byte, fixed32/64 become
// uint32/uint64. Repeated fields become []any.
func pbParse(data []byte) (map[int]any, error) {
	out := map[int]any{}
	i := 0
	for i < len(data) {
		tag, n := binary.Uvarint(data[i:])
		if n <= 0 {
			return nil, errors.New("pb: bad tag")
		}
		i += n
		field := int(tag >> 3)
		wire := int(tag & 7)
		var val any
		switch wire {
		case 0:
			v, n := binary.Uvarint(data[i:])
			if n <= 0 {
				return nil, errors.New("pb: bad varint")
			}
			i += n
			val = int64(v)
		case 1:
			if i+8 > len(data) {
				return nil, errors.New("pb: short fixed64")
			}
			val = binary.LittleEndian.Uint64(data[i:])
			i += 8
		case 2:
			l, n := binary.Uvarint(data[i:])
			if n <= 0 || i+n+int(l) > len(data) {
				return nil, errors.New("pb: bad length")
			}
			i += n
			val = data[i : i+int(l)]
			i += int(l)
		case 5:
			if i+4 > len(data) {
				return nil, errors.New("pb: short fixed32")
			}
			val = binary.LittleEndian.Uint32(data[i:])
			i += 4
		default:
			return nil, errors.New("pb: unsupported wire type")
		}
		if prev, ok := out[field]; ok {
			if list, ok := prev.([]any); ok {
				out[field] = append(list, val)
			} else {
				out[field] = []any{prev, val}
			}
		} else {
			out[field] = val
		}
	}
	return out, nil
}

// pbMsg decodes a nested message field when it parses cleanly.
func pbMsg(m map[int]any, field int) (map[int]any, bool) {
	b, ok := m[field].([]byte)
	if !ok {
		return nil, false
	}
	inner, err := pbParse(b)
	if err != nil {
		return nil, false
	}
	return inner, true
}

func pbString(m map[int]any, field int) string {
	switch v := m[field].(type) {
	case []byte:
		return string(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case string:
		return v
	}
	return ""
}

func pbInt(m map[int]any, field int) int64 {
	switch v := m[field].(type) {
	case int64:
		return v
	case uint32:
		return int64(v)
	case uint64:
		return int64(v)
	case []byte:
		n, _ := strconv.ParseInt(string(v), 10, 64)
		return n
	}
	return 0
}

func pbList(m map[int]any, field int) []any {
	switch v := m[field].(type) {
	case []any:
		return v
	case nil:
		return nil
	default:
		return []any{v}
	}
}

func pbF(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	}
	return math.NaN()
}

// --- IM envelope -----------------------------------------------------------

const imAPIPlatform = "douyin_pc"

// imHeaderEntries mirrors the 17 browser entries, in the captured order.
func imHeaderEntries() [][2]string {
	prof := GetProfile()
	return [][2]string{
		{"session_aid", "6383"},
		{"session_did", "0"},
		{"app_name", "douyin_pc"},
		{"priority_region", "cn"},
		{"user_agent", prof.UA},
		{"cookie_enabled", "true"},
		{"browser_language", "zh-CN"},
		{"browser_platform", "Win32"},
		{"browser_name", "Mozilla"},
		{"browser_version", strings.Replace(prof.UA, "Mozilla/", "", 1)},
		{"browser_online", "true"},
		{"screen_width", prof.ScreenWidth},
		{"screen_height", prof.ScreenHeight},
		{"referer", "https://www.douyin.com/jingxuan"},
		{"timezone_name", "Asia/Shanghai"},
		{"deviceId", "0"},
		{"is-retry", "0"},
	}
}

// imEnvelope builds the Request wire bytes for one IM cmd.
// inboxType/body match the captured browser requests per endpoint.
func imEnvelope(cmd int64, inboxType int64, body *pbw) []byte {
	w := &pbw{}
	w.IntAlways(1, cmd)
	w.IntAlways(2, int64(10000+rand.IntN(1000)))
	w.Str(3, imSDKVersion)
	w.IntAlways(5, 3)
	w.IntAlways(6, inboxType)
	w.Str(7, imBuildNumber)
	w.Msg(8, body)
	w.Str(9, "0")
	w.Str(11, imAPIPlatform)
	w.Str(14, imVersionCode)
	for _, kv := range imHeaderEntries() {
		e := &pbw{}
		e.Str(1, kv[0])
		e.Str(2, kv[1])
		w.Msg(15, e)
	}
	w.IntAlways(18, 1)
	w.Str(21, "douyin_web")
	w.Str(22, "web_sdk")
	return w.b
}

// imResponseBody validates the Response envelope and returns the cmd-specific
// body message plus the error code/message.
func imResponseBody(data []byte) (map[int]any, int64, string, error) {
	env, err := pbParse(data)
	if err != nil {
		return nil, 0, "", err
	}
	code := pbInt(env, 3)
	msg := pbString(env, 4)
	bodyBytes, ok := env[6].([]byte)
	if !ok {
		if code != 0 {
			return nil, code, msg, nil
		}
		return nil, code, msg, errors.New("im: response has no body")
	}
	body, err := pbParse(bodyBytes)
	if err != nil {
		return nil, code, msg, err
	}
	return body, code, msg, nil
}

// imCmdBody extracts the single cmd-keyed sub-message from a Response body.
func imCmdBody(body map[int]any, cmd int) map[int]any {
	if inner, ok := pbMsg(body, cmd); ok {
		return inner
	}
	return nil
}
