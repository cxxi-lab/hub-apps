package cxxi.hub;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Hosts the native player blocks (ads, trackers): without it a site's player
 * waits on its ad sequence and never starts the video. The list is compiled by
 * the back from public domain blocklists and pushed by the web layer
 * (platform.setPlayerBlocklist); desktop applies the same one. Persisted in the
 * app's files dir so it holds across restarts.
 */
final class PlayerBlocklist {

    private static final String TAG = "hub-blocklist";
    private static final String FILE = "player-blocklist.txt";

    private static PlayerBlocklist instance;

    static synchronized PlayerBlocklist get(Context context) {
        if (instance == null) instance = new PlayerBlocklist(new File(context.getApplicationContext().getFilesDir(), FILE));
        return instance;
    }

    private final File file;
    private volatile String version;
    private volatile Set<String> hosts = Collections.emptySet();

    private PlayerBlocklist(File file) {
        this.file = file;
        load();
    }

    String version() {
        return version;
    }

    /** Is `host` listed, itself or through a parent domain (a.b.example.com → example.com)? */
    boolean isBlocked(String host) {
        Set<String> set = hosts;
        if (host == null || set.isEmpty()) return false;
        for (String h = host; ; h = h.substring(h.indexOf('.') + 1)) {
            if (set.contains(h)) return true;
            if (h.indexOf('.') < 0) return false;
        }
    }

    synchronized void replace(String newVersion, List<String> newHosts) {
        Set<String> set = new HashSet<>(newHosts);
        try (Writer w = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) {
            w.write("# version " + newVersion + "\n");
            for (String h : newHosts) w.write(h + "\n");
        } catch (Exception e) {
            Log.w(TAG, "failed to persist", e);
        }
        hosts = set;
        version = newVersion;
        Log.i(TAG, "updated: " + set.size() + " hosts (version " + newVersion + ")");
    }

    private void load() {
        if (!file.exists()) return;
        try (BufferedReader r = new BufferedReader(new FileReader(file))) {
            String header = r.readLine();
            if (header == null || !header.startsWith("# version ")) return;
            Set<String> set = new HashSet<>();
            String line;
            while ((line = r.readLine()) != null) {
                if (!line.isEmpty()) set.add(line);
            }
            hosts = set;
            version = header.substring(10);
            Log.i(TAG, set.size() + " hosts (version " + version + ")");
        } catch (Exception e) {
            Log.w(TAG, "failed to load", e);
        }
    }
}
