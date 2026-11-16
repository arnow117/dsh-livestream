package douyin

// FingerprintJS fpk1/fpk2 generation so the login flow no longer needs
// DY_FPK1/DY_FPK2 to be supplied by hand.
//
//	fpk2 = lowercase MD5 of the full User-Agent
//	fpk1 = base64("Salted__" + salt + AES-256-CBC(EVP_BytesToKey(md5,
//	       "byte_fingerprint", salt), ascii(murmur_x64_128(component string))))

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/bits"
	"slices"
	"strings"
)

// --- order-preserving JSON values ------------------------------------------

type jsKind byte

const (
	jsObject jsKind = 'o'
	jsArray  jsKind = 'a'
	jsString jsKind = 's'
	jsNumber jsKind = 'n'
	jsBool   jsKind = 'b'
	jsNull   jsKind = 'z'
	jsUndef  jsKind = 'u'
)

type jsPair struct {
	key string
	val *jsVal
}

type jsVal struct {
	kind  jsKind
	pairs []jsPair
	items []*jsVal
	str   string
	num   string
	bl    bool
}

func decodeJSValue(dec *json.Decoder) (*jsVal, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return decodeJSToken(dec, tok)
}

func decodeJSToken(dec *json.Decoder, tok json.Token) (*jsVal, error) {
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			v := &jsVal{kind: jsObject}
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := keyTok.(string)
				val, err := decodeJSValue(dec)
				if err != nil {
					return nil, err
				}
				v.pairs = append(v.pairs, jsPair{key: key, val: val})
			}
			if _, err := dec.Token(); err != nil { // consume '}'
				return nil, err
			}
			return v, nil
		case '[':
			v := &jsVal{kind: jsArray}
			for dec.More() {
				item, err := decodeJSValue(dec)
				if err != nil {
					return nil, err
				}
				v.items = append(v.items, item)
			}
			if _, err := dec.Token(); err != nil { // consume ']'
				return nil, err
			}
			return v, nil
		}
		return nil, fmt.Errorf("fpk: unexpected delimiter %v", t)
	case string:
		return &jsVal{kind: jsString, str: t}, nil
	case json.Number:
		return &jsVal{kind: jsNumber, num: t.String()}, nil
	case bool:
		return &jsVal{kind: jsBool, bl: t}, nil
	case nil:
		return &jsVal{kind: jsNull}, nil
	}
	return nil, fmt.Errorf("fpk: unexpected token %T", tok)
}

// String renders the value the way JSON.stringify would (undefined stays the
// literal `undefined`, and undefined object members are dropped).
func (v *jsVal) String() string {
	switch v.kind {
	case jsUndef:
		return "undefined"
	case jsNull:
		return "null"
	case jsBool:
		if v.bl {
			return "true"
		}
		return "false"
	case jsNumber:
		return v.num
	case jsString:
		return quoteJSString(v.str)
	case jsArray:
		parts := make([]string, 0, len(v.items))
		for _, item := range v.items {
			parts = append(parts, item.String())
		}
		return "[" + strings.Join(parts, ",") + "]"
	case jsObject:
		parts := make([]string, 0, len(v.pairs))
		for _, kv := range v.pairs {
			if kv.val.kind == jsUndef {
				continue
			}
			parts = append(parts, quoteJSString(kv.key)+":"+kv.val.String())
		}
		return "{" + strings.Join(parts, ",") + "}"
	}
	return "undefined"
}

// quoteJSString mirrors JSON.stringify's string escaping (no ASCII escaping).
func quoteJSString(s string) string {
	var sb strings.Builder
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
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
			if r < 0x20 {
				sb.WriteString(fmt.Sprintf(`\u%04x`, r))
				continue
			}
			sb.WriteRune(r)
		}
	}
	sb.WriteByte('"')
	return sb.String()
}

// unwrapComponent unwraps a component wrapper: a wrapper carrying
// "value" (or only "duration") is replaced by its value, or by undefined.
func unwrapComponent(v *jsVal) *jsVal {
	if v.kind != jsObject {
		return v
	}
	hasValue, hasDuration := false, false
	var value *jsVal
	for _, kv := range v.pairs {
		switch kv.key {
		case "value":
			hasValue, value = true, kv.val
		case "duration":
			hasDuration = true
		}
	}
	if !hasValue && !hasDuration {
		return v
	}
	if hasValue {
		return value
	}
	return &jsVal{kind: jsUndef}
}

