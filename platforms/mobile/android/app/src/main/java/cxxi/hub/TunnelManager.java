package cxxi.hub;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.HttpAuthHandler;

import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Authenticator;
import java.net.InetSocketAddress;
import java.net.PasswordAuthentication;
import java.net.Proxy;
import java.net.URL;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import cxxi.hub.tunnel.Endpoint;
import cxxi.hub.tunnel.Tunnel;

/**
 * The embedded WireGuard tunnel (mobile/tunnel, Go → tunnel.aar), the mobile
 * counterpart of desktop's bundled wireproxy. The Go side brings WireGuard up in
 * userspace and serves an authenticated HTTP proxy on loopback (random port and
 * credentials); this class points every WebView of the process at it through
 * ProxyController, answers the proxy's 407 and exposes the same status shape as
 * desktop's VpnManager (disabled / starting / connected / error).
 *
 * It runs only while a hubby going out through the VPN is open (the web side's TunnelGate starts it
 * on entering, stops it on leaving): the whole app then goes through it (ProxyController is the
 * process's), its sites and the API alike; while it comes up or if it fails, every request is
 * blocked. Otherwise, no override: the app talks to hubbyware.cxxi.io directly.
 *
 * The config is the user's own wg-quick file, one per hubby going out through the VPN, kept
 * encrypted by VpnConfigs (the hubby's settings › VPN). It must route everything
 * (AllowedIPs = 0.0.0.0/0): the tunnel is userspace, a split-tunnel config
 * drops DNS and the public hubbyware.cxxi.io address.
 */
final class TunnelManager {

    static final String TAG = "hub-tunnel";
    /** Realm sent by mobile/tunnel/proxy.go in its 407. */
    private static final String PROXY_REALM = "hub";

    interface Listener {
        void onChange(Status status);
    }

    static final class Status {
        final String status;
        final Integer port;
        final String error;
        final String endpoint;
        /** the hubby the tunnel runs for (its config, VpnConfigs) */
        final String hubby;

        Status(String status, Integer port, String error, String endpoint, String hubby) {
            this.status = status;
            this.port = port;
            this.error = error;
            this.endpoint = endpoint;
            this.hubby = hubby;
        }
    }

    private static final TunnelManager INSTANCE = new TunnelManager();

    static TunnelManager get() {
        return INSTANCE;
    }

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private volatile Status status = new Status("disabled", null, null, null, null);
    /** the hubby the tunnel runs (or last ran) for */
    private volatile String hubby;
    private volatile Endpoint endpoint;

    private TunnelManager() {
        // Answers the proxy's 407 for native HTTP (see open()). The proxy keeps
        // the connection open after a 407 so HttpURLConnection can retry there.
        Authenticator.setDefault(new Authenticator() {
            @Override
            protected PasswordAuthentication getPasswordAuthentication() {
                Endpoint ep = endpoint;
                if (ep == null || getRequestorType() != RequestorType.PROXY) return null;
                return new PasswordAuthentication(ep.getUsername(), ep.getPassword().toCharArray());
            }
        });
    }

    Status status() {
        return status;
    }

    void addListener(Listener l) {
        listeners.add(l);
    }

    void removeListener(Listener l) {
        listeners.remove(l);
    }

    /** the tunnel's native library is loaded (once per process) */
    private boolean nativeLoaded = false;

    /**
     * Loads the tunnel's native library, which the APK doesn't carry: the platform downloads it
     * (TunnelComponent, pinned by its sha256). The Java side (go.Seq, rebuilt) loads the path given
     * in the "cxxi.hub.gojni" property.
     */
    private boolean loadNative(Context context) {
        if (nativeLoaded) return true;
        File lib = TunnelComponent.ensure(context);
        if (lib == null) return false;
        try {
            System.setProperty("cxxi.hub.gojni", lib.getAbsolutePath());
            Tunnel.touch();
            nativeLoaded = true;
            return true;
        } catch (Throwable e) {
            Log.e(TAG, "the tunnel's native library didn't load", e);
            return false;
        }
    }

    /**
     * Starts the tunnel for a hubby, with its config (VpnConfigs; null: the first hubby going out
     * through the VPN), async. One tunnel at a time: one running for another hubby is stopped
     * first. No config → disabled.
     */
    void start(Context context, String named) {
        start(context, named, false);
    }

    /** `restart`: even when it runs for that hubby already (its config changed). */
    void start(Context context, String named, boolean restart) {
        final String wanted = named != null ? named : VpnConfigs.defaultHubby();
        boolean running = "connected".equals(status.status) || "starting".equals(status.status);
        if (running && !restart && wanted != null && wanted.equals(hubby)) return;
        if (running) stop();
        hubby = wanted;
        final Context app = context.getApplicationContext();
        executor.execute(() -> {
            // Nothing goes out before the tunnel is up (Private's sites, its API): blocked meanwhile,
            // and still blocked if it can't come up.
            try {
                applyBlackhole();
            } catch (Exception e) {
                Log.e(TAG, "blackhole failed", e);
            }
            final String text = wanted != null ? VpnConfigs.read(app, wanted) : null;
            if (text == null) {
                setStatus("disabled", null, "no WireGuard config: add yours in the hubby's settings (VPN)", null);
                return;
            }
            if (!loadNative(app)) {
                setStatus("error", null, "the VPN tunnel couldn't be installed on this device", null);
                return;
            }
            try {
                String peer = parseEndpoint(text);
                setStatus("starting", null, null, peer);
                Endpoint ep = Tunnel.start(text);
                endpoint = ep;
                applyProxy(ep);
                setStatus("connected", (int) ep.getPort(), null, peer);
            } catch (Exception e) {
                Log.e(TAG, "start failed", e);
                // Don't leave a tunnel up that no WebView is pointed at (the blackhole stays).
                try {
                    if (nativeLoaded) Tunnel.stop();
                } catch (Exception ignored) {
                }
                endpoint = null;
                setStatus("error", null, e.getMessage(), status.endpoint);
            }
        });
    }

