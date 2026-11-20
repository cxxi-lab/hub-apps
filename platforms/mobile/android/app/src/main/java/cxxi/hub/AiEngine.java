package cxxi.hub;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.IBinder;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

/**
 * The local AI engine on Android, app side (the desktop's main/ai/engine.ts): one server at a time
 * in the AI process ({@link AiService}), started for a spec (an engine and its arguments), reused
 * while the same spec is asked again, replaced otherwise; requests go to it over 127.0.0.1.
 */
final class AiEngine {
    private static final String TAG = "AiEngine";
    private static final AiEngine INSTANCE = new AiEngine();
    private static final long START_TIMEOUT_MS = 180_000;

    static AiEngine get() { return INSTANCE; }

    /** What to run: an engine and its model arguments (the port, the key and the threads are added). */
    static final class Spec {
        final String engine;
        final List<String> args;
        Spec(String engine, List<String> args) { this.engine = engine; this.args = args; }
        String key() { return engine + "\n" + String.join("\n", args); }
    }

    private String runningKey;
    private int port;
    private String token;
    private ServiceConnection connection;

    private AiEngine() {}

    /** The threads a model gets: the cores but two (the app and the system keep some). */
    static int threads() {
        return Math.max(1, Runtime.getRuntime().availableProcessors() - 2);
    }

    /** The spec's server, running and healthy (blocking: off the main thread). */
    synchronized void use(Context context, Spec spec) throws IOException {
        if (spec.key().equals(runningKey)) return;
        stop(context);
        File library = AiEngineComponent.ensure(context, spec.engine);
        port = freePort();
        token = randomToken();
        List<String> args = new ArrayList<>(spec.args);
        args.add("--host"); args.add("127.0.0.1");
        args.add("--port"); args.add(String.valueOf(port));
        // the text server takes a key and its threads (the voice server has neither: its own defaults)
        if ("text".equals(spec.engine)) {
            args.add("-t"); args.add(String.valueOf(threads()));
            args.add("--api-key"); args.add(token);
            args.add("--no-webui");
        } else {
            token = null;
        }
        Intent intent = new Intent(context, AiService.class)
            .putExtra(AiService.EXTRA_ENGINE, spec.engine)
            .putExtra(AiService.EXTRA_LIBRARY, library.getAbsolutePath())
            .putExtra(AiService.EXTRA_ARGS, args.toArray(new String[0]));
        ServiceConnection c = new ServiceConnection() {
            @Override public void onServiceConnected(ComponentName name, IBinder service) {}
            @Override public void onServiceDisconnected(ComponentName name) {
                Log.w(TAG, "the AI process ended");
                synchronized (AiEngine.this) { if (connection == this) { runningKey = null; } }
            }
        };
        if (!context.getApplicationContext().bindService(intent, c, Context.BIND_AUTO_CREATE)) throw new IOException("the AI process couldn't start");
        connection = c;
        long until = System.currentTimeMillis() + START_TIMEOUT_MS;
        while (System.currentTimeMillis() < until) {
            try {
                if (status("GET", "/health") == 200) {
                    runningKey = spec.key();
                    Log.i(TAG, spec.engine + " engine ready on " + port);
                    return;
                }
            } catch (IOException ignored) {
                // not listening yet
            }
            try { Thread.sleep(300); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
        }
        stop(context);
        throw new IOException("the " + spec.engine + " engine didn't start (see logcat AiEngine/" + spec.engine + ")");
    }

    /** The running server stopped (its process ends). */
    synchronized void stop(Context context) {
        if (connection != null) {
            try { context.getApplicationContext().unbindService(connection); } catch (IllegalArgumentException ignored) {}
        }
        connection = null;
        runningKey = null;
    }

    private int status(String method, String path) throws IOException {
        HttpURLConnection c = open(method, path);
        try { return c.getResponseCode(); } finally { c.disconnect(); }
    }

    private HttpURLConnection open(String method, String path) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection(java.net.Proxy.NO_PROXY);
        c.setRequestMethod(method);
        c.setConnectTimeout(2000);
        c.setReadTimeout(600_000);
        if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    private final java.util.concurrent.locks.ReentrantLock busy = new java.util.concurrent.locks.ReentrantLock(true);

    interface Work<T> { T run() throws Exception; }

    /**
     * The spec's server, held for `work` (the desktop's localEngine.use): another spec waits until
     * it ends, then replaces it — never cut in the middle of an answer.
     */
    <T> T with(Context context, Spec spec, Work<T> work) throws Exception {
        busy.lockInterruptibly();
        try {
            use(context, spec);
            return work.run();
        } finally {
            busy.unlock();
        }
    }

    /** A JSON POST to the running server, sent; the connection to read (inside with()). */
    HttpURLConnection post(String path, String json) throws IOException {
        String key;
        synchronized (this) {
            if (runningKey == null) throw new IOException("no AI engine running");
            key = runningKey;
        }
        HttpURLConnection c = open("POST", path);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = c.getOutputStream()) { out.write(json.getBytes(StandardCharsets.UTF_8)); }
        return c;
    }

    /** A JSON request to the running server; its body (blocking). */
    synchronized byte[] request(String path, String json) throws IOException {
        if (runningKey == null) throw new IOException("no AI engine running");
        HttpURLConnection c = open("POST", path);
        try {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = c.getOutputStream()) { out.write(json.getBytes(StandardCharsets.UTF_8)); }
            int code = c.getResponseCode();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            if (in != null) {
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) > 0) body.write(buffer, 0, n);
            }
            if (code >= 400) throw new IOException("the engine answered " + code + ": " + body.toString("UTF-8"));
            return body.toByteArray();
        } finally {
            c.disconnect();
        }
    }

    private static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) { return s.getLocalPort(); }
    }

    private static String randomToken() {
        byte[] b = new byte[24];
        new SecureRandom().nextBytes(b);
        StringBuilder hex = new StringBuilder();
        for (byte x : b) hex.append(String.format("%02x", x));
        return hex.toString();
    }
}
