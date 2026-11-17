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

import java.io.InputStream;

/**
 * Web-side control of the embedded tunnel ({@link TunnelManager}), mirroring desktop's vpn:* IPC:
 * status + statusChange events, start/stop for a hubby, and each hubby's config (VpnConfigs):
 * replaceConfig picks a wg-quick file, setConfig takes a pasted one, getConfig says whether there
 * is one and its endpoint (never the config), removeConfig drops it.
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
        String hubby = call.getString("hubby");
        TunnelManager.get().start(getContext(), VpnConfigs.validHubby(hubby) ? hubby : null);
        call.resolve();
    }

    @PluginMethod
    public void getConfig(PluginCall call) {
        String hubby = call.getString("hubby");
        String text = VpnConfigs.validHubby(hubby) ? VpnConfigs.read(getContext(), hubby) : null;
        JSObject ret = new JSObject();
        ret.put("configured", text != null);
        ret.put("endpoint", orNull(text != null ? VpnConfigs.endpointOf(text) : null));
        call.resolve(ret);
    }

    @PluginMethod
    public void setConfig(PluginCall call) {
        String hubby = call.getString("hubby");
        String text = call.getString("text");
        if (!VpnConfigs.validHubby(hubby) || text == null) {
            call.resolve(saveResult(false, "invalid config"));
            return;
        }
        call.resolve(save(hubby, text));
    }

    @PluginMethod
    public void removeConfig(PluginCall call) {
        String hubby = call.getString("hubby");
        if (VpnConfigs.validHubby(hubby)) {
            VpnConfigs.remove(getContext(), hubby);
            TunnelManager.Status s = TunnelManager.get().status();
            if (hubby.equals(s.hubby)) TunnelManager.get().stop();
        }
        call.resolve();
    }

    /** Saves a hubby's config; its tunnel, running, restarts with it. */
    private JSObject save(String hubby, String text) {
        try {
            VpnConfigs.write(getContext(), hubby, text);
        } catch (Exception e) {
            return saveResult(false, e.getMessage());
        }
        TunnelManager.Status s = TunnelManager.get().status();
        if (hubby.equals(s.hubby) && !"disabled".equals(s.status)) TunnelManager.get().start(getContext(), hubby, true);
        return saveResult(true, null);
    }

    private static JSObject saveResult(boolean ok, String error) {
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        if (error != null) ret.put("error", error);
        return ret;
    }

    @PluginMethod
    public void stop(PluginCall call) {
        TunnelManager.get().stop();
        call.resolve();
    }

    @PluginMethod
    public void replaceConfig(PluginCall call) {
        String hubby = call.getString("hubby");
        if (!VpnConfigs.validHubby(hubby)) hubby = VpnConfigs.defaultHubby();
        if (hubby == null) {
            call.resolve(replaceResult(false, null, "no hubby goes out through the VPN"));
            return;
        }
        call.getData().put("hubby", hubby);
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
        String hubby = call.getString("hubby");
        String text;
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new Exception("cannot read " + uri);
            text = TunnelManager.readAll(in);
        } catch (Exception e) {
            call.resolve(replaceResult(false, null, e.getMessage()));
            return;
        }
        JSObject saved = save(hubby, text);
        call.resolve(replaceResult(saved.optBoolean("ok"), null, saved.has("error") ? saved.optString("error") : null));
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
        ret.put("hubby", orNull(s.hubby));
        return ret;
    }

    /** JSONObject drops a key set to null; the web contract wants an explicit null. */
    private static Object orNull(Object value) {
        return value != null ? value : JSONObject.NULL;
    }
}
