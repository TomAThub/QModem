# apk 安裝說明

本目錄的 `.apk` 由與 `ipks/` **相同的建置**，使用 OpenWrt 官方打包工具
`apk mkpkg`（apk-tools，與官方 25.12 映像同版本）重新打包，檔案格式與官方
OpenWrt 25.12 套件庫的 `.apk` 相同。供使用 **apk** 套件管理的機器安裝，
不需自行編譯；本 repo 的 ipk 流程不受影響。

## 適用對象

- OpenWrt **25.12**（apk 管理）、架構 `aarch64_cortex-a53`
- `luci-*` 介面與翻譯為 `noarch`，其他機器架構可單裝這幾個，但 `qmodem`
  等執行檔相依仍綁 `aarch64_cortex-a53`，架構不符裝了也跑不起來

## 檔案一覽

| 類別 | 套件 |
| --- | --- |
| qmodem 核心與附屬（aarch64_cortex-a53） | `qmodem`、`tom_modem`、`libqmodem-sms`、`qmodem-smsd`、`sms-forwarder-next`、`ubus-at-daemon`、`qmodem-settings`、`qmodem-seal`、`modem_scan`、`sms-tool_q`、`quectel-CM-5G-M`、`ndisc6` |
| LuCI 介面與翻譯（noarch） | `luci-app-qmodem-next`、`luci-i18n-qmodem-next-zh-tw`／`zh-cn`、`luci-app-fan-ctrl`、`luci-i18n-fan-ctrl-zh-tw`、`luci-app-net-topology` |
| 相容庫（aarch64_cortex-a53，見下方說明） | `libubox20251208`、`libblobmsg-json20251208` |

## 安裝

```sh
# 1. 上傳（例：整包傳到 /tmp）
scp apks/*.apk root@192.168.1.1:/tmp/qmodem-apks/

# 2. 驗證（可選）
sha256sum -c SHA256SUMS

# 3. 安裝：未簽章，需 --allow-untrusted；一次給齊讓內部相依自行解析
apk add --allow-untrusted /tmp/qmodem-apks/*.apk
```

安裝後重新整理 LuCI 網頁（Ctrl+F5）即可在選單看到「CPE 管理」等項目。

## 相依說明

1. **外部相依**由目標機器自己的套件源解析，官方 25.12 apk 源均有對應名稱：
   `luci-base`、`rpcd-mod-file`、`jq`、`curl`、`libjson-c5`、`libubus20251202`、
   `libuci20250120`、`terminfo`、`flock`、`bc`、`coreutils` 系列、各 `kmod-usb-*`
   與 `kmod-qmi_wwan_*` 等（`libc` 由系統內建 musl 提供）。
   若機器沒有網路／源，這些相依會安裝失敗，請先確認 `apk update` 正常。
2. **libubox 版本**：qmodem 家族二進位連結 `libubox.so.20251208`／
   `libblobmsg_json.so.20251208`（2025-12 snapshot ABI）。官方 25.12.0 附的是
   `20260213` 版，**請把本目錄的 `libubox20251208` 與 `libblobmsg-json20251208`
   一併安裝**（與新版可共存、無檔案衝突），否則執行檔會找不到函式庫。
3. 自製 `kmod-qmi_wwan_q`／`kmod-qmi_wwan_f`／`kmod-qmi_wwan_s` 不在官方源，
   需自行取得（kiddin9 25.12 源有對應 ipk，但那是 ipk 格式，apk 機器無法直接安裝）。

## 備註

- 套件**未簽章**：`apk add` 需加 `--allow-untrusted`，或自行以
  `apk sign --sign-key <key> *.apk` 簽章後放入自有源。
- 版本政策與 `ipks/` 相同：僅保留最新且運作正常的版本（版本編號見檔名）。
- 打包過程重現 OpenWrt `include/package-pack.mk` 在 apk 模式下的完整佈局
  （`lib/apk/packages/*.list`、conffiles 靜態校验和、post-install／post-upgrade／
  pre-deinstall 包裝腳本、root:root 所有權），並已以 host 端 apk 實際安裝驗證
  檔案、conffiles、uci-defaults 與 i18n 翻譯均正確落地。
