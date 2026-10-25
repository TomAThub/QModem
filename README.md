> ## 本分支修改說明（TomAThub fork）
>
> 本分支為 [FUjr/QModem](https://github.com/FUjr/QModem) 的 fork，針對 Hiveton H5000M（OpenWrt 25.12，mediatek/filogic）自編韌體加入以下修改。
>
> ### luci-app-qmodem-next（CPE 管理）
> - **儀表板重寫**：即時上傳/下載速率（netifd 為主、qmodem 統計為備援）、SVG 速率曲線圖、訊號強度與頻點/頻段顯示（內建 LTE EARFCN→頻段對照表；修正 quectel `AT+QGDNRCNT` 上傳/下載方向互換問題）
> - **營運商名稱顯示**：內建 MCC-MNC 對照表，總覽頁與 ISP 徽章顯示電信商名稱
> - **AT 快速指令與 APN 設定檔**：自訂 AT 指令及 APN 設定檔以 uci 儲存、列表顯示目前 APN、漫遊開關（`QNWPREFCFG`）
> - **簡訊修正**：DB 模式下「卡簡訊」刪除不再出現 `Invalid message index`（index 自動以資料庫 id 補上）；SMS 頁面路徑配合移至 `admin/cpe`
> - **其他**：安裝後自動重啟 rpcd 使 ACL 立即生效、選單與權限（ACL）調整
> - **繁體中文介面**：新增 `po/zh_Hant` 翻譯（建置 `luci-i18n-qmodem-next-zh-tw` 套件）
>
> ---

# QModem

English | [简体中文](README.zh-cn.md)

[![OpenWrt SDK build](https://github.com/FUjr/modem_feeds/actions/workflows/main.yml/badge.svg)](https://github.com/FUjr/modem_feeds/actions/workflows/main.yml)

QModem is a cellular modem management and dialing stack for OpenWrt and ImmortalWrt. It discovers USB and PCIe modems, manages AT and data interfaces, and provides dialing, status, SMS, and vendor-specific controls through LuCI.

It is intended for custom 4G/5G routers, embedded gateways, and multi-modem devices. It is not a desktop ModemManager replacement and cannot compensate for kernel drivers missing from the target firmware.

## Capabilities

| Area | Scope |
| --- | --- |
| Discovery | USB and PCIe modems with physical-slot binding |
| Data sessions | QMI, MBIM, NCM, ECM, RNDIS, and others depending on modem and driver |
| Status | SIM, registration, signal, cell, and firmware information |
| Advanced controls | RAT preference, band/cell locking, SIM switching, depending on vendor and model |
| SMS | Send, receive, PDU, and optional forwarding; long-SMS behavior varies by modem |
| OpenWrt integration | UCI, ubus, rpcd, procd, and LuCI |

An entry in the [support list](docs/support_list.md) means that a matching project profile exists. It does not mean every firmware, interface composition, or advanced operation has been verified on hardware by the maintainers.

## Architecture

```text
LuCI
  |
rpcd / ubus
  |
QModem control and dialer ---- modem_scand discovery daemon
  |
generic + vendor adapters
  |
shared AT command wrappers
  |
ubus-at-daemon / tom_modem
  |
USB / PCIe cellular modem
```

The core package is `qmodem`. The pure-JavaScript `luci-app-qmodem-next` is the recommended UI. The legacy `luci-app-qmodem` and separate SMS, MWAN, and TTL packages remain available, but the two main UIs should not be installed together.

## Quick start

Add the feed to `feeds.conf.default` in an OpenWrt source tree:

```text
src-git qmodem https://github.com/FUjr/QModem.git;main
```

Then run:

```sh
./scripts/feeds update qmodem
./scripts/feeds install -a -p qmodem
make menuconfig
```

Select `luci-app-qmodem-next` under `LuCI -> Applications`. The target firmware must also contain USB, serial, QMI, MBIM, or MHI drivers matching the modem, protocol, kernel, and hardware topology.

The detailed English manuals are currently maintained in the existing [user guide](docs/user-guide.md) and [developer guide](docs/developer-guide.md). The new structured documentation is being introduced in Chinese first:

- [User documentation](docs/user/index.zh-cn.md)
- [Developer documentation](docs/developer/index.zh-cn.md)
- [Branch and release policy](docs/release/branch-policy.zh-cn.md)
- [Version migration and issue reporting](docs/release/version-migration.zh-cn.md)
- [Supported hardware](docs/support_list.md)
- [rpcd API](docs/qmodem-rpcd-interface.md)
- [AT fixture development](testcases/README.md)

## Important boundaries

- Do not let multiple management applications read and write the same AT port concurrently.
- Band locking, cell locking, IMEI changes, and modem resets can disrupt service; confirm model support and recovery steps first.
- Kernel packages from a release must match the target firmware ABI. Do not treat `--force-depends` as a compatibility solution.
- A successful package build does not prove that AT operations or data sessions work on a specific modem.

## Reporting issues

Include the router model, firmware and QModem versions, exact modem model, USB/PCIe topology, dialing protocol, and reproducible steps. Redact IMEI, IMSI, ICCID, phone numbers, APNs, credentials, and SMS content before publishing logs or fixtures.

## Contributing

AT commands used by vendor and dialing implementations must be defined through `cmd_*` wrappers under `application/qmodem/files/usr/share/qmodem/cmds/`. CI enforces this boundary. Real-device, redacted fixtures are preferred over screenshots or model-name-only support claims.

## License

The repository [LICENSE](LICENSE) contains the Mozilla Public License 2.0 text plus an additional restriction prohibiting commercial use. It is therefore not an unmodified standard MPL 2.0 grant. Read the complete license before using, distributing, or integrating the project.

## Acknowledgments

QModem uses or builds on work from the 5G-Modem-Support, luci-app-4gmodem, sms_tool, gl-modem-at, sendat, and qosmio/nss-packages communities. Consult the files and Git history in each component for exact provenance and licensing.
