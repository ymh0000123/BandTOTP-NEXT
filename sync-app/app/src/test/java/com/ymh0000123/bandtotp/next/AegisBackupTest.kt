package com.ymh0000123.bandtotp.next

import org.bouncycastle.crypto.generators.SCrypt
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class AegisBackupTest {

    @Test
    fun encryptedBackupDecryptsAndConvertsEntries() {
        val db = sampleDb()
        val backup = buildEncryptedBackup(db, "correct horse battery staple")

        val decrypted = AegisBackup.decrypt(backup, "correct horse battery staple")
        assertTrue(decrypted.encrypted)
        assertEquals(4, decrypted.db.getJSONArray("entries").length())

        val converted = AegisBackup.convert(decrypted.db)
        assertEquals(3, converted.entries.size)
        assertEquals(1, converted.skipped)

        val first = converted.entries[0]
        assertEquals("GitHub", first.name)
        assertEquals("alice@example.com", first.usr)
        assertEquals("totp", first.type)
        assertEquals("SHA256", first.algorithm)
        assertEquals(8, first.digits)
        assertEquals(60, first.period)
        assertTrue(first.favorite)

        val steam = converted.entries[1]
        assertEquals("steam", steam.type)
        assertEquals(5, steam.digits)

        val hotp = converted.entries[2]
        assertEquals("hotp", hotp.type)
        assertEquals(42L, hotp.counter)

        val payload = BandEntry.payload(converted.entries)
        val json = JSONObject(payload)
        assertEquals(3, json.getJSONArray("list").length())
        assertEquals("SHA256", json.getJSONArray("list").getJSONObject(0).getString("algorithm"))
    }

    @Test
    fun wrongPasswordIsRejected() {
        val backup = buildEncryptedBackup(sampleDb(), "correct")

        try {
            AegisBackup.decrypt(backup, "wrong")
            fail("错误密码应抛出异常")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("解密失败"))
        }
    }

    @Test
    fun passwordIsRequiredForEncryptedBackup() {
        val backup = buildEncryptedBackup(sampleDb(), "correct")

        try {
            AegisBackup.decrypt(backup, null)
            fail("缺少密码应抛出异常")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("需要密码"))
        }
    }

    @Test
    fun plainVaultFileIsReadWithoutPassword() {
        val vault = JSONObject()
            .put("version", 1)
            .put(
                "header",
                JSONObject()
                    .put("slots", JSONObject.NULL)
                    .put("params", JSONObject.NULL)
            )
            .put("db", sampleDb())

        val decrypted = AegisBackup.decrypt(vault, null)
        assertEquals(4, decrypted.db.getJSONArray("entries").length())
        assertEquals(3, AegisBackup.convert(decrypted.db).entries.size)
    }

    @Test
    fun directDatabaseObjectIsSupported() {
        val decrypted = AegisBackup.decrypt(sampleDb(), null)
        assertEquals(3, AegisBackup.convert(decrypted.db).entries.size)
    }

    @Test
    fun yandexAndMotpUseProtocolDefaults() {
        val db = JSONObject()
            .put("version", 3)
            .put(
                "entries",
                JSONArray()
                    .put(
                        JSONObject()
                            .put("type", "yandex")
                            .put("name", "user")
                            .put("issuer", "Yandex")
                            .put(
                                "info",
                                JSONObject()
                                    .put("secret", "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPA")
                                    .put("algo", "SHA1")
                                    .put("digits", 6)
                                    .put("period", 60)
                                    .put("pin", "1234")
                            )
                    )
                    .put(
                        JSONObject()
                            .put("type", "motp")
                            .put("name", "m")
                            .put("issuer", "mOTP")
                            .put(
                                "info",
                                JSONObject()
                                    .put("secret", "KRSXG5CTMVRXEZLU")
                                    .put("algo", "SHA1")
                                    .put("digits", 8)
                                    .put("period", 30)
                                    .put("pin", "9876")
                            )
                    )
            )

        val converted = AegisBackup.convert(db)
        val yandex = converted.entries[0]
        assertEquals("SHA256", yandex.algorithm)
        assertEquals(8, yandex.digits)
        assertEquals("1234", yandex.pin)

        val motp = converted.entries[1]
        assertEquals("MD5", motp.algorithm)
        assertEquals(6, motp.digits)
        assertEquals(10, motp.period)
        assertEquals("9876", motp.pin)
    }

    @Test
    fun issuerWithColonIsSplitWhenIssuerIsMissing() {
        val db = JSONObject()
            .put("version", 3)
            .put(
                "entries",
                JSONArray().put(
                    JSONObject()
                        .put("type", "totp")
                        .put("name", "GitHub:alice")
                        .put("issuer", "")
                        .put(
                            "info",
                            JSONObject()
                                .put("secret", "JBSWY3DPEHPK3PXP")
                                .put("algo", "SHA1")
                                .put("digits", 6)
                                .put("period", 30)
                        )
                )
            )

        val entry = AegisBackup.convert(db).entries[0]
        assertEquals("GitHub", entry.name)
        assertEquals("alice", entry.usr)
    }

    /* ------------------------------------------------------------------ */

    private fun sampleDb(): JSONObject = JSONObject()
        .put("version", 3)
        .put(
            "entries",
            JSONArray()
                .put(
                    JSONObject()
                        .put("type", "totp")
                        .put("uuid", "00000000-0000-4000-8000-000000000001")
                        .put("name", "alice@example.com")
                        .put("issuer", "GitHub")
                        .put("favorite", true)
                        .put(
                            "info",
                            JSONObject()
                                .put("secret", "JBSWY3DPEHPK3PXP")
                                .put("algo", "SHA256")
                                .put("digits", 8)
                                .put("period", 60)
                        )
                )
                .put(
                    JSONObject()
                        .put("type", "steam")
                        .put("name", "player")
                        .put("issuer", "Steam")
                        .put(
                            "info",
                            JSONObject()
                                .put("secret", "KRSXG5CTMVRXEZLU")
                                .put("algo", "SHA1")
                                .put("digits", 5)
                                .put("period", 30)
                        )
                )
                .put(
                    JSONObject()
                        .put("type", "hotp")
                        .put("name", "carol")
                        .put("issuer", "Legacy")
                        .put(
                            "info",
                            JSONObject()
                                .put("secret", "GEZDGNBVGY3TQOJQ")
                                .put("algo", "SHA1")
                                .put("digits", 6)
                                .put("counter", 42)
                        )
                )
                .put(
                    JSONObject()
                        .put("type", "future-type")
                        .put("name", "x")
                        .put("issuer", "x")
                        .put("info", JSONObject().put("secret", "JBSWY3DPEHPK3PXP"))
                )
        )

    private fun buildEncryptedBackup(
        db: JSONObject,
        password: String,
        n: Int = 1024
    ): JSONObject {
        val random = SecureRandom()
        val masterKey = ByteArray(32).also(random::nextBytes)
        val salt = ByteArray(32).also(random::nextBytes)

        val derived = SCrypt.generate(password.toByteArray(Charsets.UTF_8), salt, n, 8, 1, 32)

        val slotNonce = ByteArray(12).also(random::nextBytes)
        val (slotCiphertext, slotTag) = aesGcmEncrypt(derived, slotNonce, masterKey)

        val dbNonce = ByteArray(12).also(random::nextBytes)
        val (dbCiphertext, dbTag) = aesGcmEncrypt(
            masterKey,
            dbNonce,
            db.toString().toByteArray(Charsets.UTF_8)
        )

        return JSONObject()
            .put("version", 1)
            .put(
                "header",
                JSONObject()
                    .put(
                        "slots",
                        JSONArray().put(
                            JSONObject()
                                .put("type", 1)
                                .put("uuid", "11111111-1111-4111-8111-111111111111")
                                .put("key", hex(slotCiphertext))
                                .put(
                                    "key_params",
                                    JSONObject()
                                        .put("nonce", hex(slotNonce))
                                        .put("tag", hex(slotTag))
                                )
                                .put("n", n)
                                .put("r", 8)
                                .put("p", 1)
                                .put("salt", hex(salt))
                                .put("repaired", true)
                                .put("is_backup", false)
                        )
                    )
                    .put(
                        "params",
                        JSONObject()
                            .put("nonce", hex(dbNonce))
                            .put("tag", hex(dbTag))
                    )
            )
            .put("db", Base64.getEncoder().encodeToString(dbCiphertext))
    }

    private fun aesGcmEncrypt(
        key: ByteArray,
        nonce: ByteArray,
        plain: ByteArray
    ): Pair<ByteArray, ByteArray> {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(128, nonce)
        )
        val output = cipher.doFinal(plain)
        val tag = output.copyOfRange(output.size - 16, output.size)
        val ciphertext = output.copyOfRange(0, output.size - 16)
        return ciphertext to tag
    }

    private fun hex(bytes: ByteArray): String {
        val alphabet = "0123456789abcdef"
        val builder = StringBuilder(bytes.size * 2)
        for (byte in bytes) {
            val value = byte.toInt() and 0xff
            builder.append(alphabet[value ushr 4])
            builder.append(alphabet[value and 0x0f])
        }
        return builder.toString()
    }
}
