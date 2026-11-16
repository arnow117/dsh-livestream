package douyin

// Ordered query-parameter builder. Douyin's signatures hash the query in the
// exact order the browser sends it, so a plain Go map is not usable here.

import (
	"maps"
	"slices"
	"strings"
)

// Params is an insertion-ordered string map.
type Params struct {
	keys   []string
	values map[string]string
}

// NewParams creates an empty ordered parameter set.
func NewParams() *Params {
	return &Params{values: map[string]string{}}
}

// Add appends key=value (or replaces in place if key already exists).
func (p *Params) Add(key, value string) *Params {
	if _, ok := p.values[key]; !ok {
		p.keys = append(p.keys, key)
	}
	p.values[key] = value
	return p
}

// Merge adds all params from other, preserving other's order.
func (p *Params) Merge(other *Params) *Params {
	for _, k := range other.keys {
		p.Add(k, other.values[k])
	}
	return p
}

// Get returns the value for key.
func (p *Params) Get(key string) (string, bool) {
	v, ok := p.values[key]
	return v, ok
}

// Del removes a key.
func (p *Params) Del(key string) {
	if _, ok := p.values[key]; !ok {
		return
	}
	delete(p.values, key)
	for i, k := range p.keys {
		if k == key {
			p.keys = append(p.keys[:i], p.keys[i+1:]...)
			break
		}
	}
}

// Keys returns the ordered key list.
func (p *Params) Keys() []string { return p.keys }

// Len returns the number of params.
func (p *Params) Len() int { return len(p.keys) }

// ToString joins k=v pairs verbatim (browser query order, no re-encoding).
func (p *Params) ToString() string {
	var sb strings.Builder
	for i, k := range p.keys {
		if i > 0 {
			sb.WriteByte('&')
		}
		sb.WriteString(k)
		sb.WriteByte('=')
		sb.WriteString(p.values[k])
	}
	return sb.String()
}

// SpliceURL builds the query string: every value is
// percent-encoded with an empty safe set (JS encodeURIComponent-ish for the
// bytes that matter; '/' becomes %2F).
func (p *Params) SpliceURL() string {
	parts := make([]string, 0, len(p.keys))
	for _, k := range p.keys {
		parts = append(parts, k+"="+quoteStrict(p.values[k]))
	}
	return strings.Join(parts, "&")
}

// quoteStrict percent-encodes everything except A-Za-z0-9 - _ . ~ (the
// encodeURIComponent-safe set minus the extra JS-safe chars that never appear
// in these values).
func quoteStrict(s string) string {
	const upperhex = "0123456789ABCDEF"
	var sb strings.Builder
	for i := range len(s) {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			sb.WriteByte(c)
			continue
		}
		sb.WriteByte('%')
		sb.WriteByte(upperhex[c>>4])
		sb.WriteByte(upperhex[c&15])
	}
	return sb.String()
}

// Clone returns a deep copy.
func (p *Params) Clone() *Params {
	out := NewParams()
	out.keys = slices.Clone(p.keys)
	maps.Copy(out.values, p.values)
	return out
}
