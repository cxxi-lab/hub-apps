package cxxi.hub;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/** Web-side access to {@link IntegrationStore}, mirroring desktop's integrations:* IPC. */
@CapacitorPlugin(name = "Integrations")
public class IntegrationsPlugin extends Plugin {

    @PluginMethod
    public void list(PluginCall call) {
        JSArray entries = new JSArray();
        for (JSONObject entry : IntegrationStore.get(getContext()).list()) entries.put(entry);
        JSObject ret = new JSObject();
        ret.put("entries", entries);
        call.resolve(ret);
    }

    @PluginMethod
    public void apply(PluginCall call) {
        String host = call.getString("host");
        JSObject integration = call.getObject("integration");
        if (host == null || integration == null) {
            call.reject("host and integration are required");
            return;
        }
        long updatedAt = call.getData().optLong("updatedAt");
        new Thread(() -> {
            try {
                IntegrationStore.get(getContext()).apply(host, integration, updatedAt);
                call.resolve();
            } catch (Exception e) {
                call.reject("apply failed: " + e.getMessage(), e);
            }
        }).start();
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String host = call.getString("host");
        if (host == null) {
            call.reject("host is required");
            return;
        }
        new Thread(() -> {
            try {
                IntegrationStore.get(getContext()).remove(host);
                call.resolve();
            } catch (Exception e) {
                call.reject("remove failed: " + e.getMessage(), e);
            }
        }).start();
    }
}
