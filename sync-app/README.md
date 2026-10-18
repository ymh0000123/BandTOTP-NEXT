# BandTOTP-NEXT 同步 App

Android 同步器：接收从 Aegis 分享的备份文件，在手机端完成解密，然后把令牌发送到
小米手环快应用 `com.ymh0000123.bandtotp.next`。

## 构建

- JDK 17
- Gradle 9.5.0（`gradle/wrapper/gradle-wrapper.properties`）
- AGP 9.3.3，compileSdk 37，Miuix 0.9.3
- Kotlin 使用 AGP 9 内置编译，Compose 编译器插件 2.4.20

```bash
./gradlew :app:assembleRelease
```

仓库不包含签名密钥和现成 APK。复制 `keystore.properties.example` 为
`keystore.properties`，填入你自己的密钥库信息后再构建；该配置不会入库。

国内网络如无法下载 Gradle，可修改 wrapper 中的 `distributionUrl` 为镜像地址。

## 功能

- `ACTION_SEND` 接收 `application/json`、`text/plain`、`application/octet-stream`
- `ACTION_VIEW` 直接打开 JSON 文件
- 明文备份直接解析；加密备份在 App 内用 scrypt + AES-256-GCM 解密
- 支持 TOTP / Steam / HOTP / Yandex / mOTP，SHA1 / SHA256 / SHA512 / MD5
- 导入后可逐条勾选要同步的令牌，支持全选 / 全不选；只发送选中的条目
- 通过小米 Wearable SDK 的 `MessageApi` 发送 `{"list":[...]}` 到手环
- 发送前自动启动手环端应用；相同密钥的条目在手环端合并

## 隐私

- 不申请网络权限
- 密码只在解密调用期间存在于内存
- `allowBackup=false`
- 分享文件读取上限 8 MiB，消息上限 200 KiB

## 测试

```bash
./gradlew :app:testDebugUnitTest
```

测试覆盖 Aegis 加密备份解密、错误密码、明文备份、直接数据库对象、
Yandex/mOTP 固定参数与 `issuer:account` 拆分。
