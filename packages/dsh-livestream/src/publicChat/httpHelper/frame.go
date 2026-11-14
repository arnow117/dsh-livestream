package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

const privateProtocol = "dsh-public-chat-http-v1"
const maxFrameBytes = 64 << 10

type privateFrame struct {
	Protocol            string          `json:"protocol"`
	Seq                 uint64          `json:"seq"`
	Kind                string          `json:"kind"`
	OperationID         string          `json:"operationId"`
	PayloadHash         string          `json:"payloadHash"`
	ExpectedHelperNonce string          `json:"expectedHelperNonce"`
	AuthContextID       string          `json:"authContextId"`
	AuthContextRevision uint64          `json:"authContextRevision"`
	MaterialDigest      string          `json:"materialDigest"`
	Payload             json.RawMessage `json:"payload"`
}

func decodeFrameStrict(data []byte, target any) error {
	if len(data) == 0 || len(data) > maxFrameBytes || !utf8.Valid(data) || !validUnicodeEscapes(data) {
		return errors.New("invalid frame")
	}
	check := json.NewDecoder(bytes.NewReader(data))
	check.UseNumber()
	if _, err := strictValue(check, 0); err != nil {
		return errors.New("invalid frame")
	}
	if _, err := check.Token(); err != io.EOF {
		return errors.New("invalid frame")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("invalid frame")
	}
	return nil
}

// A four-byte big-endian length precedes each UTF-8 JSON frame. Material is
// never carried here; it arrives only through the inherited material FD.
func readPrivateFrame(reader io.Reader) (privateFrame, error) {
	var prefix [4]byte
	if _, err := io.ReadFull(reader, prefix[:]); err != nil {
		return privateFrame{}, err
	}
	size := binary.BigEndian.Uint32(prefix[:])
	if size == 0 || size > maxFrameBytes {
		return privateFrame{}, errors.New("invalid frame length")
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(reader, data); err != nil {
		return privateFrame{}, err
	}
	var frame privateFrame
	if err := decodeFrameStrict(data, &frame); err != nil {
		return privateFrame{}, err
	}
	if frame.Protocol != privateProtocol || frame.Seq == 0 || frame.Seq > 1<<53-1 || !validIdentifier(frame.Kind) ||
		!validIdentifier(frame.OperationID) || len(frame.Payload) == 0 {
		return privateFrame{}, errors.New("invalid frame envelope")
	}
	return frame, nil
}

func writePrivateFrame(writer io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil || len(data) == 0 || len(data) > maxFrameBytes {
		return errors.New("invalid response frame")
	}
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(len(data)))
	for _, part := range [][]byte{prefix[:], data} {
		for len(part) > 0 {
			n, err := writer.Write(part)
			if err != nil {
				return err
			}
			if n <= 0 || n > len(part) {
				return io.ErrShortWrite
			}
			part = part[n:]
		}
	}
	return nil
}
