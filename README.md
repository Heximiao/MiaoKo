# MiaoKo

MiaoKo 是 Windows 桌面 QQ 的 OneBot 11 适配器。你可以在 WebUI 管理已登录的 QQ 实例，把群聊和私聊接入 AstrBot 等应用。

[运行与排错](dos/setup.md) · [OneBot 11 接入](dos/onebot.md) · [问题反馈](https://github.com/Heximiao/MiaoKo/issues)

## 功能

- 查看接收消息和监听状态，管理多个 QQ 账号。
- 支持 HTTP API、正向与反向 WebSocket、HTTP 事件回调。
- 支持消息收发、历史查询、撤回、合并转发及常用的群和好友操作。

## 快速开始

需要 **Windows x64** 和已登录的桌面 QQ。当前适配 QQ **9.9.37-54395（x64）**，启动监听时会校验客户端模块指纹。

### 1. 安装 Conda

电脑上还没有 Conda 时，安装 Windows x64 版 Miniconda。安装后从开始菜单打开 **Anaconda Prompt**（有的版本显示为 **Miniconda Prompt**），输入 `conda --version`。能看到版本号就可以继续。已经装了 Conda 可以直接检查版本。 [Conda 的 Windows 安装说明](https://docs.conda.io/projects/conda/en/latest/user-guide/install/windows.html)

### 2. 创建项目环境

在同一个终端进入项目目录，也就是能看到 `environment.yml` 和 `package.json` 的那一层。把下面的示例路径换成你自己的路径。

```bat
cd /d "D:\MiaoKo"
conda env create --prefix .\.conda -f environment.yml
.\.conda\npm.cmd ci
```

第一条 Conda 命令按配置把 Node.js 20.17.0 和 Python 3.12 安装到项目的 `.conda` 目录。环境创建完成后，`npm ci` 按锁定版本安装项目依赖，也会下载语音转码用的 FFmpeg。首次配置需要联网；直接调用 `.conda` 里的程序即可。

### 3. 启动 MiaoKo

登录桌面 QQ 后，在项目目录运行：

```bat
.\.conda\node.exe .\bin\dashboard.mjs --bind 127.0.0.1
```

打开 [本地控制台](http://127.0.0.1:8765/)，输入终端显示的一次性初始化码并设置管理账号和密码。在「QQ 实例」确认监听状态，再到「OneBot 配置」启用需要的端点。以后在项目目录运行启动命令即可。

## 许可

本仓库提供 WebUI、OneBot 适配层和启动代码。QQ 进程内的 Hook 随仓库提供 DLL。MiaoKo 原创代码及官方 DLL 采用 [MiaoKo 非商业有限再分发许可 1.0](LICENSE)。第三方组件适用各自的许可，详见 [第三方许可声明](THIRD_PARTY_NOTICES.md)。
