// Package tunnel is the gomobile-facing envelope around wireproxy: it brings a
// WireGuard tunnel up in userspace (gVisor netstack, no VpnService) and serves
// an authenticated HTTP proxy on loopback that dials through it. The Android
// side points every WebView at that proxy with ProxyController.
//
// Only gomobile-compatible types cross the API (string, int, error, pointer to
// a struct of those), so `gomobile bind` exposes it as-is to Java.
package tunnel

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"

	"github.com/go-ini/ini"
	"github.com/windtf/wireproxy"
	"golang.zx2c4.com/wireguard/device"
)

const proxyUsername = "hub"

// Endpoint is what the caller needs to configure its proxy.
type Endpoint struct {
	Host     string
	Port     int
	Username string
	Password string
}

var (
	mu       sync.Mutex
	dev      *device.Device
	listener net.Listener
	current  *Endpoint
)

// Start parses a wg-quick style config (the content, not a path), brings the
// tunnel up and starts the proxy on a random loopback port. Calling it while
// already running returns the running endpoint.
func Start(wgConfig string) (*Endpoint, error) {
	mu.Lock()
	defer mu.Unlock()
	if current != nil {
		return current, nil
	}

	conf, err := parseConfig(wgConfig)
	if err != nil {
		return nil, fmt.Errorf("parse wireguard config: %w", err)
	}

	vt, err := wireproxy.StartWireguard(conf, device.LogLevelError)
	if err != nil {
		return nil, fmt.Errorf("start wireguard: %w", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		vt.Dev.Close()
		return nil, fmt.Errorf("listen: %w", err)
	}

	password, err := randomHex(24)
	if err != nil {
		_ = ln.Close()
		vt.Dev.Close()
		return nil, err
	}

	p := &proxy{dial: vt.Tnet.DialContext, username: proxyUsername, password: password}
	go p.serve(ln)

	dev, listener = vt.Dev, ln
	current = &Endpoint{
		Host:     "127.0.0.1",
		Port:     ln.Addr().(*net.TCPAddr).Port,
		Username: proxyUsername,
		Password: password,
	}
	return current, nil
}

// Stop closes the proxy and tears the tunnel down. Open connections die with it.
func Stop() error {
	mu.Lock()
	defer mu.Unlock()
	if current == nil {
		return nil
	}
	err := listener.Close()
	dev.Close()
	dev, listener, current = nil, nil, nil
	return err
}

// Running reports whether the tunnel is up.
func Running() bool {
	mu.Lock()
	defer mu.Unlock()
	return current != nil
}

// parseConfig mirrors wireproxy.ParseConfig minus the file path and the
// routines section: the proxy is ours, not wireproxy's.
func parseConfig(content string) (*wireproxy.Configuration, error) {
	cfg, err := ini.LoadSources(ini.LoadOptions{
		Insensitive:            true,
		AllowShadows:           true,
		AllowNonUniqueSections: true,
	}, []byte(content))
	if err != nil {
		return nil, err
	}

	dc := &wireproxy.DeviceConfig{MTU: 1420}
	if err := wireproxy.ParseInterface(cfg, dc); err != nil {
		return nil, err
	}
	if err := wireproxy.ParsePeers(cfg, &dc.Peers); err != nil {
		return nil, err
	}
	if len(dc.Peers) == 0 {
		return nil, errors.New("no [Peer] section")
	}

	return &wireproxy.Configuration{
		Device:  dc,
		Resolve: &wireproxy.ResolveConfig{ResolveStrategy: "auto"},
	}, nil
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// LastHandshake returns the unix time of the latest WireGuard handshake, 0 if
// none yet (or not running). It is the only real "connected" signal: Start
// succeeds even when the endpoint never answers.
func LastHandshake() int {
	mu.Lock()
	defer mu.Unlock()
	if dev == nil {
		return 0
	}
	state, err := dev.IpcGet()
	if err != nil {
		return 0
	}
	latest := 0
	for _, line := range strings.Split(state, "\n") {
		if v, ok := strings.CutPrefix(line, "last_handshake_time_sec="); ok {
			if n, err := strconv.Atoi(v); err == nil && n > latest {
				latest = n
			}
		}
	}
	return latest
}
