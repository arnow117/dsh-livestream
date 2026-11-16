package douyin

// strData report-body generation.
//
// The mssdk report plaintext is a compact JSON document whose *key order* is
// part of the encrypted bytes, so encoding/json's map ordering is unusable
// here. The orderedJSON type below preserves object insertion order and emits
// compact JSON with no ASCII escaping and no spaces after separators.

import (
	"bytes"
	"cmp"
	"crypto/rand"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed profiles/mstoken_profile.json
var mstokenProfileJSON []byte

// customAlphabet is the mssdk custom base64 alphabet.
const customAlphabet = "Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe"

// ---------------------------------------------------------------------------
// order-preserving JSON
// ---------------------------------------------------------------------------

type jNode struct {
	kind  byte // 'o' object, 'a' array, 's' string, 'n' number, 'b' bool, 'z' null
	pairs []jPair
	arr   []*jNode
	str   string
	num   string
	b     bool
}

type jPair struct {
	key string
	val *jNode
}

func jStr(s string) *jNode { return &jNode{kind: 's', str: s} }
func jNum(s string) *jNode { return &jNode{kind: 'n', num: s} }
func jInt(v int64) *jNode  { return &jNode{kind: 'n', num: strconv.FormatInt(v, 10)} }
func jBool(v bool) *jNode  { return &jNode{kind: 'b', b: v} }
func jNull() *jNode        { return &jNode{kind: 'z'} }
func jObj() *jNode         { return &jNode{kind: 'o'} }
func jArr() *jNode         { return &jNode{kind: 'a'} }

func (n *jNode) get(key string) (*jNode, bool) {
	if n == nil || n.kind != 'o' {
		return nil, false
	}
	for i := range n.pairs {
		if n.pairs[i].key == key {
			return n.pairs[i].val, true
		}
	}
	return nil, false
}

// set replaces an existing key in place or appends it.
func (n *jNode) set(key string, val *jNode) {
	for i := range n.pairs {
		if n.pairs[i].key == key {
			n.pairs[i].val = val
			return
		}
	}
	n.pairs = append(n.pairs, jPair{key: key, val: val})
}

// setDefault only assigns when the key is absent.
func (n *jNode) setDefault(key string, val *jNode) {
	if _, ok := n.get(key); !ok {
		n.pairs = append(n.pairs, jPair{key: key, val: val})
	}
}

// del removes a key, returning the removed value (nil when absent).
func (n *jNode) del(key string) *jNode {
	for i := range n.pairs {
		if n.pairs[i].key == key {
			v := n.pairs[i].val
			n.pairs = append(n.pairs[:i], n.pairs[i+1:]...)
			return v
		}
	}
	return nil
}

func (n *jNode) deepCopy() *jNode {
	if n == nil {
		return nil
	}
	out := &jNode{kind: n.kind, str: n.str, num: n.num, b: n.b}
	if n.kind == 'o' {
		out.pairs = make([]jPair, len(n.pairs))
		for i, p := range n.pairs {
			out.pairs[i] = jPair{key: p.key, val: p.val.deepCopy()}
		}
	}
	if n.kind == 'a' {
		out.arr = make([]*jNode, len(n.arr))
		for i, v := range n.arr {
			out.arr[i] = v.deepCopy()
		}
	}
	return out
}

func decodeJNode(dec *json.Decoder) (*jNode, error) {
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch v := t.(type) {
	case json.Delim:
		switch v {
		case '{':
			n := jObj()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := kt.(string)
				val, err := decodeJNode(dec)
				if err != nil {
					return nil, err
				}
				n.pairs = append(n.pairs, jPair{key: key, val: val})
			}
			if _, err := dec.Token(); err != nil { // consume '}'
				return nil, err
			}
			return n, nil
		case '[':
			n := jArr()
			for dec.More() {
				val, err := decodeJNode(dec)
				if err != nil {
					return nil, err
				}
				n.arr = append(n.arr, val)
			}
			if _, err := dec.Token(); err != nil { // consume ']'
				return nil, err
			}
			return n, nil
		}
	case string:
		return jStr(v), nil
	case json.Number:
		return jNum(v.String()), nil
	case bool:
		return jBool(v), nil
	case nil:
		return jNull(), nil
	}
	return nil, fmt.Errorf("unexpected JSON token %v", t)
}

