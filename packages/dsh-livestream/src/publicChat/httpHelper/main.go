package main

import (
	"encoding/json"
	"io"
	"os"
	"syscall"
	"time"

	"github.com/yunsur/douyin-mcp/douyin"
)

type privateDeployment struct {
	BuildDigest         string `json:"buildDigest"`
	InstanceID          string `json:"instanceId"`
	SenderProcessNonce  string `json:"senderProcessNonce"`
	AccountRecordID     string `json:"accountRecordId"`
	PrincipalUID        string `json:"principalUid"`
	RoomID              string `json:"roomId"`
	AuthContextRevision uint64 `json:"authContextRevision"`
}

func readPrivateDeployment(file *os.File) ([]byte, error) {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return nil, syscall.EINVAL
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, file.Fd(), syscall.F_GETFL, 0)
	if !ok || stat.Nlink != 1 || stat.Uid != uint32(os.Getuid()) || errno != 0 || flags&syscall.O_ACCMODE != syscall.O_RDONLY {
		return nil, syscall.EINVAL
	}
	if offset, err := file.Seek(0, io.SeekCurrent); err != nil || offset != 0 {
		return nil, syscall.EINVAL
	}
	data, err := io.ReadAll(io.LimitReader(file, maxFrameBytes+1))
	if err != nil || len(data) > maxFrameBytes {
		return nil, syscall.EINVAL
	}
	return data, nil
}

func decodePrivateDeployment(data []byte) (privateDeployment, error) {
	var deployment privateDeployment
	if decodeFrameStrict(data, &deployment) != nil || !validDigest(deployment.BuildDigest) || !validIdentifier(deployment.InstanceID) ||
		!validIdentifier(deployment.SenderProcessNonce) || !validIdentifier(deployment.AccountRecordID) ||
		!validDecimal(deployment.PrincipalUID) || !validWebRoomID(deployment.RoomID) || deployment.AuthContextRevision > 1<<53-1 {
		return privateDeployment{}, syscall.EINVAL
	}
	return deployment, nil
}

func loadPrivateDeployment(file *os.File) (privateDeployment, error) {
	data, err := readPrivateDeployment(file)
	if err != nil {
		return privateDeployment{}, err
	}
	return decodePrivateDeployment(data)
}

type sessionPrivateDeployment struct {
	SchemaVersion       uint64 `json:"schemaVersion"`
	TransportKind       string `json:"transportKind"`
	BuildDigest         string `json:"buildDigest"`
	InstanceID          string `json:"instanceId"`
	SenderProcessNonce  string `json:"senderProcessNonce"`
	AccountRecordID     string `json:"accountRecordId"`
	RoomID              string `json:"roomId"`
	AuthContextRevision uint64 `json:"authContextRevision"`
}

func decodeSessionPrivateDeployment(data []byte) (sessionPrivateDeployment, error) {
	var value sessionPrivateDeployment
	if decodeFrameStrict(data, &value) != nil || value.SchemaVersion != 2 || value.TransportKind != "session_http" ||
		!validDigest(value.BuildDigest) || !validIdentifier(value.InstanceID) || !validIdentifier(value.SenderProcessNonce) ||
		!validIdentifier(value.AccountRecordID) || !validWebRoomID(value.RoomID) || value.AuthContextRevision > 1<<53-1 {
		return sessionPrivateDeployment{}, syscall.EINVAL
	}
	return value, nil
}

func main() {
	deploymentFD := os.NewFile(4, "deployment")
	if deploymentFD == nil {
		os.Exit(1)
	}
	data, err := readPrivateDeployment(deploymentFD)
	closeErr := deploymentFD.Close()
	if err != nil || closeErr != nil {
		os.Exit(1)
	}
	var envelope map[string]json.RawMessage
	if decodeFrameStrict(data, &envelope) != nil {
		os.Exit(1)
	}
	var server privateServer
	if _, sessionMode := envelope["schemaVersion"]; sessionMode {
		deployment, err := decodeSessionPrivateDeployment(data)
		if err != nil {
			os.Exit(1)
		}
		nonce, err := randomSessionID()
		if err != nil {
			os.Exit(1)
		}
		context, err := newUnauthenticatedContext(nonce)
		if err != nil {
			os.Exit(1)
		}
		fixed := helperFixedDeployment{buildDigest: deployment.BuildDigest, instanceID: deployment.InstanceID,
			senderNonce: deployment.SenderProcessNonce, accountRecordID: deployment.AccountRecordID, roomID: deployment.RoomID}
		server.authority = newHelperGrants(context, fixed, deployment.AuthContextRevision, time.Now, 1024)
		server.session = newSessionAuth(server.authority, func() (*douyin.Client, *sessionTransport, error) { return newSessionClient(nil) })
		server.session.viewState.Revision = deployment.AuthContextRevision
	} else {
		deployment, err := decodePrivateDeployment(data)
		if err != nil {
			os.Exit(1)
		}
		materialFD := os.NewFile(3, "material")
		if materialFD == nil {
			os.Exit(1)
		}
		context, err := materialFromFD(materialFD, time.Now())
		closeErr := materialFD.Close()
		if err != nil || closeErr != nil {
			os.Exit(1)
		}
		fixed := helperFixedDeployment{buildDigest: deployment.BuildDigest, instanceID: deployment.InstanceID,
			senderNonce: deployment.SenderProcessNonce, accountRecordID: deployment.AccountRecordID,
			principalUID: deployment.PrincipalUID, roomID: deployment.RoomID}
		server.authority = newHelperGrants(context, fixed, deployment.AuthContextRevision, time.Now, 1024)
	}
	server.preparedTargets, err = prepareFixedTargets(nil)
	if err != nil {
		os.Exit(1)
	}
	if err := server.serve(os.Stdin, os.Stdout); err != nil {
		os.Exit(1)
	}
}
