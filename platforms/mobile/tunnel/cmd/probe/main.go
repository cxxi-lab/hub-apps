// probe exercises the tunnel package from a desktop: tunnel up, exit IP,
// proxy auth enforced, then a few targets (YouTube player, hub API) through it.
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"hub.cxxi.io/mobile/tunnel"
)

func main() {
	confPath := flag.String("conf", os.ExpandEnv("$HOME/.config/hub-desktop/vpn.conf"), "WireGuard config")
	video := flag.String("video", "aqz-KE-bpKQ", "YouTube video id for the embed page")
	flag.Parse()

	conf, err := os.ReadFile(*confPath)
	if err != nil {
		log.Fatal(err)
	}

	start := time.Now()
	ep, err := tunnel.Start(string(conf))
	if err != nil {
		log.Fatal(err)
	}
	defer tunnel.Stop()
	fmt.Printf("tunnel up in %s, proxy %s:%d\n", time.Since(start).Round(time.Millisecond), ep.Host, ep.Port)

	// Nudge a handshake (WireGuard only initiates on outbound traffic) and wait for it.
	go client(ep, true).Get("https://1.1.1.1/")
	for i := 0; i < 50 && tunnel.LastHandshake() == 0; i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if hs := tunnel.LastHandshake(); hs == 0 {
		fmt.Printf("NO HANDSHAKE after 5s (endpoint unreachable, or keys rejected)\n\n")
	} else {
		fmt.Printf("handshake OK after %s\n\n", time.Since(start).Round(time.Millisecond))
	}

	direct := &http.Client{Timeout: 15 * time.Second}
	proxied := client(ep, true)

	get("exit IP (direct)  ", direct, "https://api.ipify.org")
	get("exit IP (tunnel)  ", proxied, "https://api.ipify.org")
	get("no credentials    ", client(ep, false), "https://api.ipify.org")
	get("plain HTTP        ", proxied, "http://neverssl.com/")
	get("YT iframe_api     ", proxied, "https://www.youtube.com/iframe_api")
	get("YT embed page     ", proxied, "https://www.youtube.com/embed/"+*video)
	get("YT player JS      ", proxied, playerJS(proxied, *video))
	get("hub API (tunnel)  ", proxied, "https://hub.cxxi.io/")
	get("hub API (direct)  ", direct, "https://hub.cxxi.io/")
}

func client(ep *tunnel.Endpoint, withAuth bool) *http.Client {
	u := &url.URL{Scheme: "http", Host: fmt.Sprintf("%s:%d", ep.Host, ep.Port)}
	if withAuth {
		u.User = url.UserPassword(ep.Username, ep.Password)
	}
	return &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(u)}}
}

// playerJS pulls the base.js URL out of the embed page, i.e. the actual player.
func playerJS(c *http.Client, video string) string {
	body, err := fetch(c, "https://www.youtube.com/embed/"+video)
	if err != nil {
		return ""
	}
	_, rest, ok := strings.Cut(body, `"jsUrl":"`)
	if !ok {
		return ""
	}
	path, _, _ := strings.Cut(rest, `"`)
	return "https://www.youtube.com" + path
}

func fetch(c *http.Client, u string) (string, error) {
	resp, err := c.Get(u)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return string(b), err
}

func get(label string, c *http.Client, u string) {
	if u == "" {
		fmt.Printf("%s SKIP (no URL)\n", label)
		return
	}
	t := time.Now()
	resp, err := c.Get(u)
	if err != nil {
		msg := err.Error()
		if len(msg) > 160 {
			msg = msg[:160] + "…"
		}
		fmt.Printf("%s ERR  %s\n", label, msg)
		return
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	extra := fmt.Sprintf("%d bytes", len(b))
	if len(b) < 40 {
		extra = strings.TrimSpace(string(b))
	}
	fmt.Printf("%s %d  %-8s %-14s %-28s %s\n", label, resp.StatusCode, time.Since(t).Round(time.Millisecond), extra, resp.Header.Get("Content-Type"), u)
}
