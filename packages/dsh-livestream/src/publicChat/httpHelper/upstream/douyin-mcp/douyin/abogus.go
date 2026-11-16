package douyin

// a_bogus signature (fixed=False path).

import (
	"fmt"
	"math/rand/v2"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"
)

const (
	abogusSalt        = "dhzx"
	abogusFornight    = 1721836800000
	abogusRC4KeyByte  = 211
	abogusSDKVersion  = 1
	abogusSDKMinor    = 12
	abogusGeoPlatform = "Win32"
)

var abogusAlphabetS3 = "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe"
var abogusAlphabetS4 = "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe"

// a98Perm is the field permutation the SDK hashes into the checksum block.
var a98Perm = []int{
	34, 44, 56, 61, 73, 29, 70, 45, 35, 49, 38, 66, 51, 68, 28, 48, 64, 47,
	30, 71, 26, 55, 31, 69, 59, 40, 62, 63, 27, 72, 41, 74, 57, 52, 42, 39,
	33, 67, 53, 43, 65, 46, 36, 24, 60, 32, 79, 80, 84, 85,
}

var (
	z148RMasks  = [3]int{145, 66, 44}
	z148InMasks = [3]int{110, 189, 211}
)

var abogusChkIndices = []int{
	24, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 38, 39, 40, 41, 42, 43,
	44, 45, 46, 47, 48, 49, 51, 52, 53, 55, 56, 57, 59, 60, 61, 62, 63, 64,
	65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 79, 80, 84, 85,
}

type abogusHostConfig struct {
	sdkVersion int
	sdkMinor   int
	l40, l41   int
	l42        int
	aid        int
	pageID     int
}

var abogusHosts = map[string]abogusHostConfig{
	"www.douyin.com":     {sdkVersion: 1, sdkMinor: 8, l40: 132, l41: 1, l42: 1, aid: 6383, pageID: 11881},
	"login.douyin.com":   {sdkVersion: 1, sdkMinor: 14, l40: 0, l41: 0, l42: 0, aid: 6383, pageID: 6241},
	"live.douyin.com":    {sdkVersion: 1, sdkMinor: abogusSDKMinor, aid: 6383, pageID: 7571},
	"creator.douyin.com": {sdkVersion: 1, sdkMinor: abogusSDKMinor, aid: 2906, pageID: 33638},
}

// AbogusSigner is a stateful signer (its counter increments per signature).
type AbogusSigner struct {
	counter    int
	ua         string
	geo        [8]int
	offset     string
	rand       *rand.Rand
	fixedNow   int64
	fixedRand  *float64
	fixedSeq   []float64
	fixedSeqIx int
}

// NewAbogusSigner builds a signer bound to the current fingerprint profile.
func NewAbogusSigner() *AbogusSigner {
	prof := GetProfile()
	s := &AbogusSigner{
		counter: 2,
		ua:      prof.UA,
		geo:     prof.Geo,
		offset:  BrowserName(prof.UA),
		rand:    rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), uint64(os.Getpid()))),
	}
	if v := abogusEnvInt("DY_ABOGUS_FIXED_COUNTER"); v != 0 {
		s.counter = v
	}
	if v := abogusEnvInt("DY_ABOGUS_FIXED_NOW"); v != 0 {
		s.fixedNow = int64(v)
	} else if v := abogusEnvInt("DY_FIXED_TIMESTAMP_MS"); v != 0 {
		s.fixedNow = int64(v)
	}
	if raw := strings.TrimSpace(os.Getenv("DY_ABOGUS_FIXED_RAND_SEQ")); raw != "" {
		for part := range strings.SplitSeq(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			var f float64
			if _, err := fmt.Sscanf(part, "%g", &f); err == nil {
				s.fixedSeq = append(s.fixedSeq, f)
			}
		}
	}
	if raw := strings.TrimSpace(os.Getenv("DY_ABOGUS_FIXED_RAND")); raw != "" {
		var f float64
		if _, err := fmt.Sscanf(raw, "%g", &f); err == nil {
			s.fixedRand = &f
		}
	}
	return s
}

func abogusEnvInt(key string) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return 0
	}
	var n int
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil {
		return 0
	}
	return n
}

func (s *AbogusSigner) nowMS() int64 {
	if s.fixedNow != 0 {
		return s.fixedNow
	}
	return time.Now().UnixMilli()
}

func (s *AbogusSigner) randFloat() float64 {
	if s.fixedSeq != nil {
		idx := s.fixedSeqIx
		s.fixedSeqIx++
		if idx < len(s.fixedSeq) {
			return s.fixedSeq[idx]
		}
	}
	if s.fixedRand != nil {
		return *s.fixedRand
	}
	return s.rand.Float64()
}

