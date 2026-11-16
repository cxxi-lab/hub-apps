package cxxi.hub;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * The app's notifications by push (Firebase Cloud Messaging data messages, sent by the server's
 * PushPublisher), shown by the system even when the app is closed: one system notification per
 * app notification (its id), updated in place, removed when it goes in the app (read, dismissed).
 * The launcher marks the app's icon while there are some. A tap opens the app where it leads.
 */
public class HubMessagingService extends FirebaseMessagingService {

    static final String CHANNEL = "notifications";
    static final String TAG = "hub";
    static final String EXTRA_LINK = "cxxi.hub.link";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        int id;
        try {
            id = Integer.parseInt(data.get("id"));
        } catch (NumberFormatException e) {
            return;
        }
        NotificationManagerCompat manager = NotificationManagerCompat.from(this);
        if ("remove".equals(data.get("type"))) {
            manager.cancel(TAG, id);
            return;
        }
        if (!"upsert".equals(data.get("type")) || !manager.areNotificationsEnabled()) return;

        ensureChannel(this);
        boolean alert = "1".equals(data.get("alert"));
        String body = data.get("body");
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_hub)
            .setContentTitle(data.get("title"))
            .setContentText(body == null || body.isEmpty() ? null : body)
            .setAutoCancel(true)
            .setOnlyAlertOnce(!alert)
            .setSilent(!alert)
            .setContentIntent(openIntent(id, data.get("link")));
        try {
            manager.notify(TAG, id, builder.build());
        } catch (SecurityException e) {
            // notifications not allowed (Android 13+): nothing to show
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        // the app registers its token with the server at each start (PushPlugin)
    }

    private PendingIntent openIntent(int id, String link) {
        Intent intent = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (link != null && !link.isEmpty()) intent.putExtra(EXTRA_LINK, link);
        return PendingIntent.getActivity(this, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Notifications", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
    }
}
