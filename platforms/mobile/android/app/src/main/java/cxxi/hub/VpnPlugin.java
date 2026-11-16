package cxxi.hub;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Web-side control of the embedded tunnel ({@link TunnelManager}), mirroring
 * desktop's vpn:* IPC: status + statusChange events, start/stop, and
 * replaceConfig which picks a wg-quick file, copies it into the app's private
 * files dir and restarts the tunnel.
 */
@CapacitorPlugin(name = "Vpn")
public class VpnPlugin extends Plugin {

    private final TunnelManager.Listener listener = s -> notifyListeners("statusChange", toJs(s));

    @Override
    public void load() {
        TunnelManager.get().addListener(listener);
    }

    @Override
    protected void handleOnDestroy() {
        TunnelManager.get().removeListener(listener);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(toJs(TunnelManager.get().status()));
    }

    @PluginMethod
    public void start(PluginCall call) {
        TunnelManager.get().start(getContext());
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        TunnelManager.get().stop();
        call.resolve();
    }

    @PluginMethod
    public void replaceConfig(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        // .conf has no registered MIME type; the picker would grey it out otherwise.
        intent.setType("*/*");
        startActivityForResult(call, intent, "onConfigPicked");
    }

    @ActivityCallback
    private void onConfigPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = result.getData() != null ? result.getData().getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            call.resolve(replaceResult(false, null, "cancelled"));
            return;
        }
        File dest = TunnelManager.configFile(getContext());
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new Exception("cannot read " + uri);
            String text = TunnelManager.readAll(in);
            if (!text.contains("[Interface]") || !text.contains("[Peer]")) {
                throw new Exception("not a WireGuard config (no [Interface]/[Peer] section)");
            }
            try (FileOutputStream out = new FileOutputStream(dest)) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            call.resolve(replaceResult(false, null, e.getMessage()));
            return;
        }
        TunnelManager.get().stop();
        TunnelManager.get().start(getContext());
        call.resolve(replaceResult(true, dest.getAbsolutePath(), null));
    }

    private static JSObject replaceResult(boolean ok, String path, String error) {
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        ret.put("path", orNull(path));
        if (error != null) ret.put("error", error);
        return ret;
    }

    private static JSObject toJs(TunnelManager.Status s) {
        JSObject ret = new JSObject();
        ret.put("status", s.status);
        ret.put("port", orNull(s.port));
        ret.put("error", orNull(s.error));
        ret.put("endpoint", orNull(s.endpoint));
        return ret;
    }

    /** JSONObject drops a key set to null; the web contract wants an explicit null. */
    private static Object orNull(Object value) {
        return value != null ? value : JSONObject.NULL;
    }
}
