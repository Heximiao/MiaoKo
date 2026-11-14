# OneBot 11 接入

在「QQ 实例」开始监听目标账号，再到「OneBot 配置」启用端点。端点默认关闭，新建端点的实际地址以控制台显示为准。

| 方式 | 如何连接 |
| --- | --- |
| HTTP API | 默认 `http://127.0.0.1:8765/<动作名>`，支持 GET 参数和 POST JSON。 |
| 正向 WebSocket | 默认 `ws://127.0.0.1:8765/`，支持动作和事件。`/api` 仅动作，`/event` 仅事件。 |
| 反向 WebSocket | 填写下游的 WebSocket 地址。每个监听账号建立独立连接。 |
| HTTP 回调 | 填写下游 HTTP(S) 地址，以 JSON POST 接收事件。通过 HTTP API 或 WebSocket 执行动作。 |

HTTP API 和正向 WebSocket 配置令牌后使用 `Authorization: Bearer <令牌>`。反向 WebSocket 由 MiaoKo 在握手时发送令牌。HTTP 回调配置独立签名密钥后会发送 `X-Signature`。

多账号时，HTTP API 用参数 `self_id` 选择账号，正向 WebSocket 在连接地址加 `?self_id=QQ号`。反向 WebSocket 按连接绑定账号。

## 接入 AstrBot

1. 在 AstrBot 启用 OneBot v11 适配器，确认 WebSocket 路径及端口。同机示例为 `ws://127.0.0.1:6199/ws`。
2. 在 MiaoKo 的「WebSocket 客户端」填写该地址及匹配的令牌并启用。跨机器时填写 MiaoKo 能访问的 AstrBot 地址。
3. 调用 `get_login_info` 确认账号，在测试会话验证消息收发。

## 常用动作

- `send_group_msg`、`send_private_msg` 用于收发联调。使用事件或发送结果中的 `message_id` 查询、引用或撤回消息。
- `get_group_msg_history`、`get_friend_msg_history` 查询历史，`get_forward_msg` 展开合并转发。
- 使用 `get_group_list`、`get_group_member_list` 和 `get_friend_list` 查询会话对象。完整动作名称见 [动作表](../src/onebot/actions/index.mjs)。

发送视频需在系统 `PATH` 中提供 `ffmpeg` 和 `ffprobe`。群文件可使用群号和文件 ID 调用 `get_group_file_url` 获取下载地址。
