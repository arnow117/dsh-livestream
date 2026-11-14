package main

import "encoding/json"

var proposalJSONKeys = []string{
	"version", "transportKind", "buildDigest", "instanceId", "senderProcessNonce", "senderConnectionGeneration",
	"authorizationId", "captureId", "qualificationDigest", "qualificationRevision", "identityEpoch", "accountRecordId",
	"principalUid", "roomId", "platformRoomId", "helperProcessNonce", "authContextId", "authContextRevision", "materialDigest",
	"rawSourceSessionId", "rawSourceConnectionGeneration", "rawBrowserContextId", "roomBindingProofDigest", "inputConnectionGeneration",
	"liveEpoch", "liveEpochStartedAtMs",
}

func exactGrantJSON(raw json.RawMessage) bool {
	keys := append(append([]string{}, proposalJSONKeys...), "grantId", "authorizedAtMs")
	return factFields(raw, keys...)
}

func exactSendJSON(raw json.RawMessage) bool {
	if !factFields(raw, "requestId", "sourceKey", "requestHash", "sourceKind", "grant", "text") {
		return false
	}
	var fields map[string]json.RawMessage
	return json.Unmarshal(raw, &fields) == nil && exactGrantJSON(fields["grant"])
}

func exactReconcileJSON(raw json.RawMessage) bool {
	if !factFields(raw, "controlId", "ref", "factsRevision", "factsDigest", "facts", "originControlPayloadHash") {
		return false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil ||
		!factFields(fields["ref"], "requestId", "sourceKey", "requestHash", "helperPayloadHash", "textDigest", "grant") {
		return false
	}
	var ref map[string]json.RawMessage
	return json.Unmarshal(fields["ref"], &ref) == nil && exactGrantJSON(ref["grant"])
}
