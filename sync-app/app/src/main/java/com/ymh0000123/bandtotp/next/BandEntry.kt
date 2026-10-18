package com.ymh0000123.bandtotp.next

import org.json.JSONArray
import org.json.JSONObject

/**
 * 发送给手环端快应用的条目结构。
 *
 * 字段名必须与 pages/index/importers.js 的解析逻辑保持一致。
 */
data class BandEntry(
    val name: String,
    val usr: String,
    val key: String,
    val type: String,
    val algorithm: String,
    val digits: Int,
    val period: Int,
    val counter: Long,
    val pin: String,
    val favorite: Boolean
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("name", name)
        put("usr", usr)
        put("key", key)
        put("type", type)
        put("algorithm", algorithm)
        put("digits", digits)
        put("period", period)
        put("counter", counter)
        put("pin", pin)
        put("favorite", favorite)
    }

    companion object {
        fun payload(entries: List<BandEntry>): String {
            val array = JSONArray()
            entries.forEach { array.put(it.toJson()) }
            return JSONObject().put("list", array).toString()
        }

        fun meta(entry: BandEntry): String {
            val parts = mutableListOf(entry.type.uppercase(), entry.algorithm, "${entry.digits}位")
            if (entry.type == "hotp") {
                parts.add("计数器 ${entry.counter}")
            } else {
                parts.add("${entry.period}秒")
            }
            if (entry.pin.isNotEmpty()) parts.add("PIN")
            return parts.joinToString(" · ")
        }
    }
}
