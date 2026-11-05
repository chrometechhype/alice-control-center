package com.chrometechhype.alicecontrolcenter;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ContextCompat.startForegroundService(this, new Intent(this, PanelService.class));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            // Denied is survivable: the service still runs, the notification is simply hidden. Asking
            // once at startup is cheaper than explaining a panel that looks dead.
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
    }
}
