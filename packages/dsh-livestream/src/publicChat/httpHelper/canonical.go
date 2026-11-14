package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
)

func appendJSONString(out *strings.Builder, value string) {
	const digits = "0123456789abcdef"
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"', '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 {
				out.WriteString(`\u00`)
				out.WriteByte(digits[byte(r)>>4])
				out.WriteByte(digits[byte(r)&15])
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
}

func appendCanonical(out *strings.Builder, value any) error {
	switch item := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		out.WriteString(strconv.FormatBool(item))
	case string:
		appendJSONString(out, item)
	case json.Number:
		integer, err := strconv.ParseInt(string(item), 10, 64)
		if err != nil || integer < -(1<<53-1) || integer > 1<<53-1 || strconv.FormatInt(integer, 10) != string(item) {
			return errors.New("invalid canonical number")
		}
		out.WriteString(string(item))
	case []any:
		out.WriteByte('[')
		for i, child := range item {
			if i != 0 {
				out.WriteByte(',')
			}
			if err := appendCanonical(out, child); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(item))
		for key := range item {
			// Protocol object keys are an explicit ASCII schema. This avoids
			// differing UTF-16 versus UTF-8 key ordering across runtimes.
			for _, r := range key {
				if r > 0x7f {
					return errors.New("invalid canonical key")
				}
			}
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out.WriteByte('{')
		for i, key := range keys {
			if i != 0 {
				out.WriteByte(',')
			}
			appendJSONString(out, key)
			out.WriteByte(':')
			if err := appendCanonical(out, item[key]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		return errors.New("invalid canonical value")
	}
	return nil
}

func canonicalHash(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var object any
	if err = decoder.Decode(&object); err != nil {
		return "", err
	}
	var encoded strings.Builder
	if err = appendCanonical(&encoded, object); err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(encoded.String()))
	return hex.EncodeToString(sum[:]), nil
}
