package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestBoundedPrivateFrame(t *testing.T) {
	wire := privateFrame{Protocol: privateProtocol, Seq: 1, Kind: "hello", OperationID: "one", Payload: []byte(`{}`)}
	var buffer bytes.Buffer
	if err := writePrivateFrame(&buffer, wire); err != nil {
		t.Fatal(err)
	}
	got, err := readPrivateFrame(&buffer)
	if err != nil || got.Kind != "hello" || got.OperationID != "one" {
		t.Fatal("valid framed message did not round trip")
	}
	var tooLarge [4]byte
	binary.BigEndian.PutUint32(tooLarge[:], maxFrameBytes+1)
	if _, err := readPrivateFrame(bytes.NewReader(tooLarge[:])); err == nil {
		t.Fatal("oversized frame accepted")
	}
	for _, raw := range []string{
		`{"protocol":"dsh-public-chat-http-v1","protocol":"dsh-public-chat-http-v1","seq":1,"kind":"hello","operationId":"one","payload":{}}`,
		`{"protocol":"dsh-public-chat-http-v1","seq":1,"kind":"hello","operationId":"one","payload":{"x":"\ud800"}}`,
		`{"protocol":"other","seq":1,"kind":"hello","operationId":"one","payload":{}}`,
	} {
		var input bytes.Buffer
		_ = binary.Write(&input, binary.BigEndian, uint32(len(raw)))
		input.WriteString(raw)
		if _, err := readPrivateFrame(&input); err == nil {
			t.Fatal("invalid frame accepted")
		}
	}
}
