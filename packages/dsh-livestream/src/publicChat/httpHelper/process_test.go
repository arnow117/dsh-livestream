package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPrivateHelperProcessHello(t *testing.T) {
	binaryPath := os.Getenv("DSH_HELPER_FIXTURE_BINARY")
	if binaryPath == "" {
		t.Skip("matching helper binary not supplied")
	}
	root := t.TempDir()
	materialPath := filepath.Join(root, "material")
	deploymentPath := filepath.Join(root, "deployment")
	if err := os.WriteFile(materialPath, fixtureMaterial(t, time.Now().Truncate(time.Second)), 0600); err != nil {
		t.Fatal(err)
	}
	deployment := privateDeployment{BuildDigest: strings.Repeat("a", 64), InstanceID: "fixture-instance",
		SenderProcessNonce: "fixture-sender", AccountRecordID: "fixture-record", PrincipalUID: "42", RoomID: "101", AuthContextRevision: 1}
	deploymentBytes, err := json.Marshal(deployment)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(deploymentPath, deploymentBytes, 0600); err != nil {
		t.Fatal(err)
	}
	material, err := os.Open(materialPath)
	if err != nil {
		t.Fatal(err)
	}
	defer material.Close()
	config, err := os.Open(deploymentPath)
	if err != nil {
		t.Fatal(err)
	}
	defer config.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binaryPath)
	command.Env = []string{}
	command.ExtraFiles = []*os.File{material, config}
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	defer func() {
		if !waited {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	if err = writePrivateFrame(input, privateFrame{Protocol: privateProtocol, Seq: 1, Kind: "hello", OperationID: "hello", Payload: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	var prefix [4]byte
	if _, err = io.ReadFull(output, prefix[:]); err != nil {
		t.Fatal(err)
	}
	size := binary.BigEndian.Uint32(prefix[:])
	if size == 0 || size > maxFrameBytes {
		t.Fatal("invalid helper response frame")
	}
	body := make([]byte, size)
	if _, err = io.ReadFull(output, body); err != nil {
		t.Fatal(err)
	}
	var response struct {
		Status       string `json:"status"`
		HelperNonce  string `json:"helperNonce"`
		AuthContext  string `json:"authContextId"`
		MaterialHash string `json:"materialDigest"`
	}
	if json.Unmarshal(body, &response) != nil || response.Status != "ready" || response.HelperNonce == "" ||
		response.AuthContext == "" || !validDigest(response.MaterialHash) {
		t.Fatal("helper hello response invalid")
	}
	input.Close()
	err = command.Wait()
	waited = true
	if err != nil {
		t.Fatal("helper did not exit cleanly")
	}
	t.Logf("owned-helper-pid=%d reaped", command.Process.Pid)
}
