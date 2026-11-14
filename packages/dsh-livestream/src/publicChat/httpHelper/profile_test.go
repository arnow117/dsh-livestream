package main

import (
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestFrozenProfileGrantAndChatTLSFixture(t *testing.T) {
	var profiles, queries, chats atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "fixture=value" {
			t.Error("frozen cookie missing from fixture request")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/aweme/v1/web/user/profile/self/":
			profiles.Add(1)
			_, _ = io.WriteString(w, `{"status_code":0,"user":{"uid":"42"}}`)
		case "/aweme/v1/web/query/user/":
			queries.Add(1)
			_, _ = io.WriteString(w, `{"status_code":0,"user_uid":42}`)
		case "/webcast/room/chat/":
			chats.Add(1)
			if r.URL.Query().Get("room_id") != "202" || r.Header.Get("Referer") != "https://live.douyin.com/101" {
				t.Error("incorrect fixed room mapping")
			}
			_, _ = io.WriteString(w, `{"status_code":0}`)
		default:
			t.Error("unexpected fixture path")
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	authority, proposal := grantFixture(t)
	authority.qualification = nil
	profileTarget := fixtureTarget(server)
	profileTarget.originHost = "www.douyin.com"
	profileTarget.path = "/aweme/v1/web/user/profile/self/"
	queryTarget := profileTarget
	queryTarget.path = "/aweme/v1/web/query/user/"
	record, err := authority.captureProfile(profileRequest{CaptureID: proposal.CaptureID, HelperNonce: proposal.HelperProcessNonce,
		QualificationRevision: 1, IdentityEpoch: 1}, profileTarget, queryTarget)
	if err != nil || record.state != "qualified" || record.qualification == nil {
		t.Fatal("fixture profile did not qualify")
	}
	proposal.QualificationDigest = record.qualification.digest
	committed, err := authority.bind(proposal)
	if err != nil || committed.grant == nil || committed.state != "authorized" {
		t.Fatal("fixture grant did not commit")
	}
	boundary, _, err := authority.beginSend("message", "source", strings.Repeat("d", 64), *committed.grant)
	if err != nil {
		t.Fatal(err)
	}
	request, err := buildFixedRequest(authority.context, "chat", committed.grant, "fixture", authority.now())
	if err != nil {
		t.Fatal(err)
	}
	chatTarget := fixtureTarget(server)
	chatTarget.originHost, chatTarget.path = "live.douyin.com", "/webcast/room/chat/"
	work := newSyncHTTPWork(boundary)
	if !authority.attachSyncWork("message", boundary, work) {
		t.Fatal("original message could not own its worker")
	}
	work.start(chatTarget, request, 2*time.Second, nil)
	awaitSignal(t, work.done, "chat worker")
	if work.result.err != nil || !isAPIReportedSuccess(work.result.status, work.result.contentType, work.result.body) {
		t.Fatal("fixture response failed strict checks")
	}
	if _, err = authority.finishSend("message", boundary); err != nil {
		t.Fatal(err)
	}
	if _, err = authority.revoke(helperRevoke{ID: "revoke", HelperNonce: proposal.HelperProcessNonce,
		Kind: "authorization", TargetID: proposal.AuthorizationID, GrantID: committed.grant.GrantID}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = authority.beginSend("new-message", "new-source", strings.Repeat("e", 64), *committed.grant); err == nil {
		t.Fatal("revoked grant started a new send")
	}
	if profiles.Load() != 1 || queries.Load() != 1 || chats.Load() != 1 {
		t.Fatal("unexpected fixture request count")
	}
}

func TestProfileRevokeDuringResponseCannotPublish(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var queries atomic.Int32
	server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/aweme/v1/web/user/profile/self/" {
			close(entered)
			<-release
		} else {
			queries.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status_code":0,"user_uid":42}`)
	}))
	defer server.Close()
	authority, proposal := grantFixture(t)
	authority.qualification = nil
	profileTarget := fixtureTarget(server)
	profileTarget.originHost, profileTarget.path = "www.douyin.com", "/aweme/v1/web/user/profile/self/"
	queryTarget := profileTarget
	queryTarget.path = "/aweme/v1/web/query/user/"
	result := make(chan grantRecord, 1)
	go func() {
		record, _ := authority.captureProfile(profileRequest{CaptureID: proposal.CaptureID,
			HelperNonce: proposal.HelperProcessNonce, QualificationRevision: 1, IdentityEpoch: 1}, profileTarget, queryTarget)
		result <- record
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("profile fixture did not receive request")
	}
	_, err := authority.revoke(helperRevoke{ID: "cancel", HelperNonce: proposal.HelperProcessNonce,
		Kind: "capture", TargetID: proposal.CaptureID})
	close(release)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case record := <-result:
		if record.state != "revoked" || authority.qualification != nil || queries.Load() != 0 {
			t.Fatal("revoked capture published or started the second request")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("profile operation did not finish")
	}
}

