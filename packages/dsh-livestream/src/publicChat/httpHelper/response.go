package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"strings"
	"unicode/utf8"
)

const maxResponseBytes = 1 << 20
const maxJSONDepth = 32

func hexUnit(b []byte) (uint16, bool) {
	if len(b) != 4 {
		return 0, false
	}
	var value uint16
	for _, c := range b {
		value <<= 4
		switch {
		case c >= '0' && c <= '9':
			value |= uint16(c - '0')
		case c >= 'a' && c <= 'f':
			value |= uint16(c-'a') + 10
		case c >= 'A' && c <= 'F':
			value |= uint16(c-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}

// encoding/json replaces unpaired surrogate escapes with U+FFFD. Reject them
// before decoding so a malformed identity or status field cannot be repaired.
func validUnicodeEscapes(body []byte) bool {
	inside := false
	for i := 0; i < len(body); i++ {
		if !inside {
			if body[i] == '"' {
				inside = true
			}
			continue
		}
		if body[i] == '"' {
			inside = false
			continue
		}
		if body[i] != '\\' {
			continue
		}
		i++
		if i >= len(body) {
			return false
		}
		if body[i] != 'u' {
			continue
		}
		if i+4 >= len(body) {
			return false
		}
		unit, ok := hexUnit(body[i+1 : i+5])
		if !ok {
			return false
		}
		i += 4
		if unit >= 0xdc00 && unit <= 0xdfff {
			return false
		}
		if unit < 0xd800 || unit > 0xdbff {
			continue
		}
		if i+6 >= len(body) || body[i+1] != '\\' || body[i+2] != 'u' {
			return false
		}
		low, ok := hexUnit(body[i+3 : i+7])
		if !ok || low < 0xdc00 || low > 0xdfff {
			return false
		}
		i += 6
	}
	return !inside
}

func hasRiskField(value any) bool {
	switch item := value.(type) {
	case map[string]any:
		for key, child := range item {
			switch strings.ToLower(key) {
			case "error", "error_code", "error_msg", "risk", "risk_info", "risk_code", "captcha", "captcha_url", "verify", "verify_id", "challenge", "challenge_code":
				return true
			case "status_code":
				if child != json.Number("0") {
					return true
				}
			case "status_msg":
				if child != "" && child != "success" {
					return true
				}
			}
			if hasRiskField(child) {
				return true
			}
		}
	case []any:
		for _, child := range item {
			if hasRiskField(child) {
				return true
			}
		}
	}
	return false
}

// strictValue retains JSON numbers verbatim and rejects duplicate object keys
// at every depth. It is used only after the response byte limit is enforced.
func strictValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > maxJSONDepth {
		return nil, errors.New("response nesting exceeds limit")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return token, nil
	}
	switch delimiter {
	case '{':
		object := make(map[string]any)
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, errors.New("invalid response key")
			}
			if _, exists := object[key]; exists {
				return nil, errors.New("duplicate response key")
			}
			value, err := strictValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			object[key] = value
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return nil, errors.New("incomplete response object")
		}
		return object, nil
	case '[':
		array := make([]any, 0)
		for decoder.More() {
			value, err := strictValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return nil, errors.New("incomplete response array")
		}
		return array, nil
	default:
		return nil, errors.New("unexpected response delimiter")
	}
}

func parseResponseObject(status int, contentType string, body []byte) (map[string]any, bool) {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if status != 200 || err != nil || mediaType != "application/json" ||
		(params["charset"] != "" && params["charset"] != "utf-8") ||
		len(body) == 0 || len(body) > maxResponseBytes || !utf8.Valid(body) || !validUnicodeEscapes(body) {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	value, err := strictValue(decoder, 0)
	if err != nil {
		return nil, false
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, false
	}
	object, ok := value.(map[string]any)
	if !ok || object["status_code"] != json.Number("0") {
		return nil, false
	}
	if message, exists := object["status_msg"]; exists && message != "" && message != "success" {
		return nil, false
	}
	if hasRiskField(object) {
		return nil, false
	}
	return object, true
}

func isAPIReportedSuccess(status int, contentType string, body []byte) bool {
	_, ok := parseResponseObject(status, contentType, body)
	return ok
}
