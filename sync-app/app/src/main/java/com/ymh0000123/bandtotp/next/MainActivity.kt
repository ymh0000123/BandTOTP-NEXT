package com.ymh0000123.bandtotp.next

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ymh0000123.bandtotp.next.ui.BandTotpTheme
import com.ymh0000123.bandtotp.next.ui.SyncScreen

class MainActivity : ComponentActivity() {

    private val viewModel: SyncViewModel by viewModels()

    private val bluetoothPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        requestBluetoothPermissions()

        setContent {
            val state by viewModel.state.collectAsStateWithLifecycle()

            BandTotpTheme {
                SyncScreen(
                    state = state,
                    onRefreshDevice = viewModel::refreshDevice,
                    onFilePicked = viewModel::loadFromUri,
                    onDecrypt = viewModel::decryptAndParse,
                    onToggleEntry = viewModel::toggleEntrySelection,
                    onSelectAll = viewModel::selectAllEntries,
                    onClearSelection = viewModel::clearEntrySelection,
                    onSend = viewModel::sendToBand
                )
            }
        }

        if (savedInstanceState == null) {
            handleIntent(intent)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun requestBluetoothPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            bluetoothPermissionLauncher.launch(
                arrayOf(
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_SCAN
                )
            )
        }
    }

    /**
     * 支持两种分享方式：
     *   - ACTION_SEND + EXTRA_STREAM：从 Aegis / 文件管理器分享备份文件
     *   - ACTION_SEND + EXTRA_TEXT：其他应用以文本形式分享的备份或 otpauth 链接
     */
    private fun handleIntent(intent: Intent?) {
        if (intent == null) return

        when (intent.action) {
            Intent.ACTION_SEND -> {
                @Suppress("DEPRECATION")
                val streamUri: Uri? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM)
                }

                val text = intent.getStringExtra(Intent.EXTRA_TEXT)

                when {
                    streamUri != null -> viewModel.loadFromUri(streamUri)
                    !text.isNullOrBlank() -> viewModel.loadFromText(text, "分享的文本")
                }
            }

            Intent.ACTION_VIEW -> {
                intent.data?.let { viewModel.loadFromUri(it) }
            }
        }
    }
}
