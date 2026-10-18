# 小米 Wearable SDK 内部使用了反射/任务回调
-keep class com.xiaomi.xms.wearable.** { *; }
-dontwarn com.xiaomi.xms.wearable.**

# BouncyCastle
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**

# Miuix / Compose 由默认规则处理
