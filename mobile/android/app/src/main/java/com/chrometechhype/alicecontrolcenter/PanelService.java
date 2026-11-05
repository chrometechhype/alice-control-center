package com.chrometechhype.alicecontrolcenter;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * The panel is a server that has to stay reachable while the screen is off: the SSH connection to the
 * station, the watchdog on the audio route and the scheduled scenarios all live in the node process.
 * Without a foreground component Samsung's memory manager drops the whole app as soon as it leaves the
 * screen, and every return looks like a fresh start. A low-importance notification is what Android
 * reserves for work the user asked to keep running.
 */
public class PanelService extends Service {
    private static final String CHANNEL = "panel";
    private static final int NOTIFICATION = 0xACC0;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        buildChannel();

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL)
                .setContentTitle(getString(R.string.app_name))
                .setContentText("Панель станции работает")
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentIntent(tap)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        // The type comes from the manifest, which is what Android 14 checks; the two-argument call is
        // the one that also exists on the Android 7 this app still installs on.
        startForeground(NOTIFICATION, notification);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        // Android restarts a sticky service when memory allows, but the activity is gone; stopping the
        // node engine with the service keeps a killed app from leaving an orphan behind.
        super.onDestroy();
    }

    private void buildChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        // Creating an existing channel only updates it, so there is nothing to look up first.
        NotificationChannel channel =
                new NotificationChannel(CHANNEL, "Панель станции", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }
}
