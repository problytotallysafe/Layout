package com.buildr.layout;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        dispatchDeepLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        dispatchDeepLink(intent);
    }

    @Override
    public void onBackPressed() {
        if (bridge != null && bridge.getWebView() != null && bridge.getWebView().canGoBack()) {
            bridge.getWebView().goBack();
            return;
        }
        moveTaskToBack(true);
    }

    private void dispatchDeepLink(Intent intent) {
        if (intent == null || bridge == null || bridge.getWebView() == null) return;
        Uri data = intent.getData();
        if (data == null) return;

        boolean custom = "buildr-layout".equals(data.getScheme()) &&
            (data.getHost() == null || "open".equals(data.getHost()));
        boolean web = "https".equals(data.getScheme()) &&
            "layout-buildr.vercel.app".equals(data.getHost());
        if (!custom && !web) return;

        String drawingId = data.getQueryParameter("suiteDrawing");
        if (drawingId == null || !drawingId.matches("[A-Za-z0-9_-]{8,80}")) return;
        String safeId = drawingId.replace("\\", "\\\\").replace("'", "\\'");

        bridge.getWebView().postDelayed(() -> bridge.getWebView().evaluateJavascript(
            "window.location.href='/?suiteDrawing=' + encodeURIComponent('" + safeId + "');",
            null
        ), 350);
    }
}