// Sign signs a full URL (query extracted, host used for the embedded aid).
func (s *AbogusSigner) Sign(rawURL, body string) string {
	query := ""
	host := ""
	if rest, q, ok := strings.Cut(rawURL, "?"); ok {
		query = q
		if h := hostOf(rest); h != "" {
			host = h
		}
	} else {
		host = hostOf(rawURL)
	}
	return s.SignQuery(query, body, host)
}

// SignQuery signs raw query/body strings for a given host.
func (s *AbogusSigner) SignQuery(query, body, host string) string {
	cfg, ok := abogusHosts[host]
	if !ok {
		cfg = abogusHosts["www.douyin.com"]
	}

	L := make([]int64, 100)
	s.counter++
	L[12] = 3
	s.fixedSeqIx = 0
	t := s.nowMS()
	L[14] = t

	v129 := cfg.sdkVersion
	v14 := cfg.sdkMinor
	h1 := sm3Hash(sm3Hash([]byte(query + abogusSalt)))
	h2 := sm3Hash(sm3Hash([]byte(body + abogusSalt)))
	uaKey := []int{v129 / 256, v129 % 256, v14 % 256}
	uaChars := make([]int, 0, len(s.ua))
	for _, r := range s.ua {
		uaChars = append(uaChars, int(r))
	}
	uaCipher := rc4Variant(uaKey, uaChars)
	uaB64 := b64Custom(intsToBytes(uaCipher), abogusAlphabetS3)
	hUA := sm3Hash([]byte(uaB64))

	ink := t - 1
	L[24] = 41
	L[26] = (t - abogusFornight) / 1000 / 60 / 60 / 24 / 14
	L[27] = int64(z149CounterBucket(s.counter))
	L[28] = 3 // fixed closure time == now, so (t-closure+3)&255 == 3
	copyInts(L, 29, leBytes(t, 6))
	L[35], L[36] = int64(leBytes(int64(v129), 2)[0]), int64(leBytes(int64(v129), 2)[1])
	flags := envFlagsByte(false, s.ua)
	L[38], L[39] = int64(leBytes(int64(flags), 2)[0]), int64(leBytes(int64(flags), 2)[1])
	L[40] = int64(cfg.l40)
	L[41] = int64(cfg.l41)
	L[42] = int64(cfg.l42)
	L[43] = 0
	copyInts(L, 44, leBytes(int64(v14), 4))
	L[48], L[49] = int64(h1[9]), int64(h1[18])
	L[51] = int64(escapeDigest(h1, 3, 11, 12, flags&2 != 0))
	L[52], L[53] = int64(h2[10]), int64(h2[19])
	L[55] = int64(escapeDigest(h2, 4, 8, 9, flags&4 != 0))
	L[56], L[57] = int64(hUA[11]), int64(hUA[21])
	L[59] = int64(escapeDigest(hUA, 5, 12, 13, flags&8 != 0))
	copyInts(L, 60, leBytes(ink, 6))
	L[66] = L[12]
	copyInts(L, 67, leBytes(int64(cfg.pageID), 4))
	copyInts(L, 71, leBytes(int64(cfg.aid), 4))

	geoStr := strings.Join(append(itoaSlice(s.geo[:]), abogusGeoPlatform), "|")
	geoBytes := strToBytes(geoStr)
	L[78] = int64(len(geoBytes))
	copyInts(L, 79, leBytes(L[78], 2))
	suffixBytes := strToBytes(itoa(int((t+3)&255)) + ",")
	L[83] = int64(len(suffixBytes))
	copyInts(L, 84, leBytes(L[83], 2))

	// L[25] == [1,0,1,0,1]
	v6 := s.randFloat() * 65535
	a8 := z146Blend(1, 0, byte(int(v6)&255), byte((int(v6)>>8)&255))
	s.randFloat() // consumed by the SDK, value discarded
	a8 = append(a8, z146Blend(1, 0,
		byte(z144Check(s.randFloat(), flags)),
		byte(z145PermissionsBits(s.randFloat())))...)

	chk := 0
	for _, b := range a8 {
		chk ^= int(b)
	}
	for _, sIdx := range abogusChkIndices {
		chk ^= int(L[sIdx])
	}
	L[87] = int64(toInt32(chk))

	a98 := make([]int, 0, len(a98Perm)+len(geoBytes)+len(suffixBytes)+1)
	for _, sIdx := range a98Perm {
		a98 = append(a98, int(L[sIdx]))
	}
	a98 = append(a98, intsFromBytes(geoBytes)...)
	a98 = append(a98, intsFromBytes(suffixBytes)...)
	a98 = append(a98, int(L[87]))

	hr0 := int(s.randFloat()*65535) & 255
	l89 := z146Blend(3, 82, byte(hr0), byte(z143RandOffset(s.randFloat(), s.offset)))

	plain := slices.Concat(intsFromBytes(a8), z148Expand(a98, s.randFloat))
	masked := make([]int, len(plain))
	for i, x := range plain {
		masked[i] = x & 0xFFFF
	}
	cipher := rc4Variant([]int{abogusRC4KeyByte}, masked)

	out := make([]int, 0, len(l89)+len(cipher))
	out = append(out, intsFromBytes(l89)...)
	for _, c := range cipher {
		out = append(out, c&255)
	}
	return b64Custom(intsToBytes(out), abogusAlphabetS4)
}

