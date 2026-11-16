package cxxi.hub;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.LruCache;

import java.io.InputStream;
import java.net.URL;
import java.net.URLConnection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Video posters for the native player (cover while a page loads, neighbours
 * sliding in on a swipe), fetched through the tunnel like everything else and
 * kept in memory. Callbacks run on the main thread.
 */
final class PosterCache {

    interface Callback {
        void onPoster(Bitmap bitmap);
    }

    private static final String TAG = "hub-player";
    private static final LruCache<String, Bitmap> CACHE = new LruCache<String, Bitmap>(24 * 1024 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) {
            return value.getByteCount();
        }
    };
    private static final ExecutorService EXECUTOR = Executors.newFixedThreadPool(3);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    /** Callbacks waiting on a fetch in flight, by URL (one fetch per URL). */
    private static final Map<String, List<Callback>> PENDING = new HashMap<>();

    private PosterCache() {
    }

    /** Main thread. Calls back at once when cached, later when fetched, never on failure. */
    static void get(String url, Callback callback) {
        if (url == null) return;
        Bitmap cached = CACHE.get(url);
        if (cached != null) {
            if (callback != null) callback.onPoster(cached);
            return;
        }
        List<Callback> waiting = PENDING.get(url);
        if (waiting != null) {
            if (callback != null) waiting.add(callback);
            return;
        }
        waiting = new ArrayList<>();
        if (callback != null) waiting.add(callback);
        PENDING.put(url, waiting);
        EXECUTOR.execute(() -> {
            Bitmap bitmap = fetch(url);
            MAIN.post(() -> {
                List<Callback> callbacks = PENDING.remove(url);
                if (bitmap == null || callbacks == null) return;
                CACHE.put(url, bitmap);
                for (Callback c : callbacks) c.onPoster(bitmap);
            });
        });
    }

    /** Fetches ahead, for posters a swipe may need soon. */
    static void preload(String url) {
        get(url, null);
    }

    private static Bitmap fetch(String url) {
        try {
            URLConnection conn = TunnelManager.get().open(new URL(url));
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(15_000);
            try (InputStream in = conn.getInputStream()) {
                return BitmapFactory.decodeStream(in);
            }
        } catch (Exception e) {
            Log.w(TAG, "poster failed: " + url + " (" + e.getMessage() + ")");
            return null;
        }
    }
}
