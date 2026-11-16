package cxxi.hub;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * Once hub has updated itself (AppUpdaterPlugin), the system restarts it here (MY_PACKAGE_REPLACED,
 * the app's process was killed by the install): it opens the app again.
 *
 * Android (10+) lets an app in the background open its screen only in some cases (e.g. "Display
 * over other apps" granted): the opening may be refused silently, so a notification ("tap to
 * open") is shown too, cleared by MainActivity as soon as it starts.
 */
public class UpdatedReceiver extends BroadcastReceiver {
    private static final String TAG = "hub-updater";
    private static final String PREFS = "hub-updater";
    private static final String KEY_RELAUNCH = "relaunch";
    static final String CHANNEL = "updates";
    static final int NOTIFICATION_ID = 0x0b0b;

    /** Called by the updater just before it installs: only its own updates reopen the app. */
    static void armRelaunch(Context context) {
        prefs(context).edit().putBoolean(KEY_RELAUNCH, true).apply();
    }

    /** The app is open again: the "tap to open" notification goes. */
    static void opened(Context context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        SharedPreferences prefs = prefs(context);
        if (!prefs.getBoolean(KEY_RELAUNCH, false)) return;
        prefs.edit().remove(KEY_RELAUNCH).apply();

        Intent open = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        notifyUpdated(context, open);
        try {
            context.startActivity(open);
            Log.i(TAG, "relaunched after the update");
        } catch (RuntimeException e) {
            Log.w(TAG, "relaunch refused: " + e);
        }
    }

    private static void notifyUpdated(Context context, Intent open) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager system = context.getSystemService(NotificationManager.class);
            if (system.getNotificationChannel(CHANNEL) == null) {
                system.createNotificationChannel(new NotificationChannel(CHANNEL, "Updates", NotificationManager.IMPORTANCE_HIGH));
            }
        }
        PendingIntent tap = PendingIntent.getActivity(context, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String version;
        try {
            version = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception e) {
            version = "";
        }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_hub)
            .setContentTitle("hub updated")
            .setContentText((version == null || version.isEmpty() ? "The new version" : "Version " + version) + " is ready: tap to open.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tap);
        try {
            manager.notify(NOTIFICATION_ID, builder.build());
        } catch (SecurityException e) {
            // notifications not allowed: nothing to show
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