    /** Stops the tunnel and lifts the proxy override (async). */
    void stop() {
        executor.execute(() -> {
            clearProxy();
            try {
                if (nativeLoaded) Tunnel.stop();
            } catch (Exception e) {
                Log.w(TAG, "stop failed", e);
            }
            endpoint = null;
            setStatus("disabled", null, null, status.endpoint);
        });
    }

    /**
     * Routes a native HttpURLConnection (the APK updater) through the tunnel; the
     * WebView proxy override doesn't apply to it. Opens the connection directly
     * when the tunnel is down. The proxy's 407 is answered by the default
     * Authenticator set up in the constructor (Android doesn't carry a
     * Proxy-Authorization request header into the CONNECT).
     */
    URLConnection open(URL url) throws IOException {
        Endpoint ep = endpoint;
        if (ep == null) return url.openConnection();
        return url.openConnection(new Proxy(Proxy.Type.HTTP, new InetSocketAddress(ep.getHost(), (int) ep.getPort())));
    }

    /** Answers the loopback proxy's 407 for a WebView; anything else is refused. */
    void handleAuth(HttpAuthHandler handler, String host, String realm) {
        Endpoint ep = endpoint;
        if (ep != null && PROXY_REALM.equals(realm)) {
            handler.proceed(ep.getUsername(), ep.getPassword());
            return;
        }
        Log.w(TAG, "auth challenge refused: host=" + host + " realm=" + realm);
        handler.cancel();
    }

    private void applyProxy(Endpoint ep) throws Exception {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            throw new Exception("this WebView can't override its proxy (PROXY_OVERRIDE unsupported)");
        }
        // Everything goes through the tunnel, no bypass and no direct fallback
        // rule: if the tunnel dies, requests fail instead of leaking.
        ProxyConfig config = new ProxyConfig.Builder()
            .addProxyRule("http://" + ep.getHost() + ":" + ep.getPort())
            .build();
        onMainThreadAndWait("set proxy override", done ->
            ProxyController.getInstance().setProxyOverride(config, Runnable::run, done));
        Log.i(TAG, "proxy override -> " + ep.getHost() + ":" + ep.getPort());
    }

    /** While the tunnel isn't up: every WebView request fails rather than leaving from the real IP. */
    private void applyBlackhole() throws Exception {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return;
        ProxyConfig config = new ProxyConfig.Builder()
            // port 1: nothing listens there (unbindable by an app)
            .addProxyRule("http://127.0.0.1:1")
            .build();
        onMainThreadAndWait("set blackhole proxy", done ->
            ProxyController.getInstance().setProxyOverride(config, Runnable::run, done));
        Log.i(TAG, "proxy override -> blackhole");
    }

    private void clearProxy() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return;
        try {
            onMainThreadAndWait("clear proxy override", done ->
                ProxyController.getInstance().clearProxyOverride(Runnable::run, done));
            Log.i(TAG, "proxy override cleared");
        } catch (Exception e) {
            Log.w(TAG, "clear proxy override failed", e);
        }
    }

    private interface ProxyCall {
        void run(Runnable done);
    }

    /**
     * ProxyController must be called on the main thread: off it, at cold start,
     * Chromium isn't initialised yet and throws "Must be started before we
     * block!". Runs `call` there and blocks this (tunnel executor) thread until
     * the override is in effect, so "connected" means requests do go through.
     */
    private void onMainThreadAndWait(String what, ProxyCall call) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<RuntimeException> failure = new AtomicReference<>();
        mainHandler.post(() -> {
            try {
                call.run(latch::countDown);
            } catch (RuntimeException e) {
                failure.set(e);
                latch.countDown();
            }
        });
        if (!latch.await(10, TimeUnit.SECONDS)) throw new Exception(what + ": timed out");
        if (failure.get() != null) throw failure.get();
    }

    private void setStatus(String s, Integer port, String error, String peer) {
        status = new Status(s, port, error, peer, hubby);
        Log.i(TAG, "status " + s + (error != null ? " (" + error + ")" : ""));
        for (Listener l : listeners) l.onChange(status);
    }

    /** First `Endpoint = host:port` of the config, shown in Settings like desktop. */
    static String parseEndpoint(String conf) {
        Matcher m = Pattern.compile("(?im)^\\s*Endpoint\\s*=\\s*(\\S+)").matcher(conf);
        return m.find() ? m.group(1) : null;
    }

    static String readFile(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            return readAll(in);
        }
    }

    static String readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return out.toString(StandardCharsets.UTF_8.name());
    }
}
