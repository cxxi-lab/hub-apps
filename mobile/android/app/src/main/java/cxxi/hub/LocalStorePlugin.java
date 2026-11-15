package cxxi.hub;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The modules' store on this device (platform.localStore, as desktop/src/main/store/localStore.ts):
 * one SQLite database per account and module (its documents, by scope and collection), its files
 * next to it — filesDir/store/&lt;account&gt;/&lt;module&gt;.sqlite and &lt;module&gt;/&lt;scope&gt;/&lt;path&gt;.
 * The local-first modules keep their replica here (scope `sync`, docs/plan-local-first.md).
 * A document's data crosses the bridge as a JSON string; a file as base64.
 */
@CapacitorPlugin(name = "LocalStore")
public class LocalStorePlugin extends Plugin {

    private static final Pattern ACCOUNT = Pattern.compile("^[a-f0-9]{16,64}$");
    private static final Pattern MODULE = Pattern.compile("^[a-z0-9-]{1,40}$");
    private static final Pattern SCOPE = Pattern.compile("^[a-z0-9-]{1,40}$");
    private static final Pattern COLLECTION = Pattern.compile("^[a-z0-9_-]{1,40}$");
    private static final Pattern DOC_ID = Pattern.compile("^[A-Za-z0-9._:-]{1,64}$");
    private static final Pattern FILE = Pattern.compile("^[A-Za-z0-9._-]{1,120}(/[A-Za-z0-9._-]{1,120}){0,3}$");
    private static final int MAX_FILE = 50 * 1024 * 1024;

    private final Map<String, SQLiteDatabase> databases = new HashMap<>();

    private static String check(String value, Pattern pattern, String what) {
        if (value == null || !pattern.matcher(value).matches()) throw new IllegalArgumentException("store: bad " + what);
        return value;
    }

    private File root() {
        return new File(getContext().getFilesDir(), "store");
    }

    private synchronized SQLiteDatabase db(String account, String module) {
        String key = account + "/" + module;
        SQLiteDatabase found = databases.get(key);
        if (found == null) {
            File dir = new File(root(), account);
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            found = SQLiteDatabase.openOrCreateDatabase(new File(dir, module + ".sqlite"), null);
            found.enableWriteAheadLogging();
            found.execSQL("CREATE TABLE IF NOT EXISTS document (scope TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (scope, collection, id))");
            databases.put(key, found);
        }
        return found;
    }

    /** (account, module, scope) of a call, checked before anything touches the disk. */
    private String[] at(PluginCall call) {
        return new String[] {
            check(call.getString("account"), ACCOUNT, "account"),
            check(call.getString("module"), MODULE, "module"),
            check(call.getString("scope"), SCOPE, "scope"),
        };
    }

    private static JSObject document(Cursor c) {
        JSObject doc = new JSObject();
        doc.put("collection", c.getString(0));
        doc.put("id", c.getString(1));
        doc.put("data", c.getString(2));
        doc.put("updatedAt", c.getLong(3));
        return doc;
    }

