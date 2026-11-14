package main

import "testing"

func TestCanonicalHashMatchesJSONInNode(t *testing.T) {
	hash, err := canonicalHash(map[string]any{"z": "\u2028<&", "a": 42})
	if err != nil || hash != "b9467b97c28ca120a4a4316538474dc4625e3cde7b14dc17e5a111138c1866d9" {
		t.Fatal("canonical hash differs from Node fixture")
	}
}
