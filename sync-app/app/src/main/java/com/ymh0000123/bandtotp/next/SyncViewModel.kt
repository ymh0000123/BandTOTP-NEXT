package com.ymh0000123.bandtotp.next

import android.app.Application
import android.content.ContentResolver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xiaomi.xms.wearable.Wearable
import com.xiaomi.xms.wearable.auth.Permission
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.util.Locale

class SyncViewModel(application: Application) : AndroidViewModel(application) {

    data class UiState(
        val deviceName: String? = null,
        val connected: Boolean = false,
        val deviceChecked: Boolean = false,
        val fileName: String = "",
        val encrypted: Boolean = false,
        val requiresPassword: Boolean = false,
        val entries: List<BandEntry> = emptyList(),
        val selectedIndices: Set<Int> = emptySet(),
        val skipped: Int = 0,
        val rawTextPayload: String? = null,
        val busy: Boolean = false,
        val status: String = "等待导入 Aegis 备份",
        val logs: List<String> = emptyList()
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var pendingText: String = ""
    private var nodeId: String? = null

    init {
        refreshDevice()
    }

    /* ------------------------------------------------------------------ */
    /* 设备                                                               */
    /* ------------------------------------------------------------------ */

    fun refreshDevice() {
        val nodeApi = Wearable.getNodeApi(getApplication())

        nodeApi.connectedNodes
            .addOnSuccessListener { nodes ->
                val node = nodes.firstOrNull()
                if (node != null) {
                    nodeId = node.id
                    _state.update {
                        it.copy(
                            connected = true,
                            deviceChecked = true,
                            deviceName = node.name ?: "小米手环"
                        )
                    }
                } else {
                    nodeId = null
                    _state.update {
                        it.copy(
                            connected = false,
                            deviceChecked = true,
                            deviceName = null,
                            status = "未连接手环，请在小米运动健康中连接设备"
                        )
                    }
                }
            }
            .addOnFailureListener { error ->
                nodeId = null
                _state.update {
                    it.copy(
                        connected = false,
                        deviceChecked = true,
                        deviceName = null,
                        status = "查询设备失败：${error.message ?: error.javaClass.simpleName}"
                    )
                }
                log("查询设备失败：${error.message ?: error.javaClass.simpleName}")
            }
    }

    /* ------------------------------------------------------------------ */
    /* 导入                                                               */
    /* ------------------------------------------------------------------ */

    fun loadFromUri(uri: Uri) {
        val resolver = getApplication<Application>().contentResolver

        viewModelScope.launch {
            _state.update { it.copy(busy = true, status = "正在读取分享的文件…") }

            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val name = queryDisplayName(resolver, uri)
                    val text = readLimitedText(resolver, uri, MAX_FILE_BYTES)
                    name to text
                }
            }

            result.onSuccess { (name, text) ->
                loadFromText(text, name)
            }.onFailure { error ->
                fail("读取文件失败：${error.message ?: error.javaClass.simpleName}")
            }
        }
    }

    fun loadFromText(text: String, name: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) {
            fail("导入内容为空")
            return
        }

        pendingText = trimmed

        val looksLikeJson = trimmed.startsWith("{")
        if (!looksLikeJson) {
            val count = countOtpauthLinks(trimmed)
            _state.update {
                it.copy(
                    busy = false,
                    fileName = name,
                    encrypted = false,
                    requiresPassword = false,
                    entries = emptyList(),
                    selectedIndices = emptySet(),
                    skipped = 0,
                    rawTextPayload = trimmed,
                    status = if (count > 0) {
                        "检测到 $count 条 otpauth 链接，将直接发送给手环"
                    } else {
                        "未识别到 otpauth 链接，将把原文发送给手环"
                    }
                )
            }
            log("读取文本：$name")
            return
        }

        viewModelScope.launch {
            _state.update {
                it.copy(
                    busy = true,
                    fileName = name,
                    rawTextPayload = null,
                    status = "正在解析备份…"
                )
            }

            val result = withContext(Dispatchers.Default) {
                runCatching { AegisBackup.parse(trimmed) }
            }

            result.onSuccess { vault ->
                if (AegisBackup.isEncrypted(vault)) {
                    _state.update {
                        it.copy(
                            busy = false,
                            encrypted = true,
                            requiresPassword = true,
                            entries = emptyList(),
                            selectedIndices = emptySet(),
                            skipped = 0,
                            status = "检测到加密备份，请输入密码"
                        )
                    }
                    log("读取加密备份：$name")
                } else {
                    decryptAndConvert(null)
                }
            }.onFailure { error ->
                // 不是合法 JSON 时仍允许把原文交给手环端解析
                val count = countOtpauthLinks(trimmed)
                _state.update {
                    it.copy(
                        busy = false,
                        rawTextPayload = trimmed,
                        entries = emptyList(),
                        selectedIndices = emptySet(),
                        status = if (count > 0) {
                            "JSON 解析失败，检测到 $count 条 otpauth 链接，将直接发送"
                        } else {
                            "JSON 解析失败：${error.message ?: "格式错误"}"
                        }
                    )
                }
                log("JSON 解析失败：${error.message ?: error.javaClass.simpleName}")
            }
        }
    }

    fun decryptAndParse(password: String) {
        if (pendingText.isEmpty()) {
            fail("没有待解析的备份")
            return
        }
        decryptAndConvert(password.ifEmpty { null })
    }

    private fun decryptAndConvert(password: String?) {
        viewModelScope.launch {
            _state.update {
                it.copy(
                    busy = true,
                    status = if (password == null) "正在解析备份…" else "正在解密（scrypt + AES-GCM）…"
                )
            }

            val result = withContext(Dispatchers.Default) {
                runCatching {
                    val vault = AegisBackup.parse(pendingText)
                    val decrypted = AegisBackup.decrypt(vault, password)
                    AegisBackup.convert(decrypted.db)
                }
            }

            result.onSuccess { converted ->
                _state.update {
                    it.copy(
                        busy = false,
                        encrypted = true,
                        requiresPassword = false,
                        entries = converted.entries,
                        selectedIndices = converted.entries.indices.toSet(),
                        skipped = converted.skipped,
                        status = "解析完成：${converted.entries.size} 条令牌" +
                            if (converted.skipped > 0) "，跳过 ${converted.skipped} 条" else ""
                    )
                }
                log(
                    "解析完成：${converted.entries.size} 条" +
                        if (converted.skipped > 0) "，跳过 ${converted.skipped} 条" else ""
                )
            }.onFailure { error ->
                _state.update {
                    it.copy(
                        busy = false,
                        requiresPassword = password != null,
                        entries = emptyList(),
                        selectedIndices = emptySet(),
                        status = "解密/解析失败：${error.message ?: error.javaClass.simpleName}"
                    )
                }
                log("失败：${error.message ?: error.javaClass.simpleName}")
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* 选择                                                               */
    /* ------------------------------------------------------------------ */

    fun toggleEntrySelection(index: Int) {
        _state.update { current ->
            if (index !in current.entries.indices) {
                current
            } else {
                val next = current.selectedIndices.toMutableSet()
                if (!next.add(index)) next.remove(index)
                current.copy(selectedIndices = next)
            }
        }
    }

    fun selectAllEntries() {
        _state.update { it.copy(selectedIndices = it.entries.indices.toSet()) }
    }

    fun clearEntrySelection() {
        _state.update { it.copy(selectedIndices = emptySet()) }
    }

    /* ------------------------------------------------------------------ */
    /* 发送                                                               */
    /* ------------------------------------------------------------------ */

    fun sendToBand() {
        val current = _state.value
        val selectedEntries = current.entries.filterIndexed { index, _ ->
            index in current.selectedIndices
        }

        val payload = when {
            current.entries.isNotEmpty() -> {
                if (selectedEntries.isEmpty()) {
                    fail("请至少选择一条要同步的令牌")
                    return
                }
                BandEntry.payload(selectedEntries)
            }
            !current.rawTextPayload.isNullOrEmpty() -> current.rawTextPayload
            else -> {
                log("没有可发送的内容")
                return
            }
        }

        val targetId = nodeId
        if (targetId == null) {
            _state.update { it.copy(status = "未连接手环，正在重新查询设备…") }
            log("未连接手环")
            refreshDevice()
            return
        }

        val application = getApplication<Application>()
        val authApi = Wearable.getAuthApi(application)

        _state.update { it.copy(busy = true, status = "正在检查设备管理权限…") }

        authApi.checkPermission(targetId, Permission.DEVICE_MANAGER)
            .addOnSuccessListener { granted ->
                if (granted == true) {
                    doSend(targetId, payload, selectedEntries.size)
                } else {
                    authApi.requestPermission(targetId, Permission.DEVICE_MANAGER)
                        .addOnSuccessListener { doSend(targetId, payload, selectedEntries.size) }
                        .addOnFailureListener { error ->
                            fail("设备管理权限申请失败：${error.message ?: error.javaClass.simpleName}")
                        }
                }
            }
            .addOnFailureListener { error ->
                fail("设备权限检查失败：${error.message ?: error.javaClass.simpleName}")
            }
    }

    private fun doSend(targetId: String, payload: String, entryCount: Int) {
        val application = getApplication<Application>()
        val nodeApi = Wearable.getNodeApi(application)
        val messageApi = Wearable.getMessageApi(application)
        val bytes = payload.toByteArray(StandardCharsets.UTF_8)

        if (bytes.size > MAX_MESSAGE_BYTES) {
            fail("内容过大（${formatBytes(bytes.size)}），请拆分后重试")
            return
        }

        _state.update { it.copy(status = "正在检查手环端应用…") }

        nodeApi.isWearAppInstalled(targetId)
            .addOnSuccessListener { installed ->
                if (installed != true) {
                    fail("手环未安装 BandTOTP-NEXT 快应用")
                    return@addOnSuccessListener
                }

                val scheduleSend = {
                    // 给快应用一点冷启动时间
                    Handler(Looper.getMainLooper()).postDelayed({
                        _state.update { it.copy(status = "正在发送 ${formatBytes(bytes.size)}…") }

                        messageApi.sendMessage(targetId, bytes)
                            .addOnSuccessListener {
                                val summary = if (entryCount > 0) "$entryCount 条令牌" else "导入文本"
                                _state.update {
                                    it.copy(busy = false, status = "已发送 $summary 到手环")
                                }
                                log("发送成功：$summary，${formatBytes(bytes.size)}")
                            }
                            .addOnFailureListener { error ->
                                fail("发送失败：${error.message ?: error.javaClass.simpleName}")
                            }
                    }, 700L)
                }

                nodeApi.launchWearApp(targetId, "pages/index")
                    .addOnSuccessListener { scheduleSend() }
                    .addOnFailureListener {
                        log("自动启动手环应用失败，仍尝试发送")
                        scheduleSend()
                    }
            }
            .addOnFailureListener { error ->
                fail("检查手环应用失败：${error.message ?: error.javaClass.simpleName}")
            }
    }

    /* ------------------------------------------------------------------ */
    /* 辅助                                                               */
    /* ------------------------------------------------------------------ */

    private fun fail(message: String) {
        _state.update { it.copy(busy = false, status = message) }
        log(message)
    }

    private fun log(message: String) {
        _state.update { it.copy(logs = (listOf(message) + it.logs).take(MAX_LOGS)) }
    }

    private fun countOtpauthLinks(text: String): Int {
        val regex = Regex("(otpauth(-migration)?|motp)://", RegexOption.IGNORE_CASE)
        return text.lineSequence().count { regex.containsMatchIn(it) }
    }

    private fun queryDisplayName(resolver: ContentResolver, uri: Uri): String {
        return try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (index >= 0) cursor.getString(index) ?: "分享的备份" else "分享的备份"
                } else {
                    "分享的备份"
                }
            } ?: "分享的备份"
        } catch (e: Exception) {
            "分享的备份"
        }
    }

    private fun readLimitedText(resolver: ContentResolver, uri: Uri, limit: Int): String {
        val input = resolver.openInputStream(uri)
            ?: throw IllegalStateException("无法打开文件")

        input.use { stream ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(16 * 1024)
            var total = 0

            while (true) {
                val read = stream.read(buffer)
                if (read < 0) break
                total += read
                if (total > limit) {
                    throw IllegalStateException("文件超过 ${limit / 1024 / 1024} MiB")
                }
                output.write(buffer, 0, read)
            }

            return String(output.toByteArray(), StandardCharsets.UTF_8)
        }
    }

    private fun formatBytes(bytes: Int): String {
        return if (bytes < 1024) {
            "$bytes B"
        } else {
            String.format(Locale.US, "%.1f KiB", bytes / 1024.0)
        }
    }

    companion object {
        private const val MAX_FILE_BYTES = 8 * 1024 * 1024
        private const val MAX_MESSAGE_BYTES = 200 * 1024
        private const val MAX_LOGS = 20
    }
}
