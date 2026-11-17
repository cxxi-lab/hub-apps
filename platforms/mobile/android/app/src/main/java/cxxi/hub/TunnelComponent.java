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
 * The tunnel, a component of the platform (platforms/tunnel/README.md, server
 * docs/plan-reseau-vpn.md): the APK doesn't carry its native library and no hubby brings it. It
 * is downloaded the first time a hubby going out through the VPN starts the tunnel, kept in the
 * app's files, and loaded only if its sha256 is the one this build pins (BuildConfig, from
 * component.json). Removed when no installed hubby needs it.
 */
final class TunnelComponent {
    private static final String TAG = "TunnelComponent";
    private static final String NAME = "libgojni.so";

    private TunnelComponent() {}

    /** {asset, sha256} for this device's ABI, or null: none pinned (not published yet) or no build for it. */
    private static String[] pin() {
        String abi = Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "";
        String[] pinned;
        if ("arm64-v8a".equals(abi)) pinned = new String[] { BuildConfig.TUNNEL_ARM64_ASSET, BuildConfig.TUNNEL_ARM64_SHA256 };
        else if ("x86_64".equals(abi)) pinned = new String[] { BuildConfig.TUNNEL_X86_64_ASSET, BuildConfig.TUNNEL_X86_64_SHA256 };
        else return null;
        return pinned[1].matches("[0-9a-f]{64}") ? pinned : null;
    }

    private static File root(Context context) {
        return new File(context.getFilesDir(), "components/tunnel");
    }

    private static File file(Context context) {
        return new File(new File(root(context), "v" + BuildConfig.TUNNEL_VERSION), NAME);
    }

    /**
     * The tunnel's library, downloaded if it isn't here (blocking: call it off the main thread).
     * Null: none pinned for this device, or the download failed or doesn't match (never loaded then).
     */
    static synchronized File ensure(Context context) {
        String[] pinned = pin();
        if (pinned == null) return null;
        File lib = file(context);
        try {
            if (lib.isFile()) {
                if (pinned[1].equals(sha256(lib))) return lib;
                Log.e(TAG, "the installed tunnel does not match its pinned sha256: downloaded again");
            }
            deleteTree(root(context));
            File dir = lib.getParentFile();
            if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) throw new IOException("no folder for the tunnel");
            File part = new File(dir, NAME + ".part");
            URL url = new URL(BuildConfig.TUNNEL_URL + pinned[0]);
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
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
            if (!part.renameTo(lib)) throw new IOException("couldn't install the tunnel");
            Log.i(TAG, "tunnel v" + BuildConfig.TUNNEL_VERSION + " installed");
            return lib;
        } catch (Exception e) {
            Log.e(TAG, "the tunnel couldn't be installed", e);
            return null;
        }
    }

    /** No installed hubby needs the VPN any more: the tunnel goes. */
    static synchronized void remove(Context context) {
        File root = root(context);
        if (!root.exists()) return;
        deleteTree(root);
        Log.i(TAG, "tunnel removed: no hubby needs it");
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
