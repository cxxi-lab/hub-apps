package cxxi.hub;

import android.content.Context;
import android.util.Log;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The hubbies of this device, apart from the app — the Android twin of the desktop's hubby
 * manager (desktop/src/main/hubbies/manager.ts):
 *  - a hubby is installed on demand: its newest version compatible with this APK's SDK is
 *    downloaded into files/hubbies/&lt;id&gt;/&lt;version&gt;/, every file checked against the
 *    catalogue (whose signature the web layer verified, see app/src/platform/capacitorHubbies.ts),
 *    and usable at once;
 *  - an installed hubby's newer versions are downloaded in the background; which version each
 *    one runs is decided once, at start (no half-updated session);
 *  - an APK may still ship hubbies (assets public/hubbies/&lt;id&gt;): a downloaded newer copy wins.
 * The WebView loads hubbies/&lt;id&gt;/… at the app's own address whichever copy it is (answered by
 * {@link #intercept}): their relative imports of shared/*.js reach the APK's files, so there is one
 * React, one SDK.
 */
public final class HubbyStore {

    private static final String TAG = "hub-modules";
    private static final Pattern ID = Pattern.compile("^[a-z0-9-]{1,40}$");
    private static final Pattern VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+$");
    private static final Pattern FILE = Pattern.compile("^[A-Za-z0-9._-]{1,80}$");
    /** an isolated hubby's frame host: https://<id>.hubby.localhost/ (docs/plan-hubby-architecture.md § 4 ter) */
    private static final Pattern HUBBY_HOST = Pattern.compile("^([a-z0-9-]{1,40})\\.hubby\\.localhost$");
    private static final Pattern RUNTIME_PATH = Pattern.compile("^chunks/[A-Za-z0-9._-]{1,120}$|^[A-Za-z0-9._-]{1,80}$");
    private static final Pattern PUBLISHED_FILE = Pattern.compile("^[A-Za-z0-9._-]{1,80}(/[A-Za-z0-9._-]{1,80}){0,2}$");
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");

    private static final HubbyStore INSTANCE = new HubbyStore();

    public static HubbyStore get() {
        return INSTANCE;
    }

    /** A hubby version: its catalogue entry, and the downloaded copy's folder (null: built in). */
    private static final class Entry {
        final String id;
        final String version;
        final String sdk;
        /** the entry as published (description included), without its file list */
        final JSONObject json;
        final File dir;

        Entry(JSONObject json, File dir) {
            this.json = json;
            this.id = json.optString("id");
            this.version = json.optString("version");
            this.sdk = json.optString("sdk");
            this.dir = dir;
        }

        static Entry from(JSONObject o, File dir) throws Exception {
            JSONObject copy = new JSONObject(o.toString());
            copy.remove("files");
            return new Entry(copy, dir);
        }

        JSONObject json() {
            return json;
        }
    }

    private File store;
    private boolean ready = false;
    private String sdkVersion = "0.0.0";
    /** The former SDK versions this APK still serves (version.json `compatible`). */
    private final java.util.List<String> sdkCompatible = new java.util.ArrayList<>();
    /** id → the version running this session, in the APK catalogue's order; decided at start. */
    private final Map<String, Entry> active = new LinkedHashMap<>();
    private boolean updating = false;

    private HubbyStore() {
    }

    /** The context setup ran with (to decide the versions again, see {@link #activate}). */
    private Context appContext;
    /** The hubbies the APK ships, as setup read them. */
    private final Map<String, Entry> shippedCopies = new LinkedHashMap<>();

    /** At start, before the WebView loads: decides the versions of this session. */
    public synchronized void setup(Context context) {
        appContext = context.getApplicationContext();
        store = new File(context.getFilesDir(), "modules");
        active.clear();
        try {
            JSONObject sdk = new JSONObject(asset(context, "public/modules/sdk.json"));
            sdkVersion = sdk.optString("version", "0.0.0");
            sdkCompatible.clear();
            JSONArray former = sdk.optJSONArray("compatible");
            for (int i = 0; former != null && i < former.length(); i++) sdkCompatible.add(former.getString(i));
            ready = true;
        } catch (Exception e) {
            // A web build without hubbies: nothing to answer, the APK's files are served.
            Log.w(TAG, "no hubby SDK version: " + e.getMessage());
            return;
        }
        Map<String, Entry> shipped = new LinkedHashMap<>();
        try {
            JSONArray builtIns = new JSONArray(asset(context, "public/modules/catalog.json"));
            for (int i = 0; i < builtIns.length(); i++) {
                Entry e = Entry.from(builtIns.getJSONObject(i), null);
                if (hasAsset(context, "public/modules/" + e.id + "/index.js")) shipped.put(e.id, e);
            }
        } catch (Exception ignored) {
            // none shipped
        }
        shippedCopies.clear();
        shippedCopies.putAll(shipped);
        Set<String> ids = new java.util.LinkedHashSet<>(shipped.keySet());
        File[] dirs = store.listFiles();
        if (dirs != null) for (File d : dirs) if (ID.matcher(d.getName()).matches()) ids.add(d.getName());
        List<String> updated = new ArrayList<>();
        for (String id : ids) {
            Entry best = bestCopy(id, shipped.get(id));
            if (best == null) continue;
            active.put(id, best);
            if (best.dir != null) updated.add(id + " " + best.version);
        }
        if (!updated.isEmpty()) Log.i(TAG, "running downloaded versions: " + String.join(", ", updated));
        pruneTunnel();
    }

    /** Whether a hubby goes out through the VPN (hubby.json `network`, formerly `supports: ['vpn']`). */
    private static boolean needsVpn(Entry hubby) {
        Object network = hubby.json.opt("network");
        if ("vpn".equals(network)) return true;
        if (network instanceof JSONObject && "vpn".equals(((JSONObject) network).optString("egress"))) return true;
        JSONArray supports = hubby.json.optJSONArray("supports");
        for (int i = 0; supports != null && i < supports.length(); i++) if ("vpn".equals(supports.optString(i))) return true;
        return false;
    }

    /** The installed hubbies going out through the VPN (their configs, VpnConfigs). */
    public synchronized List<String> vpnHubbies() {
        List<String> ids = new ArrayList<>();
        for (Entry hubby : active.values()) if (needsVpn(hubby)) ids.add(hubby.id);
        return ids;
    }

    /** The tunnel (a platform component, TunnelComponent) stays only while a hubby needs it. */
    private synchronized void pruneTunnel() {
        if (appContext == null) return;
        for (Entry hubby : active.values()) if (needsVpn(hubby)) return;
        TunnelComponent.remove(appContext);
    }

    /**
     * The newer versions already downloaded than what runs ("id version"): what {@link #activate}
     * would switch to.
     */
    public synchronized List<String> pending() {
        List<String> newer = new ArrayList<>();
        if (!ready || store == null) return newer;
        Set<String> ids = new java.util.LinkedHashSet<>(active.keySet());
        File[] dirs = store.listFiles();
        if (dirs != null) for (File d : dirs) if (ID.matcher(d.getName()).matches() && active.containsKey(d.getName())) ids.add(d.getName());
        for (String id : ids) {
            Entry running = active.get(id);
            Entry best = bestCopy(id, shippedCopies.get(id));
            if (running != null && best != null && compare(best.version, running.version) > 0) newer.add(id + " " + best.version);
        }
        return newer;
    }

    /**
     * Decides the versions again, as at start: the newer downloaded ones run from the next page
     * load (the web layer reloads right after). Returns what changed.
     */
    public synchronized List<String> activate() {
        List<String> newer = pending();
        if (!newer.isEmpty() && appContext != null) {
            setup(appContext);
            Log.i(TAG, "activated without a restart: " + String.join(", ", newer));
        }
        return newer;
    }

    /**
     * Answers hubbies/… (this session's catalogue, a downloaded hubby's files); null for
     * everything else, served from the APK as usual.
     */
    public synchronized WebResourceResponse intercept(String path) {
        if (!ready || path == null || !path.startsWith("/modules/")) return null;
        String rel = path.substring("/modules/".length());
        if (rel.equals("catalog.js")) {
            JSONArray list = new JSONArray();
            for (Entry e : active.values()) list.put(e.json());
            byte[] body = ("export default " + list + "\n").getBytes(StandardCharsets.UTF_8);
            return response("text/javascript", new ByteArrayInputStream(body));
        }
        String[] parts = rel.split("/");
        if (parts.length != 2 || !FILE.matcher(parts[1]).matches()) return null;
        Entry hubby = active.get(parts[0]);
        if (hubby == null || hubby.dir == null) return null;
        File file = new File(hubby.dir, parts[1]);
        try {
            return response(mime(parts[1]), new FileInputStream(file));
        } catch (Exception e) {
            return null;
        }
    }

    /** Whether the host is an isolated hubby's (its requests are all answered here, never sent out). */
    public static boolean isHubbyHost(String host) {
        return host != null && HUBBY_HOST.matcher(host).matches();
    }

    /**
     * Answers https://<id>.hubby.localhost/…: the frame page (/), the hubby runtime (/_runtime/…),
     * the hubby's own files (its running version, downloaded or shipped; an isolated hubby only).
     * Everything allows any origin (the sandboxed frame's is opaque), nothing is cached (a hubby
     * switches versions); anything else is a 404, never a request to the network.
     */
    public synchronized WebResourceResponse interceptHubby(String host, String path) {
        java.util.regex.Matcher m = HUBBY_HOST.matcher(host == null ? "" : host);
        if (!m.matches() || path == null || appContext == null) return notFound();
        String id = m.group(1);
        String rel = path.startsWith("/") ? path.substring(1) : path;
        if (rel.contains("..")) return notFound();
        try {
            if (rel.isEmpty() || rel.equals("index.html")) return hubbyResponse("text/html", appContext.getAssets().open("public/hubby-runtime/frame.html"));
            if (rel.startsWith("_runtime/")) {
                String file = rel.substring("_runtime/".length());
                if (!RUNTIME_PATH.matcher(file).matches()) return notFound();
                return hubbyResponse(mime(file), appContext.getAssets().open("public/hubby-runtime/" + file));
            }
            if (!FILE.matcher(rel).matches()) return notFound();
            Entry hubby = active.get(id);
            if (hubby != null && !hubby.json.optBoolean("isolated", false)) return notFound();
            if (hubby != null && hubby.dir != null) return hubbyResponse(mime(rel), new FileInputStream(new File(hubby.dir, rel)));
            return hubbyResponse(mime(rel), appContext.getAssets().open("public/modules/" + id + "/" + rel));
        } catch (Exception e) {
            return notFound();
        }
    }

    private static Map<String, String> hubbyHeaders() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        return headers;
    }

    private static WebResourceResponse hubbyResponse(String mime, InputStream body) {
        return new WebResourceResponse(mime, "utf-8", 200, "OK", hubbyHeaders(), body);
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", hubbyHeaders(), new ByteArrayInputStream(new byte[0]));
    }

    /** The SDK version and what runs, for the web layer's update check. */
    public synchronized JSONObject state() throws Exception {
        JSONObject running = new JSONObject();
        JSONArray hubbies = new JSONArray();
        for (Entry e : active.values()) {
            running.put(e.id, e.version);
            hubbies.put(e.json());
        }
        return new JSONObject().put("sdk", sdkVersion).put("compatible", new JSONArray(sdkCompatible)).put("running", running).put("hubbies", hubbies);
    }

    /** Whether this APK can run a published entry (its SDK range). */
    public boolean compatible(JSONObject entry) {
        return fits(entry.optString("sdk"));
    }

    /**
     * Installs a hubby and makes it usable in this session: its downloaded copy when there is one,
     * else the published entry given (verified by the web layer), downloaded. Blocking.
     */
    public JSONObject install(String id, JSONObject published, String baseUrl) throws Exception {
        synchronized (this) {
            Entry running = active.get(id);
            if (running != null) return running.json();
        }
        if (!ID.matcher(id).matches()) throw new Exception("invalid hubby id");
        Entry copy = bestCopy(id, null);
        if (copy == null) {
            if (published == null || !id.equals(published.optString("id"))) throw new Exception(id + ": not published");
            if (!compatible(published)) throw new Exception(id + ": not published for this version of the app");
            download(published, baseUrl);
            copy = bestCopy(id, null);
            if (copy == null) throw new Exception(id + ": downloaded but not usable");
        }
        synchronized (this) {
            active.put(id, copy);
        }
        return copy.json();
    }

    /** Removes a hubby's downloaded files (one the APK ships stays). Loaded, it stays until restart. */
    public void uninstall(String id) throws Exception {
        if (!ID.matcher(id).matches()) throw new Exception("invalid hubby id");
        delete(new File(store, id));
        synchronized (this) {
            Entry running = active.get(id);
            if (running != null && running.dir != null) active.remove(id);
        }
        Log.i(TAG, id + " removed from this device");
        pruneTunnel();
    }

    /** The newest copy of a hubby this APK can run (shipped or downloaded), null: none. */
    private Entry bestCopy(String id, Entry shipped) {
        Entry best = shipped;
        for (Entry copy : downloaded(id)) {
            if (fits(copy.sdk) && (best == null || compare(copy.version, best.version) > 0)) best = copy;
        }
        return best;
    }

    /**
     * Downloads the newer compatible versions of the installed hubbies among a published catalogue
     * (already verified), for the next start, and drops the copies no longer of use. Blocking: called off the UI thread.
     *
     * @return the "id version" downloaded
     */
    public List<String> update(JSONArray published, String baseUrl, boolean drop) throws Exception {
        synchronized (this) {
            if (updating || store == null) return Collections.emptyList();
            updating = true;
        }
        List<String> done = new ArrayList<>();
        try {
            for (int i = 0; i < published.length(); i++) {
                JSONObject entry = published.getJSONObject(i);
                String id = entry.optString("id");
                String version = entry.optString("version");
                if (!ID.matcher(id).matches() || !VERSION.matcher(version).matches()) continue;
                Entry running;
                synchronized (this) {
                    running = active.get(id);
                }
                if (running == null || !fits(entry.optString("sdk"))) continue;
                String newest = running.version;
                for (Entry copy : downloaded(id)) if (compare(copy.version, newest) > 0) newest = copy.version;
                if (compare(version, newest) <= 0) continue;
                try {
                    download(entry, baseUrl);
                    done.add(id + " " + version);
                } catch (Exception e) {
                    Log.w(TAG, id + " " + version + " not downloaded: " + e.getMessage());
                }
            }
            for (String id : new ArrayList<>(active.keySet())) prune(id);
            // only once the restricted hubbies are listed (not in the public catalogue)
            if (drop) dropUnpublished(published);
        } finally {
            synchronized (this) {
                updating = false;
            }
        }
        return done;
    }

    /**
     * Removes the downloaded hubbies the server no longer publishes (a hubby taken out of the
     * app): hidden already (the server doesn't serve them), their files go. Never on an empty catalogue.
     */
    private void dropUnpublished(JSONArray published) {
        if (published.length() == 0) return;
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < published.length(); i++) {
            JSONObject entry = published.optJSONObject(i);
            if (entry != null) ids.add(entry.optString("id"));
        }
        File[] dirs = store.listFiles();
        if (dirs == null) return;
        for (File dir : dirs) {
            String id = dir.getName();
            if (!ID.matcher(id).matches() || ids.contains(id)) continue;
            delete(dir);
            synchronized (this) {
                Entry running = active.get(id);
                if (running != null && running.dir != null) active.remove(id);
            }
            Log.i(TAG, id + " is no longer published: removed from this device");
        }
    }

    /** One published version, every file checked, then moved in place at once. */
    private void download(JSONObject entry, String baseUrl) throws Exception {
        String id = entry.getString("id");
        String version = entry.getString("version");
        JSONArray files = entry.getJSONArray("files");
        // a restricted hubby: a signed URL per file (handed by the server for this account)
        JSONObject urls = entry.optJSONObject("urls");
        File fin = new File(new File(store, id), version);
        File partial = new File(new File(store, id), version + ".partial");
        delete(partial);
        if (!partial.mkdirs()) throw new Exception("cannot create " + partial);
        try {
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                String name = f.getString("path");
                String sha = f.getString("sha256");
                String platform = f.optString("platform", "");
                // a hubby brings no native file (an older version's: not downloaded; the VPN
                // tunnel is the platform's, TunnelComponent)
                if (!platform.isEmpty()) continue;
                if (!PUBLISHED_FILE.matcher(name).matches() || name.contains("..") || !SHA256.matcher(sha).matches()) throw new Exception("bad file entry " + name);
                File dest = new File(partial, name);
                File parent = dest.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new Exception("cannot create " + parent);
                String url = urls != null ? urls.optString(name, "") : baseUrl + id + "/" + version + "/" + name;
                if (url.isEmpty()) throw new Exception(name + ": no download URL (restricted hubbe, list it again)");
                String actual = fetch(url, dest);
                if (!actual.equals(sha)) throw new Exception(name + ": checksum mismatch");
            }
            JSONObject meta = new JSONObject(entry.toString());
            meta.remove("files");
            meta.remove("urls");
            try (FileOutputStream out = new FileOutputStream(new File(partial, "module.json"))) {
                out.write(meta.toString().getBytes(StandardCharsets.UTF_8));
            }
            delete(fin);
            if (!partial.renameTo(fin)) throw new Exception("cannot move " + partial);
            Log.i(TAG, id + " " + version + " downloaded");
        } catch (Exception e) {
            delete(partial);
            throw e;
        }
    }

    /** Downloads a file through the tunnel (/releases/ is VPN-only); returns its sha256. */
    private static String fetch(String url, File dest) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) TunnelManager.get().open(new URL(url));
        try {
            conn.setConnectTimeout(30_000);
            conn.setReadTimeout(60_000);
            int status = conn.getResponseCode();
            if (status != 200) throw new Exception(dest.getName() + ": HTTP " + status);
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) {
                    md.update(buf, 0, n);
                    out.write(buf, 0, n);
                }
            }
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } finally {
            conn.disconnect();
        }
    }

    /** Downloaded versions of a hubby, complete ones only (a download lands in place once checked). */
    private List<Entry> downloaded(String id) {
        List<Entry> found = new ArrayList<>();
        File[] dirs = new File(store, id).listFiles();
        if (dirs == null) return found;
        for (File dir : dirs) {
            if (!VERSION.matcher(dir.getName()).matches()) continue;
            try (InputStream in = new FileInputStream(new File(dir, "module.json"))) {
                found.add(Entry.from(new JSONObject(read(in)), dir));
            } catch (Exception ignored) {
            }
        }
        return found;
    }

    /** Drops the downloaded versions older than both the running one and the newest. */
    private void prune(String id) {
        List<Entry> copies = downloaded(id);
        if (copies.isEmpty()) return;
        Set<String> keep = new HashSet<>();
        synchronized (this) {
            Entry running = active.get(id);
            if (running != null) keep.add(running.version);
        }
        String newest = copies.get(0).version;
        for (Entry c : copies) if (compare(c.version, newest) > 0) newest = c.version;
        keep.add(newest);
        for (Entry c : copies) if (!keep.contains(c.version)) delete(c.dir);
    }

    // --- versions: plain x.y.z, ranges ^x.y.z or an exact x.y.z (as desktop/src/main/hubbies/semver.ts)

    private static int[] parts(String version) {
        String[] s = version.split("\\.");
        int[] p = new int[3];
        for (int i = 0; i < 3 && i < s.length; i++) {
            try {
                p[i] = Integer.parseInt(s[i]);
            } catch (NumberFormatException ignored) {
            }
        }
        return p;
    }

    static int compare(String a, String b) {
        int[] x = parts(a), y = parts(b);
        for (int i = 0; i < 3; i++) if (x[i] != y[i]) return x[i] - y[i];
        return 0;
    }

    /**
     * ^1.2.3 = >=1.2.3 <2.0.0 (^0.2.3 = >=0.2.3 <0.3.0), else exact; alternatives joined by `||`
     * (`^1.12.0 || ^2.0.0`: a hubby running on two majors of the SDK), as the desktop's semver.ts.
     */
    /** Whether this APK's SDK fits a range: its version, or a former one it still serves. */
    private boolean fits(String range) {
        if (satisfies(sdkVersion, range)) return true;
        for (String version : sdkCompatible) if (satisfies(version, range)) return true;
        return false;
    }

    static boolean satisfies(String version, String range) {
        if (range == null || range.isEmpty()) return false;
        for (String alternative : range.split("\\|\\|")) {
            if (satisfiesOne(version, alternative.trim())) return true;
        }
        return false;
    }

    private static boolean satisfiesOne(String version, String range) {
        if (range.isEmpty()) return false;
        if (!range.startsWith("^")) return compare(version, range) == 0;
        String base = range.substring(1);
        int[] b = parts(base), v = parts(version);
        if (compare(version, base) < 0) return false;
        return b[0] > 0 ? v[0] == b[0] : v[0] == 0 && v[1] == b[1];
    }

    // --- helpers

    private static WebResourceResponse response(String mime, InputStream body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse(mime, "utf-8", 200, "OK", headers, body);
    }

    private static String mime(String name) {
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".js")) return "text/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private static boolean hasAsset(Context context, String path) {
        try (InputStream ignored = context.getAssets().open(path)) {
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static String asset(Context context, String path) throws Exception {
        try (InputStream in = context.getAssets().open(path)) {
            return read(in);
        }
    }

    private static String read(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    private static void delete(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) delete(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
