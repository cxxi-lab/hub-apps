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

    private static final String FORMER = "https://hub.cxxi.io/api/hub/auth/refresh";
    private static final String CURRENT = "https://hubbyware.cxxi.io/api/hub/auth/refresh";
    /** The server's refresh-token lifetime (refresh_token_ttl): it sets the exact one at the next refresh. */
    private static final long TTL_SECONDS = 2629744;

    /**
     * The server is now hubbyware.cxxi.io: the refresh-token cookie of its former name (hub.cxxi.io,
     * host-only) carried over once, before the WebView loads, so the update keeps the session. To
     * remove with the former name (docs/plan-renommage-hubbyware.md, layer 5).
     */
    static void carryRefreshCookie() {
        try {
            CookieManager manager = CookieManager.getInstance();
            String current = manager.getCookie(CURRENT);
            if (current != null && current.contains("refresh_token=")) return;
            String former = manager.getCookie(FORMER);
            if (former == null) return;
            for (String part : former.split(";\\s*")) {
                if (!part.startsWith("refresh_token=")) continue;
                manager.setCookie("https://hubbyware.cxxi.io", part
                    + "; Path=/api/hub/auth; Secure; HttpOnly; SameSite=None; Max-Age=" + TTL_SECONDS);
                manager.flush();
                return;
            }
        } catch (RuntimeException e) {
            android.util.Log.w("hub-session", "the former session could not be carried over", e);
        }
    }

    @PluginMethod
    public void flush(PluginCall call) {
        CookieManager.getInstance().flush();
        call.resolve();
    }
}