func TestProfileResponseFaultDoesNotQualifyOrReplay(t *testing.T) {
	for _, failedPath := range []string{"/aweme/v1/web/user/profile/self/", "/aweme/v1/web/query/user/"} {
		t.Run(failedPath, func(t *testing.T) {
			var profiles, queries, unexpected atomic.Int32
			server := newOwnedTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/aweme/v1/web/user/profile/self/":
					profiles.Add(1)
				case "/aweme/v1/web/query/user/":
					queries.Add(1)
				default:
					unexpected.Add(1)
				}
				if r.URL.Path == failedPath {
					connection, buffer, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					_, _ = buffer.WriteString("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{")
					_ = buffer.Flush()
					_ = connection.Close()
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"status_code":0}`)
			}))
			defer server.Close()
			authority, proposal := grantFixture(t)
			authority.qualification = nil
			profileTarget := fixtureTarget(server)
			profileTarget.originHost, profileTarget.path = "www.douyin.com", "/aweme/v1/web/user/profile/self/"
			queryTarget := profileTarget
			queryTarget.path = "/aweme/v1/web/query/user/"
			request := profileRequest{CaptureID: proposal.CaptureID, HelperNonce: proposal.HelperProcessNonce,
				QualificationRevision: 1, IdentityEpoch: 1}
			for attempt := 0; attempt < 2; attempt++ {
				record, err := authority.captureProfile(request, profileTarget, queryTarget)
				if err != nil || record.state != "rejected" || authority.qualification != nil {
					t.Fatal("failed profile was qualified or not recorded")
				}
			}
			expectedQueries := int32(0)
			if failedPath == "/aweme/v1/web/query/user/" {
				expectedQueries = 1
			}
			if profiles.Load() != 1 || queries.Load() != expectedQueries || unexpected.Load() != 0 {
				t.Fatal("failed profile retried or requested an unexpected endpoint")
			}
		})
	}
}

func TestCompletedProfileCancellationDoesNotReplayQualified(t *testing.T) {
	authority, proposal := grantFixture(t)
	request := profileRequest{CaptureID: proposal.CaptureID, HelperNonce: proposal.HelperProcessNonce, QualificationRevision: 1, IdentityEpoch: 1}
	hash, _ := canonicalHash(request)
	authority.records[request.CaptureID] = grantRecord{kind: "profile", hash: hash,
		state: "qualified", qualification: authority.qualification}
	if _, err := authority.revoke(helperRevoke{ID: "cancel", HelperNonce: proposal.HelperProcessNonce,
		Kind: "capture", TargetID: proposal.CaptureID}); err != nil {
		t.Fatal(err)
	}
	result, err := authority.captureProfile(request, tlsTarget{}, tlsTarget{})
	if err != nil || result.state != "revoked" || authority.qualification != nil {
		t.Fatal("completed cancelled capture replayed as qualified")
	}
}
