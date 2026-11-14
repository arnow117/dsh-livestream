package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
)

// prepareFixedTargets resolves each fixed origin once, before the helper can
// become ready. A returned target contains one numeric address and has no
// retry or address-refresh path. The resolver is private wiring for tests.
func prepareFixedTargets(resolve func(string) ([]netip.Addr, error)) (map[string]tlsTarget, error) {
	if resolve == nil {
		resolve = func(host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(context.Background(), "ip", host)
		}
	}
	prepared := make(map[string]netip.Addr)
	targets := make(map[string]tlsTarget)
	for _, operation := range []string{"profile_self", "query_user", "chat"} {
		target, err := productionTarget(operation)
		if err != nil {
			return nil, err
		}
		address, found := prepared[target.originHost]
		if !found {
			addresses, err := resolve(target.originHost)
			if err != nil {
				return nil, errors.New("fixed origin resolution unavailable")
			}
			for _, candidate := range addresses {
				candidate = candidate.Unmap()
				if candidate.IsValid() && !candidate.IsUnspecified() && candidate.Zone() == "" {
					address = candidate
					break
				}
			}
			if !address.IsValid() {
				return nil, errors.New("fixed origin resolution unavailable")
			}
			prepared[target.originHost] = address
		}
		target.address = netip.AddrPortFrom(address, 443).String()
		targets[operation] = target
	}
	return targets, nil
}
