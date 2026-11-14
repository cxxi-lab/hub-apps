package cxxi.hub;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Push for the web side: `register()` asks the permission to notify (Android 13+) and returns this
 * device's FCM token, which the app hands to the server; the `open` event carries the link of a
 * notification tapped (kept until the app listens, for a tap that started it).
 */
@CapacitorPlugin(
    name = "Push",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
)
public class PushPlugin extends Plugin {

    @Override
    public void load() {
        HubMessagingService.ensureChannel(getContext());
        handleIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String link = intent.getStringExtra(HubMessagingService.EXTRA_LINK);
        if (link == null) return;
        intent.removeExtra(HubMessagingService.EXTRA_LINK);
        JSObject data = new JSObject();
        data.put("link", link);
        notifyListeners("open", data, true);
    }

    @PluginMethod
    public void register(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "permissionAnswered");
            return;
        }
        resolveToken(call);
    }

    @PermissionCallback
    private void permissionAnswered(PluginCall call) {
        // refused: the token still goes to the server (the notifications come back if allowed later)
        resolveToken(call);
    }

    private void resolveToken(PluginCall call) {
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) {
                call.reject("no push token", task.getException());
                return;
            }
            JSObject result = new JSObject();
            result.put("token", task.getResult());
            call.resolve(result);
        });
    }
}
