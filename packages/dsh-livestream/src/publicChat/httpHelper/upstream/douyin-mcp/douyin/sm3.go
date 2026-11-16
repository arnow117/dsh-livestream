package douyin

// SM3 hash (GB/T 32905-2016). The a_bogus signature depends on it.

var sm3IV = [8]uint32{
	0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
	0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
}

func sm3Rotl(x uint32, n uint) uint32 {
	n &= 31
	if n == 0 {
		return x
	}
	return (x << n) | (x >> (32 - n))
}

func sm3Tj(j int) uint32 {
	if j < 16 {
		return 0x79CC4519
	}
	return 0x7A879D8A
}

func sm3FF(x, y, z uint32, j int) uint32 {
	if j < 16 {
		return x ^ y ^ z
	}
	return (x & y) | (x & z) | (y & z)
}

func sm3GG(x, y, z uint32, j int) uint32 {
	if j < 16 {
		return x ^ y ^ z
	}
	return (x & y) | (^x & z)
}

func sm3P0(x uint32) uint32 { return x ^ sm3Rotl(x, 9) ^ sm3Rotl(x, 17) }
func sm3P1(x uint32) uint32 { return x ^ sm3Rotl(x, 15) ^ sm3Rotl(x, 23) }

func sm3CF(v *[8]uint32, block []byte) {
	var w [68]uint32
	for i := range 16 {
		w[i] = uint32(block[i*4])<<24 | uint32(block[i*4+1])<<16 |
			uint32(block[i*4+2])<<8 | uint32(block[i*4+3])
	}
	for j := 16; j < 68; j++ {
		w[j] = sm3P1(w[j-16]^w[j-9]^sm3Rotl(w[j-3], 15)) ^
			sm3Rotl(w[j-13], 7) ^ w[j-6]
	}
	var w1 [64]uint32
	for j := range 64 {
		w1[j] = w[j] ^ w[j+4]
	}

	a, b, c, d, e, f, g, h := v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]
	for j := range 64 {
		ss1 := sm3Rotl(sm3Rotl(a, 12)+e+sm3Rotl(sm3Tj(j), uint(j)), 7)
		ss2 := ss1 ^ sm3Rotl(a, 12)
		tt1 := sm3FF(a, b, c, j) + d + ss2 + w1[j]
		tt2 := sm3GG(e, f, g, j) + h + ss1 + w[j]
		d = c
		c = sm3Rotl(b, 9)
		b = a
		a = tt1
		h = g
		g = sm3Rotl(f, 19)
		f = e
		e = sm3P0(tt2)
	}

	v[0] ^= a
	v[1] ^= b
	v[2] ^= c
	v[3] ^= d
	v[4] ^= e
	v[5] ^= f
	v[6] ^= g
	v[7] ^= h
}

// sm3Hash returns the 32-byte SM3 digest of msg.
func sm3Hash(msg []byte) []byte {
	bitLen := uint64(len(msg)) * 8
	buf := make([]byte, 0, len(msg)+72)
	buf = append(buf, msg...)
	buf = append(buf, 0x80)
	for len(buf)%64 != 56 {
		buf = append(buf, 0x00)
	}
	for i := 7; i >= 0; i-- {
		buf = append(buf, byte(bitLen>>(8*uint(i))))
	}

	v := sm3IV
	for i := 0; i < len(buf); i += 64 {
		sm3CF(&v, buf[i:i+64])
	}

	out := make([]byte, 0, 32)
	for _, x := range v {
		out = append(out, byte(x>>24), byte(x>>16), byte(x>>8), byte(x))
	}
	return out
}