func copyInts(dst []int64, start int, src []int) {
	for i, v := range src {
		dst[start+i] = int64(v)
	}
}

func hostOf(rawURL string) string {
	s := rawURL
	if _, after, ok := strings.Cut(s, "://"); ok {
		s = after
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	if _, after, ok := strings.Cut(s, "@"); ok {
		s = after
	}
	if before, _, ok := strings.Cut(s, ":"); ok {
		s = before
	}
	return s
}

func b64Custom(data []byte, alphabet string) string {
	var sb strings.Builder
	for i := 0; i < len(data); i += 3 {
		n := len(data) - i
		if n > 3 {
			n = 3
		}
		b := [3]byte{}
		copy(b[:], data[i:i+n])
		v := int(b[0])<<16 | int(b[1])<<8 | int(b[2])
		idx := [4]int{(v >> 18) & 63, (v >> 12) & 63, (v >> 6) & 63, v & 63}
		switch n {
		case 1:
			sb.WriteByte(alphabet[idx[0]])
			sb.WriteByte(alphabet[idx[1]])
			sb.WriteString("==")
		case 2:
			sb.WriteByte(alphabet[idx[0]])
			sb.WriteByte(alphabet[idx[1]])
			sb.WriteByte(alphabet[idx[2]])
			sb.WriteByte('=')
		default:
			for _, k := range idx {
				sb.WriteByte(alphabet[k])
			}
		}
	}
	return sb.String()
}

func rc4Variant(key []int, data []int) []int {
	sbox := make([]int, 256)
	for i := range sbox {
		sbox[i] = 255 - i
	}
	j := 0
	for i := range 256 {
		j = (j*sbox[i] + j + key[i%len(key)]) % 256
		sbox[i], sbox[j] = sbox[j], sbox[i]
	}
	out := make([]int, 0, len(data))
	i, j := 0, 0
	for _, b := range data {
		i = (i + 1) % 256
		j = (j + sbox[i]) % 256
		sbox[i], sbox[j] = sbox[j], sbox[i]
		out = append(out, b^sbox[(sbox[i]+sbox[j])%256])
	}
	return out
}

func strToBytes(s string) []byte {
	out := make([]byte, 0, len(s))
	for _, r := range s {
		c := int(r)
		if c&65280 != 0 {
			out = append(out, byte(c>>8), byte(c&255))
		} else {
			out = append(out, byte(c))
		}
	}
	return out
}

func leBytes(value int64, count int) []int {
	out := make([]int, count)
	for i := range count {
		out[i] = int((value >> uint(8*i)) & 255)
	}
	return out
}

func toInt32(x int) int {
	x &= 0xFFFFFFFF
	if x >= 0x80000000 {
		return x - 0x100000000
	}
	return x
}

func z146Blend(c0, c1 byte, r0, r1 byte) []byte {
	return []byte{
		(r0 & 170) | (c0 & 85),
		(r0 & 85) | (c0 & 170),
		(r1 & 170) | (c1 & 85),
		(r1 & 85) | (c1 & 170),
	}
}

func z148Expand(arr []int, randFn func() float64) []int {
	out := make([]int, 0, len(arr)+len(arr)/3)
	i := 0
	n := len(arr)
	for i < n {
		if i+2 < n {
			rnd := int(randFn()*1000) & 255
			b0 := (rnd & z148RMasks[0]) | (arr[i] & z148InMasks[0])
			b1 := (rnd & z148RMasks[1]) | (arr[i+1] & z148InMasks[1])
			b2 := (rnd & z148RMasks[2]) | (arr[i+2] & z148InMasks[2])
			b3 := (arr[i] & z148RMasks[0]) | (arr[i+1] & z148RMasks[1]) | (arr[i+2] & z148RMasks[2])
			out = append(out, b0, b1, b2, b3)
		} else {
			out = append(out, arr[i])
			if i+1 < n && arr[i+1] != 0 {
				out = append(out, arr[i+1])
			}
		}
		i += 3
	}
	return out
}

func escapeDigest(digest []byte, idx int, reserved, fallback byte, force bool) byte {
	var v byte
	if idx < len(digest) {
		v = digest[idx]
	} else {
		v = fallback
	}
	for v == reserved {
		idx++
		if idx < len(digest) {
			v = digest[idx]
		} else {
			v = fallback
		}
	}
	if force {
		return reserved
	}
	return v
}

var (
	reHuawei        = regexp.MustCompile(`(?i)\bhuawei\b`)
	reChromeUA      = regexp.MustCompile(`(?i)chrome/[\w.]+`)
	reEdge          = regexp.MustCompile(`(?i)(edg|edge)\/[\w.]+`)
	reFirefox       = regexp.MustCompile(`(?i)(firefox)\/([\w.]+)`)
	reFirefoxFocus  = regexp.MustCompile(`(?i)\bfocus\/([\w.]+)`)
	reFirefoxFxios  = regexp.MustCompile(`(?i)fxios\/([-\w.]+)`)
	reFirefoxMobile = regexp.MustCompile(`(?i)mobile vr; rv:([\w.]+)\).+firefox`)
	reIE            = regexp.MustCompile(`(?i)(msie |trident.*rv:)([\w.]+)`)
	reOpera         = regexp.MustCompile(`(?i)(opera|opr)\/([\w.]+)`)
	reSafariUA      = regexp.MustCompile(`(?i)safari/[\w.]+`)
)

// BrowserName classifies a User-Agent the same way the SDK's regex table does.
// Go's RE2 has no lookahead, so the Chrome/Safari negative checks are done
// explicitly against the lowercased UA.
func BrowserName(ua string) string {
	lower := strings.ToLower(ua)
	switch {
	case reHuawei.MatchString(ua):
		return "Huawei"
	case reChromeUA.MatchString(ua) && !strings.Contains(lower, "chromium"):
		return "Chrome"
	case reEdge.MatchString(ua):
		return "Edge"
	case reFirefox.MatchString(ua) || reFirefoxFocus.MatchString(ua) ||
		reFirefoxFxios.MatchString(ua) || reFirefoxMobile.MatchString(ua):
		return "Firefox"
	case reIE.MatchString(ua):
		return "IE"
	case reOpera.MatchString(ua):
		return "Opera"
	case reSafariUA.MatchString(ua) && !strings.Contains(lower, "chrome"):
		return "Safari"
	}
	return "Other"
}

func browserOffset(name string) int {
	switch name {
	case "Chrome":
		return 0
	case "Firefox":
		return 40
	case "Safari":
		return 81
	case "Edge":
		return 125
	case "Huawei":
		return 170
	}
	return 210
}

func z143RandOffset(r float64, name string) int {
	return int(r*40) + browserOffset(name)
}

func z144Check(r float64, flagsByte int) int {
	if flagsByte&64 != 0 {
		v := int(r * 109)
		return v + 110 + (v % 2)
	}
	v := int(r * 240)
	if v > 109 {
		return v + (v % 2) + 1
	}
	return v
}

func z145PermissionsBits(r float64) int {
	base := int(r*255) & 77
	return base | 2 | 16 | 32 | 128
}

func z149CounterBucket(counter int) int {
	switch {
	case counter > 10745:
		return 3
	case counter > 1283:
		return 4
	case counter > 139:
		return 5
	}
	return 6
}

func envFlagsByte(stackIsNode bool, ua string) int {
	flags := 1
	if stackIsNode {
		flags |= 1 << 2
	}
	if BrowserName(ua) == "Firefox" {
		flags |= 1 << 5
	}
	return flags
}

func intsToBytes(in []int) []byte {
	out := make([]byte, len(in))
	for i, v := range in {
		out[i] = byte(v)
	}
	return out
}

func intsFromBytes(in []byte) []int {
	out := make([]int, len(in))
	for i, v := range in {
		out[i] = int(v)
	}
	return out
}

func itoaSlice(vals []int) []string {
	out := make([]string, len(vals))
	for i, v := range vals {
		out[i] = itoa(v)
	}
	return out
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
