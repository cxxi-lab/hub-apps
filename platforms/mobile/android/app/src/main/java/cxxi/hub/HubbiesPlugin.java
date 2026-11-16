package cxxi.hub;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import java.util.List;

/**
 * The web layer's side of the hubbies (see {@link HubbyStore}): what is installed, installing or
 * removing one, and the download of the newer versions of a catalogue whose signature it verified.
 */
@CapacitorPlugin(name = "Modules")
public class HubbiesPlugin extends Plugin {

    @PluginMethod
    public void getState(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(HubbyStore.get().state()));
        } catch (Exception e) {
            call.reject("getState failed: " + e.getMessage(), e);
        }
    }

    /** The newer hubby versions already downloaded than what runs: { pending: ["id version"] }. */
    @PluginMethod
    public void pending(PluginCall call) {
        JSObject result = new JSObject();
        result.put("pending", new org.json.JSONArray(HubbyStore.get().pending()));
        call.resolve(result);
    }

    /** Switches to them (the web layer reloads the page right after): { activated: ["id version"] }. */
    @PluginMethod
    public void activate(PluginCall call) {
        JSObject result = new JSObject();
        result.put("activated", new org.json.JSONArray(HubbyStore.get().activate()));
        call.resolve(result);
    }

    @PluginMethod
    public void install(PluginCall call) {
        final String id = call.getString("id");
        final JSObject entry = call.getObject("entry");
        final String baseUrl = call.getString("baseUrl");
        if (id == null || (entry != null && (baseUrl == null || !baseUrl.startsWith("https://")))) {
            call.reject("id (and an https baseUrl with an entry) required");
            return;
        }
        new Thread(() -> {
            try {
                String base = baseUrl == null ? null : (baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
                call.resolve(JSObject.fromJSONObject(HubbyStore.get().install(id, entry, base)));
            } catch (Exception e) {
                Log.w("hub-modules", id + " not installed: " + e.getMessage());
                call.reject(e.getMessage(), e);
            }
        }).start();
    }

    @PluginMethod
    public void uninstall(PluginCall call) {
        final String id = call.getString("id");
        if (id == null) {
            call.reject("id required");
            return;
        }
        new Thread(() -> {
            try {
                HubbyStore.get().uninstall(id);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        }).start();
    }

    @PluginMethod
    public void update(PluginCall call) {
        final JSONArray catalog = call.getArray("catalog");
        final String baseUrl = call.getString("baseUrl");
        if (catalog == null || baseUrl == null || !baseUrl.startsWith("https://")) {
            call.reject("catalog and an https baseUrl are required");
            return;
        }
        new Thread(() -> {
            try {
                List<String> done = HubbyStore.get().update(catalog, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/", call.getBoolean("drop", false));
                JSObject ret = new JSObject();
                ret.put("downloaded", new JSONArray(done));
                call.resolve(ret);
            } catch (Exception e) {
                Log.w("hub-modules", "update failed", e);
                call.reject("update failed: " + e.getMessage(), e);
            }
        }).start();
    }
}
