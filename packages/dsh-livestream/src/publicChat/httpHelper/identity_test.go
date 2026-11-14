package main

import "testing"

func TestQueryUserIdentityPreservesUint64(t *testing.T) {
	tests := []struct {
		name, body, expected string
		want                 bool
	}{
		{"uint64 number", `{"status_code":0,"user_uid":18446744073709551615}`, "18446744073709551615", true},
		{"string", `{"status_code":0,"user_uid":"00042"}`, "42", true},
		{"overflow", `{"status_code":0,"user_uid":18446744073709551616}`, "18446744073709551615", false},
		{"rounded number", `{"status_code":0,"user_uid":9007199254740993}`, "9007199254740992", false},
		{"fraction", `{"status_code":0,"user_uid":42.0}`, "42", false},
		{"negative", `{"status_code":0,"user_uid":-42}`, "42", false},
		{"zero", `{"status_code":0,"user_uid":0}`, "0", false},
		{"invalid unicode", `{"status_code":0,"user_uid":"42","x":"\ud800"}`, "42", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, got := queryUserIdentity(200, "application/json", []byte(test.body), test.expected)
			if got != test.want {
				t.Fatalf("got %v, want %v", got, test.want)
			}
		})
	}
}
