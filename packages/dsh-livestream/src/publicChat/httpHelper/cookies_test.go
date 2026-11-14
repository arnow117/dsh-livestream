package main

import "testing"

func validCookie(name, value string) cookieMaterial {
	yes, no := true, false
	return cookieMaterial{Name: name, Value: value, Domain: ".douyin.com", Path: "/", Secure: &yes,
		HTTPOnly: &yes, SameSite: "Lax", ExpiresAtMs: 2000, HostOnly: &no, Partitioned: &no}
}

func TestFrozenCookiesOwnsAndOrdersInput(t *testing.T) {
	input := []cookieMaterial{validCookie("z", "one"), validCookie("a", "two")}
	frozen, err := freezeCookies(input, 1000)
	if err != nil {
		t.Fatal(err)
	}
	input[1].Value = "changed"
	*input[1].Secure = false
	if frozen.header != "a=two; z=one" || frozen.entries[0].Value != "two" || !*frozen.entries[0].Secure {
		t.Fatal("frozen cookie data changed with caller input")
	}
}

func TestCookieScopeFailsClosed(t *testing.T) {
	tests := []struct {
		name string
		edit func(*cookieMaterial)
	}{
		{"domain", func(c *cookieMaterial) { c.Domain = "live.douyin.com" }},
		{"path", func(c *cookieMaterial) { c.Path = "/other" }},
		{"secure", func(c *cookieMaterial) { *c.Secure = false }},
		{"missing httpOnly", func(c *cookieMaterial) { c.HTTPOnly = nil }},
		{"missing hostOnly", func(c *cookieMaterial) { c.HostOnly = nil }},
		{"host only", func(c *cookieMaterial) { *c.HostOnly = true }},
		{"partitioned", func(c *cookieMaterial) { *c.Partitioned = true }},
		{"expired", func(c *cookieMaterial) { c.ExpiresAtMs = 1000 }},
		{"unknown same site", func(c *cookieMaterial) { c.SameSite = "" }},
		{"control character", func(c *cookieMaterial) { c.Value = "a\nb" }},
		{"separator", func(c *cookieMaterial) { c.Value = "a;b" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cookie := validCookie("fixture", "value")
			test.edit(&cookie)
			if _, err := freezeCookies([]cookieMaterial{cookie}, 1000); err == nil {
				t.Fatal("invalid cookie was accepted")
			}
		})
	}
	if _, err := freezeCookies([]cookieMaterial{validCookie("same", "one"), validCookie("same", "two")}, 1000); err == nil {
		t.Fatal("duplicate cookie was accepted")
	}
}

func TestFrozenCookieExpiryIsRechecked(t *testing.T) {
	frozen, err := freezeCookies([]cookieMaterial{validCookie("fixture", "value")}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if !frozen.validAt(1999) || frozen.validAt(2000) || frozen.validAt(0) {
		t.Fatal("cookie expiry boundary was not enforced")
	}
}
