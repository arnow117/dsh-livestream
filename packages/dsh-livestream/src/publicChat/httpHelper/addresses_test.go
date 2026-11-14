package main

import (
	"errors"
	"net/netip"
	"testing"
	"time"
)

func TestPrepareFixedTargetsDoesNotReturnWhileResolverIsUnfinished(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		_, err := prepareFixedTargets(func(string) ([]netip.Addr, error) {
			select {
			case <-entered:
			default:
				close(entered)
			}
			<-release
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		})
		finished <- err
	}()
	<-entered
	select {
	case <-finished:
		t.Fatal("preparation returned before the original resolver finished")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}

func TestPrepareFixedTargetsResolvesOriginsOnce(t *testing.T) {
	counts := make(map[string]int)
	resolve := func(host string) ([]netip.Addr, error) {
		counts[host]++
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}
	targets, err := prepareFixedTargets(resolve)
	if err != nil || len(targets) != 3 || counts["www.douyin.com"] != 1 || counts["live.douyin.com"] != 1 {
		t.Fatal("fixed origins were not prepared exactly once")
	}
	for _, target := range targets {
		if target.address != "127.0.0.1:443" || target.serverName != target.originHost {
			t.Fatal("prepared target lost fixed origin or numeric address")
		}
	}
}

func TestPrepareFixedTargetsRefusesMissingAddress(t *testing.T) {
	for _, resolve := range []func(string) ([]netip.Addr, error){
		func(string) ([]netip.Addr, error) { return nil, errors.New("unavailable") },
		func(string) ([]netip.Addr, error) { return []netip.Addr{netip.IPv4Unspecified()}, nil },
	} {
		if targets, err := prepareFixedTargets(resolve); err == nil || targets != nil {
			t.Fatal("failed address preparation was published")
		}
	}
}
