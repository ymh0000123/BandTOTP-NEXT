package com.ymh0000123.bandtotp.next.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ymh0000123.bandtotp.next.BandEntry
import com.ymh0000123.bandtotp.next.SyncViewModel
import top.yukonga.miuix.kmp.basic.Button
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.Checkbox
import top.yukonga.miuix.kmp.basic.Scaffold
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.basic.TextField
import top.yukonga.miuix.kmp.basic.TopAppBar
import top.yukonga.miuix.kmp.theme.MiuixTheme
import top.yukonga.miuix.kmp.theme.darkColorScheme
import top.yukonga.miuix.kmp.theme.lightColorScheme

private val ConnectedGreen = Color(0xFF33D17A)
private val WarningOrange = Color(0xFFFFB020)

@Composable
fun BandTotpTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()
    MiuixTheme(colors = colors, content = content)
}

@Composable
fun SyncScreen(
    state: SyncViewModel.UiState,
    onRefreshDevice: () -> Unit,
    onFilePicked: (android.net.Uri) -> Unit,
    onDecrypt: (String) -> Unit,
    onToggleEntry: (Int) -> Unit,
    onSelectAll: () -> Unit,
    onClearSelection: () -> Unit,
    onSend: () -> Unit
) {
    var password by remember { mutableStateOf("") }

    val filePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) onFilePicked(uri)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = "BandTOTP-NEXT",
                subtitle = "Aegis 备份 · 本地解密 · 发送到手环"
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item { DeviceCard(state, onRefreshDevice) }

            item {
                ImportCard(
                    state = state,
                    onPickFile = { filePicker.launch(arrayOf("*/*")) }
                )
            }

            if (state.requiresPassword) {
                item {
                    PasswordCard(
                        password = password,
                        onPasswordChange = { password = it },
                        enabled = !state.busy,
                        onDecrypt = {
                            onDecrypt(password)
                            password = ""
                        }
                    )
                }
            }

            if (state.entries.isNotEmpty()) {
                item {
                    EntriesCard(
                        entries = state.entries,
                        selected = state.selectedIndices,
                        skipped = state.skipped,
                        onToggle = onToggleEntry,
                        onSelectAll = onSelectAll,
                        onClearSelection = onClearSelection
                    )
                }
            }

            if (!state.rawTextPayload.isNullOrEmpty()) {
                item { RawTextCard(state.rawTextPayload.length) }
            }

            item {
                SendCard(
                    state = state,
                    onSend = onSend
                )
            }

            item { StatusCard(state.status, state.logs) }

            item { AboutCard() }
        }
    }
}

@Composable
private fun DeviceCard(
    state: SyncViewModel.UiState,
    onRefresh: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        insideMargin = PaddingValues(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(10.dp)
                    .background(
                        if (state.connected) ConnectedGreen else MiuixTheme.colorScheme.disabledOnSurface,
                        CircleShape
                    )
            )
            Spacer(Modifier.width(10.dp))

            Column(Modifier.weight(1f)) {
                Text(
                    text = "小米手环",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = when {
                        state.deviceName != null -> state.deviceName
                        state.deviceChecked -> "未连接"
                        else -> "正在查询…"
                    },
                    fontSize = 13.sp,
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary
                )
            }

            TextButton(
                text = "刷新",
                onClick = onRefresh,
                enabled = !state.busy
            )
        }
    }
}

@Composable
private fun ImportCard(
    state: SyncViewModel.UiState,
    onPickFile: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        insideMargin = PaddingValues(16.dp)
    ) {
        Text(
            text = "导入 Aegis 备份",
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = "在 Aegis 中选择「导出」或「备份」，然后分享到本应用；也可以直接选择 JSON 文件。",
            fontSize = 13.sp,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary
        )

        if (state.fileName.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = "当前文件：${state.fileName}",
                fontSize = 13.sp,
                color = MiuixTheme.colorScheme.primary
            )
        }

        Spacer(Modifier.height(10.dp))
        TextButton(
            text = "选择 JSON 文件",
            onClick = onPickFile,
            enabled = !state.busy
        )
    }
}

@Composable
private fun PasswordCard(
    password: String,
    onPasswordChange: (String) -> Unit,
    enabled: Boolean,
    onDecrypt: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        insideMargin = PaddingValues(16.dp)
    ) {
        Text(
            text = "备份已加密",
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = "解密（scrypt + AES-256-GCM）只在本机完成，密码不会保存或上传。",
            fontSize = 13.sp,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary
        )

        Spacer(Modifier.height(10.dp))
        TextField(
            value = password,
            onValueChange = onPasswordChange,
            modifier = Modifier.fillMaxWidth(),
            label = "Aegis 备份密码",
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            enabled = enabled
        )

        Spacer(Modifier.height(10.dp))
        TextButton(
            text = "解密并解析",
            onClick = onDecrypt,
            enabled = enabled && password.isNotEmpty(),
            colors = ButtonDefaults.textButtonColorsPrimary()
        )
    }
}

