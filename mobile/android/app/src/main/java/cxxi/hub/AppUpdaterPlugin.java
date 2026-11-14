package cxxi.hub;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Sideload self-update for the private APK. The web layer fetches and verifies
 * the signed manifest (Ed25519) and, when a newer versionCode is published,
 * calls {@link #downloadAndInstall}. This plugin downloads the APK, checks its
 * SHA-256 against the manifest, and hands it to the system package installer —
 * the only way to update a sideloaded app without a store. The user still
 * confirms the install in the system dialog.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final String TAG = "hub-updater";

    @PluginMethod
    public void getCurrentVersion(PluginCall call) {
        try {
            PackageInfo info = getContext()
                .getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : (long) info.versionCode;
            JSObject ret = new JSObject();
            ret.put("versionName", info.versionName);
            ret.put("versionCode", code);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("getCurrentVersion failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        final String url = call.getString("url");
        final String expectedSha = call.getString("sha256");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        // Keep the network and hashing off the WebView/UI thread.
        new Thread(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                dir.mkdirs();
                File apk = new File(dir, "hub-update.apk");
                download(url, apk);

                if (expectedSha != null && !expectedSha.isEmpty()) {
                    String actual = sha256(apk);
                    if (!actual.equalsIgnoreCase(expectedSha)) {
                        Log.e(TAG, "sha256 mismatch: expected " + expectedSha + " got " + actual);
                        call.reject("sha256 mismatch: expected " + expectedSha + " got " + actual);
                        return;
                    }
                }

                Log.i(TAG, "downloaded " + url + " (" + apk.length() + " bytes), launching the installer");
                launchInstall(apk);
                call.resolve();
            } catch (Exception e) {
                Log.e(TAG, "downloadAndInstall failed", e);
                call.reject("downloadAndInstall failed: " + e.getMessage(), e);
            }
        }).start();
    }

    private void download(String urlStr, File dest) throws Exception {
        // /releases/ is VPN-only and native HTTP doesn't see the WebView proxy override.
        HttpURLConnection conn = (HttpURLConnection) TunnelManager.get().open(new URL(urlStr));
        try {
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(30_000);
            conn.setReadTimeout(60_000);
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new Exception("HTTP " + status + " fetching " + urlStr);
            }
            try (InputStream in = conn.getInputStream();
                 FileOutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                }
            }
        } finally {
            conn.disconnect();
        }
    }

    private String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) {
                md.update(buf, 0, n);
            }
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    /** The broadcast the system sends back about our install session (explicit: our package only). */
    private static final String INSTALL_STATUS = "cxxi.hub.INSTALL_STATUS";

    /**
     * Hands the APK to the system through a PackageInstaller session (the current API: an ACTION_VIEW
     * on the file is no longer shown by recent Android, the installer screen never came up). The
     * system answers on INSTALL_STATUS: it asks the user to confirm (we show its screen), or, an
     * update of an app we installed ourselves, installs at once.
     */
    private void launchInstall(File apk) throws Exception {
        Context context = getContext();
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        int sessionId = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("hub.apk", 0, apk.length())) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                session.fsync(out);
            }
            registerStatusReceiver();
            // the install kills the app: it reopens once updated (UpdatedReceiver)
            UpdatedReceiver.armRelaunch(context);
            Intent status = new Intent(INSTALL_STATUS).setPackage(context.getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
            session.commit(PendingIntent.getBroadcast(context, sessionId, status, flags).getIntentSender());
        }
    }

    private BroadcastReceiver statusReceiver;

    private void registerStatusReceiver() {
        if (statusReceiver != null) return;
        statusReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                    if (confirm != null && getActivity() != null) {
                        getActivity().runOnUiThread(() -> getActivity().startActivity(confirm));
                    }
                    return;
                }
                if (status != PackageInstaller.STATUS_SUCCESS) {
                    Log.e(TAG, "install failed: " + status + " " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
                    JSObject data = new JSObject();
                    data.put("error", intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
                    notifyListeners("installFailed", data);
                }
            }
        };
        IntentFilter filter = new IntentFilter(INSTALL_STATUS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(statusReceiver, filter);
        }
    }
}
