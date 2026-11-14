# 运行与排错

按 [快速开始](../README.md#快速开始) 安装。控制台和 OneBot 收发使用 `build/miaoko-duplex-v33.dll`，独立群发命令使用 `build/miaoko-group-text.dll`。更新 DLL 前，先退出正在使用它的 QQ 进程。

## QQ 版本与监听

只有一个 QQ 实例时，MiaoKo 启动后会尝试自动监听。多开或切换账号后，可以在「QQ 实例」刷新并选中目标账号开始监听。

提示版本不兼容时，用 QQ 安装目录做检查：

```powershell
.\.conda\node.exe .\src\qq\inspect-build.mjs 'C:\path\to\QQ'
```

`known-build` 表示匹配。版本相同但指纹不同会显示 `fingerprint-mismatch`。反馈问题时附上 QQ 版本、检查结果和脱敏日志。

## 控制台

快速开始中的 `--bind 127.0.0.1` 将控制台限制在本机。若需调整监听地址或默认端口 `8765`，在「通用设置」保存后重启，并去掉对应的命令行覆盖参数。

重置管理密码时，停止控制台，然后在交互式终端运行：

```powershell
.\.conda\node.exe .\bin\dashboard.mjs --bind 127.0.0.1 --reset-password
```

根据终端显示的初始化码重新设置密码。运行数据和连接配置保存在 `data/`。