    @PluginMethod
    public void list(PluginCall call) {
        try {
            String[] a = at(call);
            String collection = call.getString("collection");
            Cursor c = collection == null
                ? db(a[0], a[1]).rawQuery("SELECT collection, id, data, updated_at FROM document WHERE scope = ? ORDER BY updated_at DESC", new String[] { a[2] })
                : db(a[0], a[1]).rawQuery("SELECT collection, id, data, updated_at FROM document WHERE scope = ? AND collection = ? ORDER BY updated_at DESC", new String[] { a[2], check(collection, COLLECTION, "collection") });
            JSArray docs = new JSArray();
            try {
                while (c.moveToNext()) docs.put(document(c));
            }
            finally {
                c.close();
            }
            JSObject result = new JSObject();
            result.put("documents", docs);
            call.resolve(result);
        }
        catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        try {
            String[] a = at(call);
            Cursor c = db(a[0], a[1]).rawQuery("SELECT collection, id, data, updated_at FROM document WHERE scope = ? AND collection = ? AND id = ?",
                new String[] { a[2], check(call.getString("collection"), COLLECTION, "collection"), check(call.getString("id"), DOC_ID, "id") });
            JSObject result = new JSObject();
            try {
                result.put("document", c.moveToNext() ? document(c) : JSONObject.NULL);
            }
            finally {
                c.close();
            }
            call.resolve(result);
        }
        catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** Writes documents; the last write wins (an older one than what is stored is left out). */
    @PluginMethod
    public void put(PluginCall call) {
        try {
            String[] a = at(call);
            JSArray documents = call.getArray("documents");
            if (documents == null) throw new IllegalArgumentException("store: bad documents");
            SQLiteDatabase db = db(a[0], a[1]);
            db.beginTransaction();
            try {
                for (int i = 0; i < documents.length(); i++) {
                    JSONObject d = documents.getJSONObject(i);
                    String collection = check(d.optString("collection", null), COLLECTION, "collection");
                    String id = check(d.optString("id", null), DOC_ID, "id");
                    long updatedAt = d.optLong("updatedAt", System.currentTimeMillis());
                    // no UPSERT before SQLite 3.24 (Android 11): read, then insert or update
                    Long stored = null;
                    Cursor c = db.rawQuery("SELECT updated_at FROM document WHERE scope = ? AND collection = ? AND id = ?", new String[] { a[2], collection, id });
                    try {
                        if (c.moveToNext()) stored = c.getLong(0);
                    }
                    finally {
                        c.close();
                    }
                    if (stored != null && updatedAt < stored) continue;
                    ContentValues row = new ContentValues();
                    row.put("scope", a[2]);
                    row.put("collection", collection);
                    row.put("id", id);
                    row.put("data", d.optString("data", "null"));
                    row.put("updated_at", updatedAt);
                    db.insertWithOnConflict("document", null, row, SQLiteDatabase.CONFLICT_REPLACE);
                }
                db.setTransactionSuccessful();
            }
            finally {
                db.endTransaction();
            }
            call.resolve();
        }
        catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void delete(PluginCall call) {
        try {
            String[] a = at(call);
            db(a[0], a[1]).delete("document", "scope = ? AND collection = ? AND id = ?",
                new String[] { a[2], check(call.getString("collection"), COLLECTION, "collection"), check(call.getString("id"), DOC_ID, "id") });
            call.resolve();
        }
        catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** Empties a scope here: documents and files. */
    @PluginMethod
    public void purge(PluginCall call) {
        try {
            String[] a = at(call);
            db(a[0], a[1]).delete("document", "scope = ?", new String[] { a[2] });
            deleteTree(scopeDir(a));
            call.resolve();
        }
        catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    // --- files ---

    private File scopeDir(String[] a) {
        return new File(new File(new File(root(), a[0]), a[1]), a[2]);
    }

    private File file(String[] a, String path) {
        check(path, FILE, "path");
        if (path.contains("..")) throw new IllegalArgumentException("store: bad path");
        return new File(scopeDir(a), path);
    }

    private static void deleteTree(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static byte[] read(File f) throws Exception {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] body = new byte[(int) f.length()];
            int off = 0;
            while (off < body.length) {
                int n = in.read(body, off, body.length - off);
                if (n < 0) break;
                off += n;
            }
            return body;
        }
    }

    @PluginMethod
    public void files(PluginCall call) {
        try {
            File root = scopeDir(at(call));
            List<JSObject> found = new ArrayList<>();
            walk(root, root, found);
            found.sort((x, y) -> x.getString("path").compareTo(y.getString("path")));
            JSArray list = new JSArray();
            for (JSObject f : found) list.put(f);
            JSObject result = new JSObject();
            result.put("files", list);
            call.resolve(result);
        }
        catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    private static void walk(File root, File dir, List<JSObject> out) throws Exception {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (child.isDirectory()) { walk(root, child, out); continue; }
            if (child.getName().endsWith(".partial")) continue;
            byte[] body = read(child);
            StringBuilder hex = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(body)) hex.append(String.format("%02x", b));
            JSObject f = new JSObject();
            f.put("path", root.toURI().relativize(child.toURI()).getPath());
            f.put("size", body.length);
            f.put("sha256", hex.toString());
            out.add(f);
        }
    }

    @PluginMethod
    public void putFile(PluginCall call) {
        try {
            File target = file(at(call), call.getString("path"));
            byte[] body = Base64.decode(call.getString("body", ""), Base64.NO_WRAP);
            if (body.length > MAX_FILE) throw new IllegalArgumentException("store: file too large");
            //noinspection ResultOfMethodCallIgnored
            target.getParentFile().mkdirs();
            File partial = new File(target.getPath() + ".partial");
            try (FileOutputStream out = new FileOutputStream(partial)) {
                out.write(body);
            }
            if (!partial.renameTo(target)) throw new IllegalStateException("store: file not written");
            call.resolve();
        }
        catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void getFile(PluginCall call) {
        try {
            File target = file(at(call), call.getString("path"));
            JSObject result = new JSObject();
            result.put("body", target.exists() ? Base64.encodeToString(read(target), Base64.NO_WRAP) : JSONObject.NULL);
            call.resolve(result);
        }
        catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        try {
            //noinspection ResultOfMethodCallIgnored
            file(at(call), call.getString("path")).delete();
            call.resolve();
        }
        catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }
}
