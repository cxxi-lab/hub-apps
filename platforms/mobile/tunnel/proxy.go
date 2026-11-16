package tunnel

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"
)

const (
	dialTimeout = 15 * time.Second
	// A client answering a 407 retries at once; these bound a connection that never authenticates.
	maxAuthAttempts = 3
	authReadTimeout = 30 * time.Second
)

// proxy is a minimal HTTP proxy: CONNECT for HTTPS (everything a WebView does
// that matters) plus one-shot plain HTTP. Unlike wireproxy's, it never exits the
// process on error and its listener can be closed.
type proxy struct {
	dial     func(ctx context.Context, network, address string) (net.Conn, error)
	username string
	password string
}

func (p *proxy) serve(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return // listener closed by Stop
		}
		go p.handle(conn)
	}
}

func (p *proxy) handle(conn net.Conn) {
	rd := bufio.NewReader(conn)
	req := p.readAuthorized(conn, rd)
	if req == nil {
		_ = conn.Close()
		return
	}

	addr := req.Host
	if _, _, err := net.SplitHostPort(addr); err != nil {
		if req.Method == http.MethodConnect {
			addr = net.JoinHostPort(addr, "443")
		} else {
			addr = net.JoinHostPort(addr, "80")
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	peer, err := p.dial(ctx, "tcp", addr)
	cancel()
	if err != nil {
		log.Printf("[tunnel] dial %s: %v", addr, err)
		_, _ = io.WriteString(conn, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
		_ = conn.Close()
		return
	}

	if req.Method == http.MethodConnect {
		if _, err := io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
			_ = conn.Close()
			_ = peer.Close()
			return
		}
	} else {
		// One request per connection keeps every request authenticated and on
		// the right host; plain HTTP is only there for probes anyway.
		req.Header.Del("Proxy-Authorization")
		req.Header.Del("Proxy-Connection")
		req.Close = true
		if err := req.Write(peer); err != nil {
			_ = conn.Close()
			_ = peer.Close()
			return
		}
	}

	// rd, not conn: the client may already have pipelined bytes (TLS ClientHello).
	go pipe(peer, rd, conn, peer)
	pipe(conn, peer, conn, peer)
}

// readAuthorized reads requests until one carries valid credentials. A 407
// keeps the connection open, as standard proxies do: Android's
// HttpURLConnection retries the CONNECT with credentials on the same socket,
// and closing it there fails the request ("unexpected end of stream"). Gives up
// after a few unauthenticated attempts or an idle client.
func (p *proxy) readAuthorized(conn net.Conn, rd *bufio.Reader) *http.Request {
	for attempt := 0; attempt < maxAuthAttempts; attempt++ {
		_ = conn.SetReadDeadline(time.Now().Add(authReadTimeout))
		req, err := http.ReadRequest(rd)
		_ = conn.SetReadDeadline(time.Time{})
		if err != nil {
			return nil
		}
		if p.authorized(req) {
			return req
		}
		_, _ = io.Copy(io.Discard, req.Body)
		_ = req.Body.Close()
		if _, err := io.WriteString(conn, "HTTP/1.1 407 Proxy Authentication Required\r\n"+
			"Proxy-Authenticate: Basic realm=\"hub\"\r\nContent-Length: 0\r\n\r\n"); err != nil {
			return nil
		}
	}
	return nil
}

func (p *proxy) authorized(req *http.Request) bool {
	enc, ok := strings.CutPrefix(req.Header.Get("Proxy-Authorization"), "Basic ")
	if !ok {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return false
	}
	user, pass, ok := strings.Cut(string(raw), ":")
	if !ok {
		return false
	}
	u := subtle.ConstantTimeCompare([]byte(user), []byte(p.username))
	pw := subtle.ConstantTimeCompare([]byte(pass), []byte(p.password))
	return u&pw == 1
}

func pipe(dst io.Writer, src io.Reader, a, b net.Conn) {
	_, _ = io.Copy(dst, src)
	_ = a.Close()
	_ = b.Close()
}
