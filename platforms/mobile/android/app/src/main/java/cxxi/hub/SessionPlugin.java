package cxxi.hub;

import android.webkit.CookieManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Makes the refresh-token cookie durable as soon as the server rotates it
 * (the web side calls flush after each login / refresh). The WebView writes
 * cookies to disk lazily: an app killed in between would restart with a token
 * the rotation already revoked, and land on the login screen.
 */
@CapacitorPlugin(name = "Session")
public class SessionPlugin extends Plugin {

    @PluginMethod
    public void flush(PluginCall call) {
        CookieManager.getInstance().flush();
        call.resolve();
    }
}
