package main

import (
	"encoding/json"
	"strconv"
)

// principalUID uses the original JSON number token; it never crosses float64.
func principalUID(value any) (string, bool) {
	var raw string
	switch uid := value.(type) {
	case json.Number:
		raw = string(uid)
	case string:
		raw = uid
	default:
		return "", false
	}
	if len(raw) == 0 || len(raw) > 20 {
		return "", false
	}
	for _, c := range raw {
		if c < '0' || c > '9' {
			return "", false
		}
	}
	number, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || number == 0 {
		return "", false
	}
	return strconv.FormatUint(number, 10), true
}

func queryUserIdentity(status int, contentType string, body []byte, expected string) (string, bool) {
	object, ok := parseResponseObject(status, contentType, body)
	if !ok {
		return "", false
	}
	uid, ok := principalUID(object["user_uid"])
	if !ok || uid != expected {
		return "", false
	}
	return uid, true
}
