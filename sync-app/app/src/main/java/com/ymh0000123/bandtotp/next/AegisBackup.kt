package com.ymh0000123.bandtotp.next

import org.bouncycastle.crypto.generators.SCrypt
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Aegis 备份读取 / 解密 / 转换。
 *
 * 解密全部在手机端完成：
 *   - 密码槽: scrypt(password, salt, n, r, p, 32) + AES-256-GCM
 *   - 数据库: masterKey + header.params + AES-256-GCM
 *
 * 手环端只接收明文条目。
 */
object AegisBackup {

    data class Decrypted(val db: JSONObject, val encrypted: Boolean)

    data class Converted(val entries: List<BandEntry>, val skipped: Int)

    private val KNOWN_TYPES = setOf("totp", "steam", "hotp", "yandex", "motp")

    private const val MAX_SCRYPT_MEMORY = 1024L * 1024 * 1024

    fun parse(text: String): JSONObject = JSONObject(text)

    fun isEncrypted(vault: JSONObject): Boolean {
        val header = vault.optJSONObject("header") ?: return false
        val slots = header.optJSONArray("slots") ?: return false
        return slots.length() > 0
    }

    /**
     * @param password 加密备份的密码；明文备份传入 null 或空字符串。
     */
    fun decrypt(vault: JSONObject, password: String?): Decrypted {
        // 直接是数据库对象 {"version":3,"entries":[...]}
        if (vault.has("entries")) {
            return Decrypted(vault, false)
        }

        val header = vault.optJSONObject("header")
        val slots = header?.optJSONArray("slots")

        // 明文 VaultFile: header.slots = null, db 是对象
        if (slots == null || slots.length() == 0) {
            val db = vault.optJSONObject("db")
                ?: throw IllegalArgumentException("备份缺少 db 字段，或格式不受支持")
            return Decrypted(db, false)
        }

        val dbText = vault.optString("db")
        if (dbText.isEmpty()) {
            throw IllegalArgumentException("加密备份的 db 字段无效")
        }
        if (password.isNullOrEmpty()) {
            throw IllegalArgumentException("该备份已加密，需要密码")
        }

        val passwordSlots = mutableListOf<JSONObject>()
        for (i in 0 until slots.length()) {
            val slot = slots.optJSONObject(i) ?: continue
            if (slot.optInt("type", -1) == 1) passwordSlots.add(slot)
        }
        if (passwordSlots.isEmpty()) {
            throw IllegalArgumentException("备份中没有可用的密码槽（可能只包含生物识别槽）")
        }

        val params = header.optJSONObject("params")
            ?: throw IllegalArgumentException("加密备份缺少 header.params")
        val dbNonce = hexToBytes(params.getString("nonce"))
        val dbTag = hexToBytes(params.getString("tag"))
        val dbCiphertext = Base64.getDecoder().decode(dbText.replace(Regex("\\s"), ""))
        val passwordBytes = password.toByteArray(StandardCharsets.UTF_8)

        var lastError: Exception? = null

        for (slot in passwordSlots) {
            try {
                val n = slot.getInt("n")
                val r = slot.getInt("r")
                val p = slot.getInt("p")
                validateScrypt(n, r, p)

                val salt = hexToBytes(slot.getString("salt"))
                val derivedKey = SCrypt.generate(passwordBytes, salt, n, r, p, 32)

                val keyParams = slot.getJSONObject("key_params")
                val masterKey = aesGcmDecrypt(
                    key = derivedKey,
                    nonce = hexToBytes(keyParams.getString("nonce")),
                    ciphertext = hexToBytes(slot.getString("key")),
                    tag = hexToBytes(keyParams.getString("tag"))
                )

                val plain = aesGcmDecrypt(masterKey, dbNonce, dbCiphertext, dbTag)
                val db = JSONObject(String(plain, StandardCharsets.UTF_8))
                return Decrypted(db, true)
            } catch (e: Exception) {
                // 密码错误时 GCM 校验会失败；继续尝试其他密码槽
                lastError = e
            }
        }

        throw IllegalArgumentException(
            "解密失败：密码错误或备份已损坏" +
                (lastError?.message?.let { "（$it）" } ?: ""),
            lastError
        )
    }

