package cxxi.hub;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.StatFs;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * The local AI on the phone, native side (client docs/plan-ia-android.md, phase 2). The logic — the
 * models the hubbies declare, how they fit, consents, the requests — lives in the app
 * (app/src/platform/capacitorLocalAi.ts, the desktop's main/ai/models.ts and chat.ts); here only what
 * needs the device: its RAM and disk, the models' files (downloaded straight from Hugging Face,
 * resumed, their sha256 checked as they come, kept in the app's own storage by sha256), the engine
 * ({@link AiEngine}: a request, or a chat streamed line by line), and a voice sample picked by the user.
 */
@CapacitorPlugin(name = "LocalAi")
public class LocalAiPlugin extends Plugin {
    private static final String TAG = "LocalAi";
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern FILE_NAME = Pattern.compile("^[A-Za-z0-9._-]{1,120}$");
    private static final Pattern REPO = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$");
    private static final Pattern COMMIT = Pattern.compile("^[0-9a-f]{40}$");
    private static final Pattern REPO_PATH = Pattern.compile("^(?!.*\\.\\.)[A-Za-z0-9._-]{1,120}(/[A-Za-z0-9._-]{1,120}){0,3}$");
    private static final long MIB = 1024L * 1024L;

    /** the requests running (chat, request), by the app's id: their connection, to cut them */
    private final Map<Integer, HttpURLConnection> running = new ConcurrentHashMap<>();
    private final Map<Integer, Boolean> aborted = new ConcurrentHashMap<>();

    private File modelsDir() { return new File(getContext().getFilesDir(), "models"); }
    private File importsDir() { return new File(getContext().getFilesDir(), "ai-imports"); }
    private File indexFile() { return new File(getContext().getFilesDir(), "ai-models.json"); }

    private void background(PluginCall call, Job job) {
        new Thread(() -> {
            try { job.run(); }
            catch (Exception e) {
                Log.w(TAG, call.getMethodName() + " failed", e);
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        }, "local-ai").start();
    }

    private interface Job { void run() throws Exception; }

    // --- the device ---

    /** { ramMib, freeDiskMib, directory, engine: the text/voice engines exist for this device } */
    @PluginMethod
    public void device(PluginCall call) {
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mem = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mem);
        File dir = modelsDir();
        if (!dir.isDirectory()) dir.mkdirs();
        StatFs fs = new StatFs(dir.getAbsolutePath());
        JSObject ret = new JSObject();
        ret.put("ramMib", mem.totalMem / MIB);
        ret.put("freeDiskMib", fs.getAvailableBytes() / MIB);
        ret.put("directory", dir.getAbsolutePath());
        ret.put("text", AiEngineComponent.available("text"));
        ret.put("voice", AiEngineComponent.available("voice"));
        call.resolve(ret);
    }

    // --- the app's index (installed files, consents, models added by link): JSON kept here ---

    @PluginMethod
    public void readIndex(PluginCall call) {
        JSObject ret = new JSObject();
        try { ret.put("json", new String(read(indexFile()), StandardCharsets.UTF_8)); }
        catch (IOException e) { ret.put("json", null); }
        call.resolve(ret);
    }

    @PluginMethod
    public void writeIndex(PluginCall call) {
        String json = call.getString("json");
        if (json == null) { call.reject("json"); return; }
        try {
            File part = new File(indexFile().getPath() + ".part");
            try (OutputStream out = new FileOutputStream(part)) { out.write(json.getBytes(StandardCharsets.UTF_8)); }
            if (!part.renameTo(indexFile())) throw new IOException("couldn't write the AI index");
            call.resolve();
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    // --- the models' files ---

    /** The sizes of files this plugin wrote ({ paths } → { sizes: -1 when absent }). */
    @PluginMethod
    public void sizes(PluginCall call) {
        try {
            JSONArray paths = call.getArray("paths");
            JSArray sizes = new JSArray();
            for (int i = 0; i < paths.length(); i++) {
                File f = owned(paths.getString(i));
                sizes.put(f != null && f.isFile() ? f.length() : -1);
            }
            JSObject ret = new JSObject();
            ret.put("sizes", sizes);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** A path inside this plugin's folders, else null (the app never names another file). */
    private File owned(String path) throws IOException {
        if (path == null) return null;
        File f = new File(path).getCanonicalFile();
        String models = modelsDir().getCanonicalPath() + File.separator;
        String imports = importsDir().getCanonicalPath() + File.separator;
        return f.getPath().startsWith(models) || f.getPath().startsWith(imports) ? f : null;
    }

    /**
     * download({ id, repo, revision, path, sha256, size }): one file of a model, from huggingface.co,
     * resumed from what is here, its sha256 checked; progress as "download" events { id, received }.
     * Resolves { file }.
     */
    @PluginMethod
    public void download(PluginCall call) {
        background(call, () -> {
            int id = call.getInt("id", 0);
            String repo = call.getString("repo", "");
            String revision = call.getString("revision", "");
            String path = call.getString("path", "");
            String sha = call.getString("sha256", "");
            // a size that fits an int arrives as an Integer (getLong would miss it)
            long size = call.getData().optLong("size", 0L);
            if (!REPO.matcher(repo).matches() || !COMMIT.matcher(revision).matches() || !REPO_PATH.matcher(path).matches() || !SHA256.matcher(sha).matches() || size <= 0) throw new IOException("a file is not pinned");
            String name = path.substring(path.lastIndexOf('/') + 1);
            File dir = new File(modelsDir(), sha);
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no folder for the model");
            File fin = new File(dir, name);
            File part = new File(dir, name + ".part");
            if (fin.isFile() && fin.length() == size) { done(call, fin); return; }
            long have = part.isFile() ? part.length() : 0;
            if (have > size) { part.delete(); have = 0; }
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            if (have > 0) {
                try (InputStream in = new FileInputStream(part)) { pump(in, null, digest, null); }
            }
            long[] received = { have };
            long[] last = { 0 };
            progress(id, received[0]);
            if (have < size) {
                StringBuilder url = new StringBuilder("https://huggingface.co/").append(repo).append("/resolve/").append(revision);
                for (String seg : path.split("/")) url.append('/').append(Uri.encode(seg));
                HttpURLConnection c = (HttpURLConnection) new URL(url.toString()).openConnection();
                c.setConnectTimeout(20000);
                c.setReadTimeout(120000);
                c.setInstanceFollowRedirects(true);
                if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
                running.put(id, c);
                try {
                    int code = c.getResponseCode();
                    if (code != 200 && code != 206) throw new IOException("HTTP " + code + " for " + path);
                    if (have > 0 && code != 206) throw new IOException("the server did not resume the download");
                    try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part, have > 0)) {
                        pump(in, out, digest, n -> {
                            received[0] += n;
                            if (System.currentTimeMillis() - last[0] > 500) { last[0] = System.currentTimeMillis(); progress(id, received[0]); }
                        });
                    }
                } finally {
                    running.remove(id);
                    c.disconnect();
                }
            }
            String sum = hex(digest.digest());
            if (!sum.equals(sha)) {
                part.delete();
                throw new IOException(path + ": sha256 " + sum + ", expected " + sha);
            }
            if (!part.renameTo(fin)) throw new IOException("couldn't put the model in place");
            Log.i(TAG, repo + " " + path + " installed (sha256 checked)");
            done(call, fin);
        });
    }

    private void done(PluginCall call, File file) {
        JSObject ret = new JSObject();
        ret.put("file", file.getAbsolutePath());
        call.resolve(ret);
    }

    private void progress(int id, long received) {
        JSObject e = new JSObject();
        e.put("id", id);
        e.put("received", received);
        notifyListeners("download", e);
    }

    /** remove({ sha256 }): a model file's folder goes. */
    @PluginMethod
    public void remove(PluginCall call) {
        String sha = call.getString("sha256", "");
        if (!SHA256.matcher(sha).matches()) { call.reject("invalid model"); return; }
        deleteTree(new File(modelsDir(), sha));
        call.resolve();
    }

    // --- the engine ---

    private AiEngine.Spec spec(PluginCall call) throws Exception {
        JSONObject s = call.getObject("spec");
        String engine = s.getString("engine");
        if (!"text".equals(engine) && !"voice".equals(engine)) throw new IOException("no such engine");
        JSONArray a = s.getJSONArray("args");
        List<String> args = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) args.add(a.getString(i));
        // the files it names are this plugin's (the models, the imported samples)
        for (int i = 0; i < args.size(); i++) {
            String v = args.get(i);
            if (v.startsWith("/") && owned(v) == null) throw new IOException("a file outside the AI's folders");
        }
        return new AiEngine.Spec(engine, args);
    }

    /**
     * chat({ id, spec, path, body }): the engine for spec, then a streamed request; each line of its
     * server-sent events as a "chat" event { id, line }. Resolves when it ends ({ status, error }).
     */
    @PluginMethod
    public void chat(PluginCall call) {
        background(call, () -> {
            int id = call.getInt("id", 0);
            aborted.remove(id);
            AiEngine.get().with(getContext(), spec(call), () -> { streamChat(call, id); return null; });
        });
    }

    private void streamChat(PluginCall call, int id) throws Exception {
            if (aborted.remove(id) != null) { call.reject("aborted"); return; }
            HttpURLConnection c = AiEngine.get().post(call.getString("path", "/v1/chat/completions"), call.getString("body", "{}"));
            running.put(id, c);
            try {
                int code = c.getResponseCode();
                JSObject ret = new JSObject();
                ret.put("status", code);
                if (code >= 400) {
                    ret.put("error", new String(readAll(c.getErrorStream()), StandardCharsets.UTF_8));
                    call.resolve(ret);
                    return;
                }
                try (BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = in.readLine()) != null) {
                        if (line.isEmpty()) continue;
                        JSObject e = new JSObject();
                        e.put("id", id);
                        e.put("line", line);
                        notifyListeners("chat", e);
                        // the server may keep the connection open after its last event
                        if (line.startsWith("data:") && line.substring(5).trim().equals("[DONE]")) break;
                    }
                }
                call.resolve(ret);
            } catch (IOException e) {
                if (aborted.remove(id) != null) call.reject("aborted");
                else throw e;
            } finally {
                running.remove(id);
                c.disconnect();
            }
    }

    /**
     * request({ id, spec, path, body }): the engine for spec, then one JSON request; resolves
     * { status, body (base64) } — a voice's WAV, an error's text.
     */
    @PluginMethod
    public void request(PluginCall call) {
        background(call, () -> {
            int id = call.getInt("id", 0);
            aborted.remove(id);
            AiEngine.get().with(getContext(), spec(call), () -> { oneRequest(call, id); return null; });
        });
    }

    /** One request after another for the same engine ({ id, spec, requests: [{ path, body }] }) is request() called again: the engine stays. */
    private void oneRequest(PluginCall call, int id) throws Exception {
            if (aborted.remove(id) != null) { call.reject("aborted"); return; }
            HttpURLConnection c = AiEngine.get().post(call.getString("path", "/"), call.getString("body", "{}"));
            running.put(id, c);
            try {
                int code = c.getResponseCode();
                byte[] body = readAll(code < 400 ? c.getInputStream() : c.getErrorStream());
                JSObject ret = new JSObject();
                ret.put("status", code);
                ret.put("body", Base64.encodeToString(body, Base64.NO_WRAP));
                call.resolve(ret);
            } catch (IOException e) {
                if (aborted.remove(id) != null) call.reject("aborted");
                else throw e;
            } finally {
                running.remove(id);
                c.disconnect();
            }
    }

    /** abort({ id }): a chat, a request or a download cut. */
    @PluginMethod
    public void abort(PluginCall call) {
        int id = call.getInt("id", 0);
        aborted.put(id, true);
        HttpURLConnection c = running.remove(id);
        if (c != null) new Thread(c::disconnect).start();
        call.resolve();
    }

    /** The running engine stopped (its process and its model's memory go). */
    @PluginMethod
    public void stop(PluginCall call) {
        AiEngine.get().stop(getContext());
        call.resolve();
    }

    // --- a voice sample, picked by the user ---

    /** importAudio(): the user picks a WAV; copied into the app's storage by its sha256 ({ sha256, name, size, file } or { cancelled }). */
    @PluginMethod
    public void importAudio(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("audio/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave" });
        startActivityForResult(call, intent, "audioPicked");
    }

    @ActivityCallback
    private void audioPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = result.getData() != null ? result.getData().getData() : null;
        if (uri == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        background(call, () -> {
            String name = displayName(uri);
            File dir = importsDir();
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no folder for imports");
            File part = new File(dir, "import.part");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long size;
            try (InputStream in = getContext().getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(part)) {
                if (in == null) throw new IOException("the file can't be read");
                size = pump(in, out, digest, null);
            }
            if (size > 50 * MIB) { part.delete(); throw new IOException("a voice sample is at most 50 MB"); }
            String sha = hex(digest.digest());
            File fin = new File(dir, sha + ".wav");
            if (fin.isFile()) part.delete();
            else if (!part.renameTo(fin)) throw new IOException("couldn't keep the sample");
            JSObject ret = new JSObject();
            ret.put("sha256", sha);
            ret.put("name", name);
            ret.put("size", size);
            ret.put("file", fin.getAbsolutePath());
            call.resolve(ret);
        });
    }

    /** forgetImport({ sha256 }): an imported sample's file goes. */
    @PluginMethod
    public void forgetImport(PluginCall call) {
        String sha = call.getString("sha256", "");
        if (!SHA256.matcher(sha).matches()) { call.reject("invalid file"); return; }
        new File(importsDir(), sha + ".wav").delete();
        call.resolve();
    }

    /** readFile({ path }): one of this plugin's files, base64 (a voice sample, to register it). */
    @PluginMethod
    public void readFile(PluginCall call) {
        try {
            File f = owned(call.getString("path"));
            if (f == null || !f.isFile() || f.length() > 50 * MIB) throw new IOException("no such file");
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(read(f), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null) return n.length() > 120 ? n.substring(0, 120) : n;
            }
        } catch (Exception ignored) {
            // no name: a generic one
        }
        return "sample.wav";
    }

    // --- helpers ---

    private interface Progress { void bytes(int n); }

    private static long pump(InputStream in, OutputStream out, MessageDigest digest, Progress progress) throws IOException {
        byte[] buffer = new byte[256 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buffer)) > 0) {
            if (digest != null) digest.update(buffer, 0, n);
            if (out != null) out.write(buffer, 0, n);
            if (progress != null) progress.bytes(n);
            total += n;
        }
        return total;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        if (in == null) return new byte[0];
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        try (InputStream i = in) { pump(i, out, null, null); }
        return out.toByteArray();
    }

    private static byte[] read(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) { return readAll(in); }
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }

    @SuppressWarnings("unused")
    private static boolean validName(String name) { return name != null && FILE_NAME.matcher(name).matches(); }
}