@Composable
private fun EntriesCard(
    entries: List<BandEntry>,
    selected: Set<Int>,
    skipped: Int,
    onToggle: (Int) -> Unit,
    onSelectAll: () -> Unit,
    onClearSelection: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        insideMargin = PaddingValues(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = "已选择 ${selected.size} / ${entries.size} 条",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = "点击条目可切换是否同步",
                    fontSize = 12.sp,
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary
                )
            }

            TextButton(
                text = "全选",
                onClick = onSelectAll,
                enabled = selected.size < entries.size
            )
            TextButton(
                text = "全不选",
                onClick = onClearSelection,
                enabled = selected.isNotEmpty()
            )
        }

        entries.forEachIndexed { index, entry ->
            val checked = index in selected

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onToggle(index) }
                    .padding(top = 10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Checkbox(
                    state = if (checked) ToggleableState.On else ToggleableState.Off,
                    onClick = { onToggle(index) }
                )
                Spacer(Modifier.width(10.dp))

                Column(Modifier.weight(1f)) {
                    Text(
                        text = entry.name.ifEmpty { "未命名" },
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Medium,
                        color = if (checked) {
                            MiuixTheme.colorScheme.onSurface
                        } else {
                            MiuixTheme.colorScheme.onSurfaceVariantSummary
                        }
                    )
                    if (entry.usr.isNotEmpty()) {
                        Text(
                            text = entry.usr,
                            fontSize = 12.sp,
                            color = MiuixTheme.colorScheme.onSurfaceVariantSummary
                        )
                    }
                    Text(
                        text = BandEntry.meta(entry),
                        fontSize = 11.sp,
                        color = if (checked) {
                            MiuixTheme.colorScheme.primary
                        } else {
                            MiuixTheme.colorScheme.onSurfaceVariantSummary
                        }
                    )
                }
            }
        }

        if (skipped > 0) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = "跳过 $skipped 条不支持的条目",
                fontSize = 12.sp,
                color = WarningOrange
            )
        }
    }
}

@Composable
private fun RawTextCard(length: Int) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        insideMargin = PaddingValues(16.dp)
    ) {
        Text(
            text = "导入文本",
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = "检测到非 JSON 内容。将直接发送给手环，由手环端解析 otpauth 链接。",
            fontSize = 13.sp,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = "长度：$length 字符",
            fontSize = 12.sp,
            color = MiuixTheme.colorScheme.primary
        )
    }
}

@Composable
private fun SendCard(
    state: SyncViewModel.UiState,
    onSend: () -> Unit
) {
    val count = state.entries.size
    val selectedCount = state.selectedIndices.size
    val hasContent = (count > 0 && selectedCount > 0) || !state.rawTextPayload.isNullOrEmpty()

    Card(
        modifier = Modifier.fillMaxWidth(),
        insideMargin = PaddingValues(16.dp)
    ) {
        Text(
            text = "发送到手环",
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = when {
                count > 0 -> "将发送选中的 $selectedCount / $count 条令牌（含算法、位数、周期）"
                !state.rawTextPayload.isNullOrEmpty() -> "将发送原始导入文本"
                else -> "请先导入 Aegis 备份"
            },
            fontSize = 13.sp,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary
        )

        Spacer(Modifier.height(12.dp))
        Button(
            onClick = onSend,
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.busy && hasContent
        ) {
            Text(
                text = when {
                    state.busy -> "处理中…"
                    count > 0 -> "发送选中的 $selectedCount 条"
                    else -> "发送到手环"
                },
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium
            )
        }
    }
}

@Composable
private fun StatusCard(status: String, logs: List<String>) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        insideMargin = PaddingValues(16.dp)
    ) {
        Text(
            text = "运行状态",
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = status,
            fontSize = 13.sp,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary
        )

        if (logs.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            logs.take(8).forEach { line ->
                Text(
                    text = line,
                    fontSize = 11.sp,
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary
                )
            }
        }
    }
}

@Composable
private fun AboutCard() {
    Card(
        modifier = Modifier.fillMaxWidth(),
        insideMargin = PaddingValues(16.dp)
    ) {
        Text(
            text = "关于",
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = "BandTOTP-NEXT 同步器 1.0.0",
            fontSize = 13.sp,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary
        )
        Text(
            text = "Aegis 备份解密全部在本机完成，手环端只接收明文令牌。",
            fontSize = 13.sp,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary
        )
        Text(
            text = "目标快应用：com.ymh0000123.bandtotp.next（pages/index）",
            fontSize = 13.sp,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary
        )
        Text(
            text = "建议为 Aegis 备份设置强密码，并避免在公共设备上导入。",
            fontSize = 13.sp,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary
        )
    }
}
