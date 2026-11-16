package cxxi.hub;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Arrays;
import java.util.List;

/**
 * The app's theme on the shell's side (platform.setTheme, app/src/core/theme/theme.ts): the system
 * bars' icons dark on a light theme, light on a dark one, and the window's background behind the
 * WebView. Kept, so that the next start opens in the right colours (MainActivity). Capacitor's
 * SystemBars sets its own style (capacitor.config.ts) once loaded and again on every configuration
 * change (the phone's night mode): the app's theme is put back after it, each time.
 * And the launcher icon in the accent: one launcher alias per accent (AndroidManifest.xml), the
 * chosen one enabled when the app goes to the background (switching a launcher entry may close the
 * app on some launchers, and drops its home screen shortcut: the new icon is in the app drawer).
 */
@CapacitorPlugin(name = "Theme")
public class ThemePlugin extends Plugin {

    private static final String PREFS = "theme";
    private static final int DARK = Color.parseColor("#1c1f24");
    private static final int LIGHT = Color.parseColor("#f3f4f6");
    /** As app/src/core/theme/theme.ts (ACCENTS); the first is the default. */
    private static final List<String> ACCENTS = Arrays.asList("blue", "green", "teal", "purple", "red", "orange", "yellow");

    private static String alias(String accent) {
        return "cxxi.hub.Launcher" + Character.toUpperCase(accent.charAt(0)) + accent.substring(1);
    }

    /** Whether a launcher entry is on (only blue is, by the manifest, until switched). */
    private static boolean enabled(PackageManager pm, Context context, String accent) {
        int state = pm.getComponentEnabledSetting(new ComponentName(context, alias(accent)));
        return state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            || (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && accent.equals("blue"));
    }

    /** Enables the launcher entry of the accent last chosen, and only it. */
    static void applyIcon(Context context) {
        String accent = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("accent", "blue");
        if (!ACCENTS.contains(accent)) return;
        PackageManager pm = context.getPackageManager();
        if (ACCENTS.stream().allMatch(a -> enabled(pm, context, a) == a.equals(accent))) return;
        // the new one first: never a moment without a launcher entry
        pm.setComponentEnabledSetting(new ComponentName(context, alias(accent)), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
        for (String other : ACCENTS) {
            if (other.equals(accent)) continue;
            pm.setComponentEnabledSetting(new ComponentName(context, alias(other)), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
        }
    }

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

    /** After SystemBars, whose first style is posted while the plugins load. */
    @Override
    public void load() {
        Activity activity = getActivity();
        activity.getWindow().getDecorView().post(() -> apply(activity, isDark(activity)));
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        Activity activity = getActivity();
        // posted: runs after every plugin's own handling, SystemBars' included
        activity.getWindow().getDecorView().post(() -> apply(activity, isDark(activity)));
    }

    @PluginMethod
    public void set(PluginCall call) {
        boolean dark = !"light".equals(call.getString("theme"));
        String accent = call.getString("accent", "blue");
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("dark", dark)
            .putString("accent", ACCENTS.contains(accent) ? accent : "blue")
            .apply();
        Activity activity = getActivity();
        activity.runOnUiThread(() -> apply(activity, dark));
        call.resolve();
    }
}
