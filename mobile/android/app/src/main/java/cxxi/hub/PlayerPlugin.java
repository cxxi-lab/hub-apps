package cxxi.hub;

import android.os.Bundle;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Opens the native player ({@link PlayerActivity}) above the app. The web layer
 * keeps the player logic of desktop's VideoPlayerModal (which URL, which
 * referrer, which bootstrap script) and hands the result over; this side only
 * hosts the WebView, the swipe and the action buttons. Events: `ready`
 * (bootstrap answered, with its result), `closed`, `action` (an action button
 * was tapped: the web side runs it) and `navigate` (a swipe went through: the
 * web side opens that neighbour).
 */
@CapacitorPlugin(name = "Player")
public class PlayerPlugin extends Plugin {

    @Override
    public void load() {
        PlayerActivity.listener = new PlayerActivity.Listener() {
            @Override
            public void onReady(String result) {
                JSObject data = new JSObject();
                data.put("result", result);
                notifyListeners("ready", data);
            }

            @Override
            public void onClosed() {
                notifyListeners("closed", new JSObject());
            }

            @Override
            public void onAction(String id) {
                JSObject data = new JSObject();
                data.put("id", id);
                notifyListeners("action", data);
            }

            @Override
            public void onNavigate(String direction) {
                JSObject data = new JSObject();
                data.put("direction", direction);
                notifyListeners("navigate", data);
            }
        };
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        Bundle options = new Bundle();
        options.putString(PlayerActivity.EXTRA_URL, url);
        options.putString(PlayerActivity.EXTRA_REFERRER, call.getString("referrer"));
        options.putString(PlayerActivity.EXTRA_BOOTSTRAP, call.getString("bootstrap"));
        options.putString(PlayerActivity.EXTRA_POSTER, call.getString("poster"));
        options.putBoolean(PlayerActivity.EXTRA_HAS_PREV, Boolean.TRUE.equals(call.getBoolean("hasPrev", false)));
        options.putBoolean(PlayerActivity.EXTRA_HAS_NEXT, Boolean.TRUE.equals(call.getBoolean("hasNext", false)));
        options.putString(PlayerActivity.EXTRA_PREV_POSTER, call.getString("prevPoster"));
        options.putString(PlayerActivity.EXTRA_NEXT_POSTER, call.getString("nextPoster"));
        JSArray preload = call.getArray("preloadPosters");
        if (preload != null) {
            String[] urls = new String[preload.length()];
            for (int i = 0; i < urls.length; i++) urls[i] = preload.optString(i, null);
            options.putStringArray(PlayerActivity.EXTRA_PRELOAD, urls);
        }
        PlayerActivity.open(getActivity(), options);
        call.resolve();
    }

    /** The actions behind the gear (the whole list each time) and the gear / close icons. */
    @PluginMethod
    public void setActions(PluginCall call) {
        PlayerActivity.actions = call.getArray("actions");
        PlayerActivity.icons = call.getObject("icons");
        PlayerActivity player = PlayerActivity.current;
        if (player != null) player.runOnUiThread(player::renderActions);
        call.resolve();
    }

    /** Tags / info overlay over the video; `panel: null` hides it. */
    @PluginMethod
    public void showPanel(PluginCall call) {
        JSONObject panel = call.getObject("panel");
        PlayerActivity player = PlayerActivity.current;
        if (player != null) player.runOnUiThread(() -> player.showPanel(panel));
        call.resolve();
    }

    @PluginMethod
    public void exec(PluginCall call) {
        PlayerActivity player = PlayerActivity.current;
        String script = call.getString("script");
        if (player != null && script != null) player.exec(script);
        call.resolve();
    }

    @PluginMethod
    public void reload(PluginCall call) {
        PlayerActivity player = PlayerActivity.current;
        if (player != null) player.reload();
        call.resolve();
    }

    @PluginMethod
    public void getBlocklistVersion(PluginCall call) {
        JSObject ret = new JSObject();
        String version = PlayerBlocklist.get(getContext()).version();
        ret.put("version", version != null ? version : JSONObject.NULL);
        call.resolve(ret);
    }

    @PluginMethod
    public void setBlocklist(PluginCall call) {
        String version = call.getString("version");
        JSArray array = call.getArray("hosts");
        if (version == null || array == null) {
            call.reject("version and hosts are required");
            return;
        }
        // ~200k hosts: build the set off the plugin thread.
        new Thread(() -> {
            List<String> hosts = new ArrayList<>(array.length());
            for (int i = 0; i < array.length(); i++) {
                String h = array.optString(i, null);
                if (h != null && !h.isEmpty()) hosts.add(h);
            }
            PlayerBlocklist.get(getContext()).replace(version, hosts);
            call.resolve();
        }).start();
    }

    @PluginMethod
    public void close(PluginCall call) {
        PlayerActivity player = PlayerActivity.current;
        if (player != null) player.runOnUiThread(player::finish);
        call.resolve();
    }
}