// FingerprintComponentString builds the ordered string fed to murmurX64_128.
func FingerprintComponentString(profileJSON []byte) (string, error) {
	dec := json.NewDecoder(strings.NewReader(string(profileJSON)))
	dec.UseNumber()
	root, err := decodeJSValue(dec)
	if err != nil {
		return "", err
	}
	components := findJSONMember(root, "fingerprintjs_components")
	if components == nil {
		components = findJSONMember(root, "components")
	}
	if components == nil {
		return "", fmt.Errorf("fpk: 档案里没有 fingerprintjs_components")
	}
	names := make([]string, 0, len(components.pairs))
	values := map[string]*jsVal{}
	for _, kv := range components.pairs {
		if kv.key == "id" || kv.key == "visitorId" {
			continue
		}
		names = append(names, kv.key)
		values[kv.key] = unwrapComponent(kv.val)
	}
	slices.Sort(names)
	pieces := make([]string, 0, len(names))
	for _, name := range names {
		escaped := strings.NewReplacer(`\`, `\\`, `:`, `\:`, `|`, `\|`).Replace(name)
		pieces = append(pieces, escaped+":"+values[name].String())
	}
	return strings.Join(pieces, "|"), nil
}

func findJSONMember(v *jsVal, name string) *jsVal {
	if v == nil || v.kind != jsObject {
		return nil
	}
	if i := slices.IndexFunc(v.pairs, func(kv jsPair) bool { return kv.key == name }); i >= 0 {
		return v.pairs[i].val
	}
	return nil
}

// --- murmur3 x64 128 (FingerprintJS variant) -------------------------------

func rotl64(x uint64, n uint) uint64 { return bits.RotateLeft64(x, int(n)) }

func fmix64(k uint64) uint64 {
	k ^= k >> 33
	k *= 0xFF51AFD7ED558CCD
	k ^= k >> 33
	k *= 0xC4CEB9FE1A85EC53
	k ^= k >> 33
	return k
}

// MurmurX64Hash128 mirrors FingerprintJS' murmurX64Hash128 helper.
func MurmurX64Hash128(text string, seed uint64) string {
	data := []byte(text)
	h1, h2 := seed, seed
	const c1, c2 = 0x87C37B91114253D5, 0x4CF5AD432745937F
	full := len(data) - len(data)%16
	for off := 0; off < full; off += 16 {
		k1 := uint64(data[off]) | uint64(data[off+1])<<8 | uint64(data[off+2])<<16 | uint64(data[off+3])<<24 |
			uint64(data[off+4])<<32 | uint64(data[off+5])<<40 | uint64(data[off+6])<<48 | uint64(data[off+7])<<56
		k2 := uint64(data[off+8]) | uint64(data[off+9])<<8 | uint64(data[off+10])<<16 | uint64(data[off+11])<<24 |
			uint64(data[off+12])<<32 | uint64(data[off+13])<<40 | uint64(data[off+14])<<48 | uint64(data[off+15])<<56
		k1 = rotl64(k1*c1, 31) * c2
		h1 ^= k1
		h1 = rotl64(h1, 27) + h2
		h1 = h1*5 + 0x52DCE729
		k2 = rotl64(k2*c2, 33) * c1
		h2 ^= k2
		h2 = rotl64(h2, 31) + h1
		h2 = h2*5 + 0x38495AB5
	}
	tail := data[full:]
	var k1, k2 uint64
	for i, b := range tail[:min(8, len(tail))] {
		k1 ^= uint64(b) << (8 * uint(i))
	}
	if len(tail) > 8 {
		for i, b := range tail[8:] {
			k2 ^= uint64(b) << (8 * uint(i))
		}
		k2 = rotl64(k2*c2, 33) * c1
		h2 ^= k2
	}
	if len(tail) > 0 {
		k1 = rotl64(k1*c1, 31) * c2
		h1 ^= k1
	}
	h1 ^= uint64(len(data))
	h2 ^= uint64(len(data))
	h1 += h2
	h2 += h1
	h1 = fmix64(h1)
	h2 = fmix64(h2)
	h1 += h2
	h2 += h1
	return fmt.Sprintf("%016x%016x", h1, h2)
}

// --- fpk1 / fpk2 -----------------------------------------------------------

// BuildFingerprintDigest derives the 32-hex FingerprintJS digest from the
// embedded challenge profile.
func BuildFingerprintDigest() (string, error) {
	s, err := FingerprintComponentString(challengeProfileJSON)
	if err != nil {
		return "", err
	}
	return MurmurX64Hash128(s, 0), nil
}

// BuildFpk2 returns lowercase MD5 of the User-Agent.
func BuildFpk2(ua string) string { return MD5Hex(ua) }

// BuildFpk1 encrypts the digest the way the page SDK does. salt must be 8 bytes.
func BuildFpk1(digest string, salt []byte) (string, error) {
	digest = strings.ToLower(strings.TrimSpace(digest))
	if len(digest) != 32 {
		return "", fmt.Errorf("fpk1: 明文必须是 32 位十六进制摘要")
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return "", fmt.Errorf("fpk1: 明文不是合法十六进制: %w", err)
	}
	if len(salt) != 8 {
		return "", fmt.Errorf("fpk1: salt 必须是 8 字节")
	}
	key, iv := evpBytesToKey([]byte("byte_fingerprint"), salt, 32, 16)
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	plain := []byte(digest)
	pad := aes.BlockSize - len(plain)%aes.BlockSize
	padded := slices.Concat(plain, make([]byte, pad))
	for i := len(padded) - pad; i < len(padded); i++ {
		padded[i] = byte(pad)
	}
	out := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, padded)
	raw := append(append([]byte("Salted__"), salt...), out...)
	return base64.StdEncoding.EncodeToString(raw), nil
}

// BuildFpk1Random is BuildFpk1 with a fresh random salt, like the browser.
func BuildFpk1Random() (string, error) {
	digest, err := BuildFingerprintDigest()
	if err != nil {
		return "", err
	}
	salt := make([]byte, 8)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return "", err
	}
	return BuildFpk1(digest, salt)
}

// evpBytesToKey mirrors OpenSSL's EVP_BytesToKey(EVP_aes_256_cbc, EVP_md5).
func evpBytesToKey(password, salt []byte, keyLen, ivLen int) ([]byte, []byte) {
	var out, prev []byte
	for len(out) < keyLen+ivLen {
		h := md5.New()
		h.Write(prev)
		h.Write(password)
		h.Write(salt)
		prev = h.Sum(nil)
		out = append(out, prev...)
	}
	return out[:keyLen], out[keyLen : keyLen+ivLen]
}
