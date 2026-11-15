package cxxi.hub;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The app's theme on the shell's side (platform.setTheme, app/src/core/theme/theme.ts): the system
 * bars' icons dark on a light theme, light on a dark one, and the window's background behind the
 * WebView. Kept, so that the next start opens in the right colours (MainActivity).
 */
@CapacitorPlugin(name = "Theme")
public class ThemePlugin extends Plugin {

    private static final String PREFS = "theme";
    private static final int DARK = Color.parseColor("#1c1f24");
    private static final int LIGHT = Color.parseColor("#f3f4f6");

    /** The theme last shown (dark until the app says otherwise). */
    static boolean isDark(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("dark", true);
    }

    static void apply(Activity activity, boolean dark) {
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(!dark);
        bars.setAppearanceLightNavigationBars(!dark);
        activity.getWindow().getDecorView().setBackgroundColor(dark ? DARK : LIGHT);
    }

    @PluginMethod
    public void set(PluginCall call) {
        boolean dark = !"light".equals(call.getString("theme"));
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("dark", dark).apply();
        Activity activity = getActivity();
        activity.runOnUiThread(() -> apply(activity, dark));
        call.resolve();
    }
}
