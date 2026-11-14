package main

import (
	"strings"
	"testing"
)

func TestAPIReportedSuccessStrictResponse(t *testing.T) {
	tests := []struct {
		name   string
		status int
		typeOf string
		body   string
		want   bool
	}{
		{"valid", 200, "application/json", `{"status_code":0,"status_msg":"success"}`, true},
		{"http failure", 500, "application/json", `{"status_code":0}`, false},
		{"wrong type", 200, "text/html", `{"status_code":0}`, false},
		{"string code", 200, "application/json", `{"status_code":"0"}`, false},
		{"fraction code", 200, "application/json", `{"status_code":0.0}`, false},
		{"missing code", 200, "application/json", `{}`, false},
		{"duplicate nested", 200, "application/json", `{"status_code":0,"x":{"a":1,"a":2}}`, false},
		{"duplicate status", 200, "application/json", `{"status_code":0,"status_code":1}`, false},
		{"trailing", 200, "application/json", `{"status_code":0}{}`, false},
		{"risk", 200, "application/json", `{"status_code":0,"risk":{}}`, false},
		{"contradictory message", 200, "application/json", `{"status_code":0,"status_msg":"failed"}`, false},
		{"invalid utf8", 200, "application/json", "{\"status_code\":0,\"x\":\"\xff\"}", false},
		{"unpaired high surrogate", 200, "application/json", `{"status_code":0,"x":"\ud800"}`, false},
		{"unpaired low surrogate", 200, "application/json", `{"status_code":0,"x":"\udc00"}`, false},
		{"valid surrogate pair", 200, "application/json", `{"status_code":0,"x":"\ud83d\ude00"}`, true},
		{"escaped slash before u", 200, "application/json", `{"status_code":0,"x":"\\ud800"}`, true},
		{"nested challenge", 200, "application/json", `{"status_code":0,"data":{"challenge":true}}`, false},
		{"nested nonzero status", 200, "application/json", `{"status_code":0,"data":{"status_code":1}}`, false},
		{"too deep", 200, "application/json", `{"status_code":0,"x":` + strings.Repeat("[", 34) + "0" + strings.Repeat("]", 34) + "}", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isAPIReportedSuccess(test.status, test.typeOf, []byte(test.body)); got != test.want {
				t.Fatalf("got %v, want %v", got, test.want)
			}
		})
	}
}
