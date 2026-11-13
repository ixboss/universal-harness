package com.jarves.mh

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.jarves.mh.ui.DualModeRoot
import com.jarves.mh.ui.MainViewModel
import com.jarves.mh.ui.PocketDevApp
import com.jarves.mh.ui.theme.PocketTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val vm: MainViewModel = viewModel()
            val state by vm.state.collectAsStateWithLifecycle()
            PocketTheme(themeMode = state.themeMode) {
                // Dual-Mode root (v1.0.0): the switcher picks between the LAN
                // Remote Controller and the On-Device Server; the full local
                // agent UI stays available in on-device mode.
                DualModeRoot {
                    PocketDevApp(vm)
                }
            }
        }
    }
}
