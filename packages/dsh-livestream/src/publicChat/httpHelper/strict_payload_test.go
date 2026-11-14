package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRecoveryPayloadRequiresZeroValuedGrantFields(t *testing.T) {
	authority, proposal := grantFixture(t)
	proposal.SenderConnectionGeneration = 0
	committed, err := authority.bind(proposal)
	if err != nil || committed.grant == nil {
		t.Fatal("fixture grant unavailable")
	}
	request := helperMessageReconcile{ControlID: "control", Ref: messageRef{RequestID: "message", SourceKey: "source",
		RequestHash: strings.Repeat("a", 64), HelperPayloadHash: strings.Repeat("b", 64), TextDigest: strings.Repeat("c", 64),
		Grant: *committed.grant}, FactsRevision: 0, Facts: []json.RawMessage{}, OriginControlPayloadHash: strings.Repeat("d", 64)}
	request.FactsDigest, _ = canonicalHash(request.Facts)
	raw, err := json.Marshal(request)
	if err != nil || !exactReconcileJSON(raw) {
		t.Fatal("complete original reference was rejected")
	}
	var object map[string]any
	if json.Unmarshal(raw, &object) != nil {
		t.Fatal("fixture decode failed")
	}
	ref := object["ref"].(map[string]any)
	grant := ref["grant"].(map[string]any)
	delete(grant, "senderConnectionGeneration")
	incomplete, _ := json.Marshal(object)
	if exactReconcileJSON(incomplete) {
		t.Fatal("missing zero-valued grant field was accepted")
	}
}
