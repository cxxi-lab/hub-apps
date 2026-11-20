package cxxi.hub;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * The local AI engine for Android, a component of the platform (platforms/ai-engine/README.md,
 * client docs/plan-ia-android.md): one library per engine (text: llama.cpp's server, voice:
 * qwentts.cpp's), not in the APK. Downloaded the first time a hubby needs it, kept in the app's
 * files, loaded only if its sha256 is the one this build pins (BuildConfig, from component.json) —
 * like the tunnel ({@link TunnelComponent}).
 */
final class AiEngineComponent {
    private static final String TAG = "AiEngineComponent";

    private AiEngineComponent() {}

    /** {asset, sha256} of an engine ("text" or "voice"), or null: none pinned or not this device's ABI. */
    private static String[] pin(String engine) {
        String abi = Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "";
        if (!"arm64-v8a".equals(abi) || Build.VERSION.SDK_INT < 28) return null;
        String[] pinned;
        if ("text".equals(engine)) pinned = new String[] { BuildConfig.AI_TEXT_ASSET, BuildConfig.AI_TEXT_SHA256 };
        else if ("voice".equals(engine)) pinned = new String[] { BuildConfig.AI_VOICE_ASSET, BuildConfig.AI_VOICE_SHA256 };
        else return null;
        return pinned[1].matches("[0-9a-f]{64}") ? pinned : null;
    }

    /** Whether this device can have the engine at all (its ABI, a pinned build). */
    static boolean available(String engine) {
        return pin(engine) != null;
    }

    private static File root(Context context) {
        return new File(context.getFilesDir(), "components/ai-engine");
    }

    private static File file(Context context, String engine) {
        return new File(new File(root(context), "v" + BuildConfig.AI_ENGINE_VERSION), "libhubai-" + engine + ".so");
    }

    /**
     * The engine's library, downloaded if it isn't here (blocking: call it off the main thread).
     * Throws when none is pinned for this device, or the download failed or doesn't match.
     */
    static synchronized File ensure(Context context, String engine) throws IOException {
        String[] pinned = pin(engine);
        if (pinned == null) throw new IOException("no AI engine for this device");
        File lib = file(context, engine);
        try {
            if (lib.isFile()) {
                if (pinned[1].equals(sha256(lib))) {
                    readOnly(lib);
                    return lib;
                }
                Log.e(TAG, "the installed " + engine + " engine does not match its pinned sha256: downloaded again");
                lib.delete();
            }
            // another version's files go
            File[] versions = root(context).listFiles();
            if (versions != null) for (File v : versions) if (!v.equals(lib.getParentFile())) deleteTree(v);
            File dir = lib.getParentFile();
            if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) throw new IOException("no folder for the AI engine");
            File part = new File(dir, lib.getName() + ".part");
            HttpURLConnection connection = (HttpURLConnection) new URL(BuildConfig.AI_ENGINE_URL + pinned[0]).openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(60000);
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            } finally {
                connection.disconnect();
            }
            String sum = sha256(part);
            if (!pinned[1].equals(sum)) {
                part.delete();
                throw new IOException("sha256 " + sum + ", expected " + pinned[1]);
            }
            if (!part.renameTo(lib)) throw new IOException("couldn't install the AI engine");
            readOnly(lib);
            Log.i(TAG, engine + " engine v" + BuildConfig.AI_ENGINE_VERSION + " installed");
            return lib;
        } catch (IOException e) {
            Log.e(TAG, "the " + engine + " engine couldn't be installed", e);
            throw e;
        } catch (Exception e) {
            Log.e(TAG, "the " + engine + " engine couldn't be installed", e);
            throw new IOException(e);
        }
    }

    /** Android loads dynamic code only from a file the app can't write. */
    private static void readOnly(File lib) throws IOException {
        if (lib.canWrite() && !lib.setReadOnly()) throw new IOException("couldn't make the AI engine read-only");
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) digest.update(buffer, 0, n);
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
