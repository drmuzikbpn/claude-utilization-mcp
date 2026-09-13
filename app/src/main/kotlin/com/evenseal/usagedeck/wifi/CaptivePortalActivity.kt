package com.evenseal.usagedeck.wifi

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView

/**
 * The minimal in-app browser used to clear a hotel/venue captive portal. It is whitelisted in
 * lock task, so the kiosk never has to be unpinned to get back online. Spec §6.1.
 */
class CaptivePortalActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { CaptivePortalScreen(onDone = { finish() }) }
    }

    companion object {
        /** Requesting this URL is what makes a captive portal serve its login page. */
        const val PROBE_URL = "http://connectivitycheck.gstatic.com/generate_204"
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun CaptivePortalScreen(onDone: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize().background(Color(0xFF0E1013))) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(text = "Captive portal", color = Color(0xFFE8EBEF), fontSize = 16.sp)
            TextButton(onClick = onDone) {
                Text(text = "Done", color = Color(0xFF8C9BFF), fontSize = 16.sp)
            }
        }
        AndroidView(
            modifier = Modifier.fillMaxWidth().weight(1f),
            factory = { context ->
                WebView(context).apply {
                    webViewClient = WebViewClient()
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    loadUrl(CaptivePortalActivity.PROBE_URL)
                }
            }
        )
    }
}