func parseOrderedJSON(data []byte) (*jNode, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return decodeJNode(dec)
}

// encodeCompact serializes to compact JSON with no ASCII escaping.
func (n *jNode) encodeCompact(sb *strings.Builder) {
	switch n.kind {
	case 'o':
		sb.WriteByte('{')
		for i, p := range n.pairs {
			if i > 0 {
				sb.WriteByte(',')
			}
			encodeJSONStr(sb, p.key)
			sb.WriteByte(':')
			p.val.encodeCompact(sb)
		}
		sb.WriteByte('}')
	case 'a':
		sb.WriteByte('[')
		for i, v := range n.arr {
			if i > 0 {
				sb.WriteByte(',')
			}
			v.encodeCompact(sb)
		}
		sb.WriteByte(']')
	case 's':
		encodeJSONStr(sb, n.str)
	case 'n':
		sb.WriteString(n.num)
	case 'b':
		if n.b {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case 'z':
		sb.WriteString("null")
	}
}

func (n *jNode) stringCompact() string {
	var sb strings.Builder
	n.encodeCompact(&sb)
	return sb.String()
}

// encodeJSONStr escapes a string for JSON output without ASCII escaping.
func encodeJSONStr(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for i := range len(s) {
		c := s[i]
		switch c {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		default:
			if c < 0x20 {
				const hexdig = "0123456789abcdef"
				sb.WriteString(`\u00`)
				sb.WriteByte(hexdig[c>>4])
				sb.WriteByte(hexdig[c&15])
			} else {
				sb.WriteByte(c)
			}
		}
	}
	sb.WriteByte('"')
}

// ---------------------------------------------------------------------------
// strData encoder
// ---------------------------------------------------------------------------

// RC4 applies the classic RC4 stream cipher with the given key.
func RC4(key, data []byte) []byte {
	var s [256]byte
	for i := range 256 {
		s[i] = byte(i)
	}
	j := 0
	for i := range 256 {
		j = (j + int(s[i]) + int(key[i%len(key)])) & 255
		s[i], s[j] = s[j], s[i]
	}
	out := make([]byte, len(data))
	i, j := 0, 0
	for k, b := range data {
		i = (i + 1) & 255
		j = (j + int(s[i])) & 255
		s[i], s[j] = s[j], s[i]
		out[k] = b ^ s[(int(s[i])+int(s[j]))&255]
	}
	return out
}

// b64CustomEncode encodes with the mssdk custom alphabet (standard padding).
func b64CustomEncode(data []byte) string {
	var sb strings.Builder
	n := len(data)
	sb.Grow((n + 2) / 3 * 4)
	for i := 0; i < n; i += 3 {
		b0 := data[i]
		var b1, b2 byte
		if i+1 < n {
			b1 = data[i+1]
		}
		if i+2 < n {
			b2 = data[i+2]
		}
		trip := uint32(b0)<<16 | uint32(b1)<<8 | uint32(b2)
		sb.WriteByte(customAlphabet[(trip>>18)&63])
		sb.WriteByte(customAlphabet[(trip>>12)&63])
		if i+1 < n {
			sb.WriteByte(customAlphabet[(trip>>6)&63])
		} else {
			sb.WriteByte('=')
		}
		if i+2 < n {
			sb.WriteByte(customAlphabet[trip&63])
		} else {
			sb.WriteByte('=')
		}
	}
	return sb.String()
}

// EncodeStrData RC4-encrypts plaintext with a single-byte nonce key and
// prefixes the 0x41/nonce header, then custom-base64 encodes the result.
func EncodeStrData(plaintext []byte, nonce byte) string {
	cipher := RC4([]byte{nonce}, plaintext)
	raw := make([]byte, 0, len(cipher)+2)
	raw = append(raw, 0x41, nonce)
	raw = append(raw, cipher...)
	return b64CustomEncode(raw)
}

// mstokenEnvelope wraps a strData blob in the mssdk JSON envelope.
func mstokenEnvelope(strData string, tsp int64) string {
	e := jObj()
	e.set("magic", jInt(538969122))
	e.set("version", jInt(1))
	e.set("dataType", jInt(8))
	e.set("strData", jStr(strData))
	e.set("tspFromClient", jInt(tsp))
	e.set("ulr", jInt(0))
	return e.stringCompact()
}

// ---------------------------------------------------------------------------
// device profile loading
// ---------------------------------------------------------------------------

// loadMsTokenProfile parses the embedded profile once on first use.
var loadMsTokenProfile = sync.OnceValues(func() (*jNode, error) {
	return parseOrderedJSON(mstokenProfileJSON)
})

// ---------------------------------------------------------------------------
// helpers for JSON number/float handling
// ---------------------------------------------------------------------------

// numFromValue renders an int64/float64/string as a JSON number for a value
// that came from a capture or a local rule.
func numFromValue(v any) *jNode {
	switch t := v.(type) {
	case int:
		return jInt(int64(t))
	case int64:
		return jInt(t)
	case float64:
		return jNum(formatFloat(t))
	case json.Number:
		return jNum(t.String())
	case string:
		return jNum(t)
	default:
		return jNull()
	}
}

// formatFloat formats a float as a plain decimal for the magnitudes used by
// the collectTime field, keeping a trailing .0 for integral values.
func formatFloat(f float64) string {
	if f == float64(int64(f)) && f < 1e15 && f > -1e15 {
		return strconv.FormatInt(int64(f), 10) + ".0"
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

func envOr(key, def string) string {
	return cmp.Or(os.Getenv(key), def)
}

// fixedCollectTime resolves DY_MSTOKEN_FIXED_COLLECT_TIME: JSON-decode to
// preserve integer/float spelling, else parse as float, else nil (caller
// supplies the default).
func fixedCollectTime() any {
	v, ok := os.LookupEnv("DY_MSTOKEN_FIXED_COLLECT_TIME")
	if !ok || v == "" {
		return nil
	}
	dec := json.NewDecoder(strings.NewReader(v))
	dec.UseNumber()
	var out any
	if err := dec.Decode(&out); err != nil {
		if f, ferr := strconv.ParseFloat(v, 64); ferr == nil {
			return f
		}
		return nil
	}
	switch t := out.(type) {
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return i
		}
		if f, err := t.Float64(); err == nil {
			return f
		}
	case float64:
		return t
	case string:
		if f, err := strconv.ParseFloat(t, 64); err == nil {
			return f
		}
	}
	return out
}

var uuidRandPool = rand.Reader

// randomUUIDv4 returns a lowercase UUID v4.
func randomUUIDv4() string {
	var b [16]byte
	if _, err := uuidRandPool.Read(b[:]); err != nil {
		// crypto/rand should never fail; fall back to a time-seeded value.
		ts := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(ts >> (i % 8 * 8))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	const hexdig = "0123456789abcdef"
	out := make([]byte, 0, 36)
	for i, v := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out = append(out, '-')
		}
		out = append(out, hexdig[v>>4], hexdig[v&15])
	}
	return string(out)
}

// ---------------------------------------------------------------------------
// /web/r/token report body (report + fingerprint)
// ---------------------------------------------------------------------------

// BuildMsTokenReportBody builds the /web/r/token report body.
func BuildMsTokenReportBody(aid, pageID int, fixedUUID string, collectTime any) (string, error) {
	plaintext, err := buildMsTokenFingerprint(aid, pageID, fixedUUID, collectTime)
	if err != nil {
		return "", err
	}
	nonce := byte(randIntN(256))
	if fixedNonce, ok := os.LookupEnv("DY_MSTOKEN_FIXED_NONCE"); ok && fixedNonce != "" {
		if n, err := strconv.Atoi(fixedNonce); err == nil {
			nonce = byte(n)
		}
	}
	ts := time.Now().UnixMilli()
	if fixedTS, ok := os.LookupEnv("DY_MSTOKEN_FIXED_TIMESTAMP"); ok && fixedTS != "" {
		if n, err := strconv.ParseInt(fixedTS, 10, 64); err == nil {
			ts = n
		}
	}
	return mstokenEnvelope(EncodeStrData([]byte(plaintext), nonce), ts), nil
}

func buildMsTokenFingerprint(aid, pageID int, fixedUUID string, collectTime any) (string, error) {
	root, err := loadMsTokenProfile()
	if err != nil {
		return "", err
	}
	nRaw, ok := root.get("nWID")
	if !ok {
		return "", fmt.Errorf("mstoken_profile.json 缺少 nWID")
	}
	wid, _ := root.get("wID")
	n := nRaw.deepCopy()

	prof := GetProfile()
	w, _ := strconv.Atoi(prof.ScreenWidth)
	h, _ := strconv.Atoi(prof.ScreenHeight)
	cpu, _ := strconv.Atoi(prof.CpuCoreNum)
	g := prof.Geo
	if screen, ok := n.get("screen"); ok {
		screen.set("height", jInt(int64(h)))
		screen.set("width", jInt(int64(w)))
		screen.set("availHeight", jInt(int64(g[5])))
		screen.set("availWidth", jInt(int64(g[4])))
		screen.set("availTop", jInt(0))
		screen.set("availLeft", jInt(0))
	}
	if nav, ok := n.get("navigator"); ok {
		nav.set("hardwareConcurrency", jInt(int64(cpu)))
		nav.set("userAgent", jStr(prof.UA))
	}
	if webgl, ok := n.get("webgl"); ok {
		webgl.set("renderer", jStr(prof.WebGLRenderer))
		webgl.set("vendor", jStr(prof.WebGLVendor))
	}
	audioNode, _ := n.get("audio")
	if audioNode == nil || audioNode.kind != 'o' {
		audioNode = jObj()
		n.set("audio", audioNode)
	}
	acNode, _ := audioNode.get("audioContext")
	if acNode == nil || acNode.kind != 'o' {
		acNode = jObj()
		audioNode.set("audioContext", acNode)
	}
	acNode.set("state", jStr("running"))

	msVersion := "0.0.0.1"
	if mv := n.del("ms_version"); mv != nil && mv.kind == 's' && mv.str != "" {
		msVersion = mv.str
	}
	if fixedUUID == "" {
		fixedUUID = envOr("DY_MSTOKEN_FIXED_UUID", randomUUIDv4())
	}
	if collectTime == nil {
		collectTime = roundFloat(40+randFloat()*120, 10)
	}
	custom := jObj()
	custom.set("version", jStr(msVersion))
	custom.set("fxgDid", jStr(""))
	custom.set("uuid", jStr(fixedUUID))
	custom.set("collectTime", numFromValue(collectTime))
	custom.set("aid", jInt(int64(aid)))
	custom.set("pageId", jInt(int64(pageID)))
	n.set("custom", jStr(custom.stringCompact()))
	n.set("ms_version", jStr(msVersion))

	out := jObj()
	out.set("nWID", n)
	if wid == nil {
		wid = jObj()
	}
	out.set("wID", wid.deepCopy())
	return out.stringCompact(), nil
}

func roundFloat(v float64, digits int) float64 {
	pow := 1.0
	for range digits {
		pow *= 10
	}
	return float64(int64(v*pow+0.5)) / pow
}

func randIntN(n int) int {
	if n <= 0 {
		return 0
	}
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return int(time.Now().UnixNano() % int64(n))
	}
	v := uint64(0)
	for _, x := range b {
		v = v<<8 | uint64(x)
	}
	return int(v % uint64(n))
}
