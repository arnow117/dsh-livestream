package douyin

// X-Bogus signature. Used by the live WebSocket handshake.

import (
	"crypto/md5"
	"encoding/hex"
	"strings"
)

const xbogusAlphabet = "Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe"

func xb64Custom(data []byte) string { return b64Custom(data, xbogusAlphabet) }

func rc4Classic(key []byte, data []byte) []byte {
	sbox := make([]int, 256)
	for i := range sbox {
		sbox[i] = i
	}
	j := 0
	for i := range 256 {
		j = (j + sbox[i] + int(key[i%len(key)])) & 255
		sbox[i], sbox[j] = sbox[j], sbox[i]
	}
	out := make([]byte, 0, len(data))
	i, j := 0, 0
	for _, b := range data {
		i = (i + 1) & 255
		j = (j + sbox[i]) & 255
		sbox[i], sbox[j] = sbox[j], sbox[i]
		out = append(out, b^byte(sbox[(sbox[i]+sbox[j])&255]))
	}
	return out
}

func rand255(r float64) byte { return byte(int(255*r) & 255) }

// XbogusSigner generates X-Bogus tokens with an incrementing counter.
type XbogusSigner struct {
	counter  int
	envFlags byte
}

// NewXbogusSigner builds a signer for the Chrome/desktop environment used by
// the live WebSocket client.
func NewXbogusSigner() *XbogusSigner {
	return &XbogusSigner{counter: 0, envFlags: xbEnvFlags(false, true, true)}
}

func xbEnvFlags(browserFirefox, topLevel, geometrySane bool) byte {
	var flags byte = 1
	if browserFirefox {
		flags |= 1 << 5
	}
	if !topLevel {
		flags |= 1 << 6
	}
	if !geometrySane {
		flags |= 1 << 7
	}
	return flags
}

func (s *XbogusSigner) signStub(stubHex, payload string) string {
	inner := md5.Sum([]byte(payload))
	h1 := md5.Sum(inner[:])
	stub, _ := hex.DecodeString(stubHex)
	h2 := md5.Sum(stub)
	s.counter++
	c := s.counter
	plain := []byte{
		byte(c & 0x3F),
		byte((c >> 8) & 255),
		s.envFlags,
		4 | 8,
		h1[14], h1[15],
		h2[14], h2[15],
		rand255(randFloat()),
	}
	var chk byte
	for _, b := range plain {
		chk ^= b
	}
	keyByte := rand255(randFloat())
	cipher := rc4Classic([]byte{keyByte}, append(plain, chk))
	eef := byte((1 << 6) | ((int(100*randFloat()) & 1) << 4))
	out := append([]byte{eef, keyByte}, cipher...)
	return xb64Custom(out)
}

// Signature computes the live-room X-Bogus for (roomID, userUniqueID).
func (s *XbogusSigner) Signature(roomID, userUniqueID string) string {
	raw := "live_id=1,aid=6383,version_code=180800,webcast_sdk_version=1.0.15," +
		"room_id=" + roomID + ",sub_room_id=,sub_channel_id=,did_rule=3," +
		"user_unique_id=" + userUniqueID + ",device_platform=web,device_type=," +
		"ac=,identity=audience"
	sum := md5.Sum([]byte(raw))
	return s.signStub(hex.EncodeToString(sum[:]), "")
}

func trimStr(s string) string { return strings.TrimSpace(s) }
