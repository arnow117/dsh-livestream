package main

import (
	"io"
	"os"
	"syscall"
	"time"
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

func loadPrivateDeployment(file *os.File) (privateDeployment, error) {
	var deployment privateDeployment
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return deployment, syscall.EINVAL
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, file.Fd(), syscall.F_GETFL, 0)
	if !ok || stat.Nlink != 1 || stat.Uid != uint32(os.Getuid()) || errno != 0 || flags&syscall.O_ACCMODE != syscall.O_RDONLY {
		return deployment, syscall.EINVAL
	}
	if offset, err := file.Seek(0, io.SeekCurrent); err != nil || offset != 0 {
		return deployment, syscall.EINVAL
	}
	data, err := io.ReadAll(io.LimitReader(file, maxFrameBytes+1))
	if err != nil || len(data) > maxFrameBytes || decodeFrameStrict(data, &deployment) != nil {
		return privateDeployment{}, syscall.EINVAL
	}
	if !validDigest(deployment.BuildDigest) || !validIdentifier(deployment.InstanceID) ||
		!validIdentifier(deployment.SenderProcessNonce) || !validIdentifier(deployment.AccountRecordID) ||
		!validDecimal(deployment.PrincipalUID) || !validWebRoomID(deployment.RoomID) ||
		deployment.AuthContextRevision > 1<<53-1 {
		return privateDeployment{}, syscall.EINVAL
	}
	return deployment, nil
}

func main() {
	materialFD := os.NewFile(3, "material")
	deploymentFD := os.NewFile(4, "deployment")
	if materialFD == nil || deploymentFD == nil {
		os.Exit(1)
	}
	context, err := materialFromFD(materialFD, time.Now())
	materialCloseErr := materialFD.Close()
	if err != nil {
		deploymentFD.Close()
		os.Exit(1)
	}
	if materialCloseErr != nil {
		deploymentFD.Close()
		os.Exit(1)
	}
	deployment, err := loadPrivateDeployment(deploymentFD)
	deploymentCloseErr := deploymentFD.Close()
	if err != nil || deploymentCloseErr != nil {
		os.Exit(1)
	}
	fixed := helperFixedDeployment{buildDigest: deployment.BuildDigest, instanceID: deployment.InstanceID,
		senderNonce: deployment.SenderProcessNonce, accountRecordID: deployment.AccountRecordID,
		principalUID: deployment.PrincipalUID, roomID: deployment.RoomID}
	// No ready frame can be emitted until both fixed origins have resolved.
	// Background lookup is deliberately not abandoned by a timeout: if it
	// does not return, this helper never advertises readiness.
	targets, err := prepareFixedTargets(nil)
	if err != nil {
		os.Exit(1)
	}
	server := privateServer{authority: newHelperGrants(context, fixed, deployment.AuthContextRevision, time.Now, 1024), preparedTargets: targets}
	if err := server.serve(os.Stdin, os.Stdout); err != nil {
		os.Exit(1)
	}
}
