plugins {
    id("com.android.application") version "9.3.3" apply false
    // AGP 9 内置 Kotlin 编译；仅额外应用 Compose 编译器插件
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.20" apply false
}