    fun convert(db: JSONObject): Converted {
        val entriesArray = db.optJSONArray("entries")
            ?: throw IllegalArgumentException("Aegis 数据缺少 entries 数组")

        val entries = mutableListOf<BandEntry>()
        var skipped = 0

        for (i in 0 until entriesArray.length()) {
            val entry = entriesArray.optJSONObject(i)
            if (entry == null) {
                skipped++
                continue
            }
            val converted = convertEntry(entry)
            if (converted != null) entries.add(converted) else skipped++
        }

        if (entries.isEmpty()) {
            throw IllegalArgumentException("备份中没有可导入的令牌")
        }

        return Converted(entries, skipped)
    }

    private fun convertEntry(entry: JSONObject): BandEntry? {
        val type = entry.optString("type").lowercase()
        if (type !in KNOWN_TYPES) return null

        val info = entry.optJSONObject("info") ?: return null
        val secret = (info.optString("secret").ifEmpty { entry.optString("key") })
            .replace(Regex("[\\s-]"), "")
            .uppercase()
        if (secret.isEmpty()) return null

        val algorithmFallback = when (type) {
            "yandex" -> "SHA256"
            "motp" -> "MD5"
            else -> "SHA1"
        }
        var algorithm = normalizeAlgorithm(info.optString("algo"), algorithmFallback)
        var digits = normalizeDigits(
            info.optInt("digits", 0),
            when (type) {
                "steam" -> 5
                "yandex" -> 8
                else -> 6
            }
        )
        var period = normalizePeriod(info.optInt("period", 0), if (type == "motp") 10 else 30)

        when (type) {
            "motp" -> {
                algorithm = "MD5"
                digits = 6
                period = 10
            }
            "yandex" -> {
                algorithm = "SHA256"
                digits = 8
            }
            "steam" -> {
                digits = normalizeDigits(info.optInt("digits", 0), 5)
            }
        }

        val counter = if (type == "hotp") info.optLong("counter", 0L).coerceAtLeast(0L) else 0L
        val pin = if (info.isNull("pin")) "" else info.optString("pin")

        var displayName = entry.optString("issuer").trim()
        var account = entry.optString("name").trim()
        if (displayName.isEmpty()) displayName = account

        var userName = if (displayName == account) "" else account
        if (userName.isEmpty() && displayName.contains(':')) {
            val idx = displayName.indexOf(':')
            userName = displayName.substring(idx + 1).trim()
            displayName = displayName.substring(0, idx).trim()
            if (displayName.isEmpty()) displayName = userName
        }

        return BandEntry(
            name = displayName,
            usr = userName,
            key = secret,
            type = type,
            algorithm = algorithm,
            digits = digits,
            period = period,
            counter = counter,
            pin = pin,
            favorite = entry.optBoolean("favorite", false)
        )
    }

    private fun normalizeAlgorithm(value: String?, fallback: String): String {
        val cleaned = (value ?: "")
            .uppercase()
            .replace(Regex("[\\s_-]"), "")
            .removePrefix("HMAC")
        return when (cleaned) {
            "SHA1", "SHA256", "SHA512", "MD5" -> cleaned
            else -> fallback
        }
    }

    private fun normalizeDigits(value: Int, fallback: Int): Int =
        if (value in 1..10) value else fallback

    private fun normalizePeriod(value: Int, fallback: Int): Int =
        if (value in 1..86400) value else fallback

    private fun validateScrypt(n: Int, r: Int, p: Int) {
        require(n >= 2 && (n and (n - 1)) == 0 && n <= (1 shl 20)) { "scrypt N 参数异常" }
        require(r in 1..32) { "scrypt r 参数异常" }
        require(p in 1..16) { "scrypt p 参数异常" }
        require(128L * n * r <= MAX_SCRYPT_MEMORY) { "scrypt 参数所需内存过大" }
    }

    private fun aesGcmDecrypt(
        key: ByteArray,
        nonce: ByteArray,
        ciphertext: ByteArray,
        tag: ByteArray
    ): ByteArray {
        require(key.size == 32) { "AES 密钥长度异常" }
        require(nonce.isNotEmpty()) { "GCM nonce 为空" }
        require(tag.size == 16) { "GCM tag 长度异常" }

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(128, nonce)
        )
        return cipher.doFinal(ciphertext + tag)
    }

    private fun hexToBytes(value: String): ByteArray {
        val hex = value.trim()
        require(hex.isNotEmpty() && hex.length % 2 == 0) { "无效的十六进制数据" }
        require(hex.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) {
            "无效的十六进制字符"
        }
        return ByteArray(hex.length / 2) { index ->
            val high = Character.digit(hex[index * 2], 16)
            val low = Character.digit(hex[index * 2 + 1], 16)
            ((high shl 4) or low).toByte()
        }
    }
}
