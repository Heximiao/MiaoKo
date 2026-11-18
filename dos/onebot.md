# OneBot 11 接入

在「QQ 实例」开始监听目标账号，再到「OneBot 配置」启用端点。端点默认关闭，新建端点的实际地址以控制台显示为准。

| 方式 | 如何连接 |
| --- | --- |
| HTTP API | 设置本机地址并启用，在端点地址后加 `/<动作名>`，支持 GET 参数和 POST JSON。 |
| 正向 WebSocket | 设置本机地址并启用，端点地址支持动作和事件。地址后加 `/api` 仅动作，加 `/event` 仅事件。 |
| 反向 WebSocket | 填写下游的 WebSocket 地址。每个监听账号建立独立连接。 |
| HTTP 回调 | 填写下游 HTTP(S) 地址，以 JSON POST 接收事件。通过 HTTP API 或 WebSocket 执行动作。 |

HTTP API 和正向 WebSocket 可以设置各自的 IPv4 监听地址、端口和路径，保存后生效。监听非回环地址时须设置访问令牌。已有共用 WebUI 端口的端点保留原地址，可通过编辑设置独立端口。

HTTP API 和正向 WebSocket 配置令牌后使用 `Authorization: Bearer <令牌>`。反向 WebSocket 由 MiaoKo 在握手时发送令牌。HTTP 回调配置独立签名密钥后会发送 `X-Signature`。

多账号时，HTTP API 用参数 `self_id` 选择账号，正向 WebSocket 在连接地址加 `?self_id=QQ号`。反向 WebSocket 按连接绑定账号。

## 接入 AstrBot

1. 在 AstrBot 启用 OneBot v11 适配器，确认 WebSocket 路径及端口。同机示例为 `ws://127.0.0.1:6199/ws`。
2. 在 MiaoKo 的「WebSocket 客户端」填写该地址及匹配的令牌并启用。跨机器时填写 MiaoKo 能访问的 AstrBot 地址。
3. 调用 `get_login_info` 确认账号，在测试会话验证消息收发。

反向 WebSocket 向同机 Bot 投递语音时，默认提供按需转码的 WAV 地址。跨机器部署时可设置 `--media-base-url`，提供 AstrBot 能访问的媒体地址。语音转码由 MiaoKo 的 FFmpeg 完成。

## 已实现的动作

「结果」列指 OneBot 响应的 `data` 字段。HTTP 请求返回 200 时仍需检查 `retcode`，为 0 表示成功。

### 消息

| 动作 | 必填参数 | 可选参数 | 结果 |
| --- | --- | --- | --- |
| `send_group_msg` | `group_id`、`message` | `auto_escape` | 对象 `{ "message_id": 123 }` |
| `send_private_msg` | `user_id`、`message` | `auto_escape` | 对象 `{ "message_id": 123 }` |
| `send_msg` | `message` 和对应目标的 `group_id` 或 `user_id` | `message_type`、`auto_escape` | 对象 `{ "message_id": 123 }` |
| `get_msg` | `message_id` |  | 消息对象，含 `message`、`sender`、`time`、`message_type`、`message_id` 和 `real_id`。当前实现的 `real_id` 与 `message_id` 相同 |
| `get_group_msg_history` | `group_id` | `message_seq` 或 `message_id`、`count`、`reverse_order`、`disable_get_url` | `{ "messages": [...] }` |
| `get_friend_msg_history` | `user_id` | `message_seq` 或 `message_id`、`count`、`reverse_order`、`disable_get_url` | `{ "messages": [...] }` |
| `get_forward_msg` | `message_id` 或 `id` |  | `{ "messages": [...] }`，一次展开一层 |
| `send_group_forward_msg` | `group_id`、`messages` |  | `{ "message_id": 123 }` |
| `send_private_forward_msg` | `user_id`、`messages` |  | `{ "message_id": 123 }` |
| `send_forward_msg` | `messages` 和 `group_id` 或 `user_id` | `message_type` | `{ "message_id": 123 }` |
| `delete_msg` | `message_id` |  | QQ 确认撤回后为 `null` |
| `send_poke` | `user_id` | `group_id`、`target_id` | 传群号时戳群成员。QQ 返回原灰条时提供 `poke_id` |
| `group_poke` | `group_id`、`user_id` | `target_id` | QQ 返回原灰条时提供 `poke_id` |
| `friend_poke` | `user_id` | `target_id` | QQ 返回原灰条时提供 `poke_id` |
| `recall_poke` | `poke_id` |  | MiaoKo 扩展。QQ 确认撤回后返回 `{}` |
| `set_msg_emoji_like` | `message_id`、`emoji_id` | `set`，默认 `true`，传 `false` 取消 | `{ "result": true }` |
| `get_emoji_likes` | `message_id`、`emoji_id` | `group_id`、`emoji_type`、`count` | `{ "emoji_like_list": [...] }`，每项包含 `user_id` 和 `nick_name`。省略 `count` 或传 0 时最多返回 3000 项 |
| `send_like` | `user_id` | `times`，1–10，默认 1 | QQ 确认名片点赞后为 `null` |
| `get_profile_like` | 无 | `user_id` 默认当前账号，`start` 默认 0，`count` 默认 10（1–100） | 名片点赞详情，包括 `favoriteInfo.userInfos`、`voteInfo`。点赞明细包含 QQ 返回的 `nick` 和 `count` |

群聊和私聊历史默认查询最近 20 条。`count=0` 使用默认值，超过 100 时按 100 条查询。翻页可传同会话的 `message_id` 或 `message_seq`。同时传值时，非零 `message_seq` 优先。使用 `message_id` 时，`reverse_order` 默认 `true`，否则默认 `false`。`disable_get_url: true` 省略媒体链接。

`message` 支持消息段对象、消息段数组或 CQ 字符串。`auto_escape` 默认 `false`，设为 `true` 时字符串按原文发送。发送视频时，运行环境的 `PATH` 要能找到 `ffmpeg` 和 `ffprobe`。

### 群组和联系人

| 动作 | 必填参数 | 可选参数 | 结果 |
| --- | --- | --- | --- |
| `get_group_list` |  | `no_cache` | 群资料对象数组 |
| `get_group_info` | `group_id` | `no_cache` | 单个群资料对象 |
| `get_group_detail_info` | `group_id` | | QQ 群详情及 OneBot 群资料字段 |
| `set_group_leave` | `group_id` | `is_dismiss`，默认 `false` | `null`。群主解散群需要传 `true` |
| `set_group_admin` | `group_id`、`user_id` | `enable`，默认 `true` | `null` |
| `set_group_name` | `group_id`、`group_name` | | `null` |
| `set_group_card` | `group_id`、`user_id` | `card`，省略或传空字符串清除名片 | `null` |
| `set_group_special_title` | `group_id`、`user_id` | `special_title`，省略或传空字符串清除头衔。`duration` 以秒为单位，默认 `-1`，实际有效期以 QQ 为准 | `{}` |
| `get_essence_msg_list` | `group_id` | | 精华消息数组，包含 `message_id`、`msg_seq`、`msg_random`、`content` 和操作人信息 |
| `set_essence_msg` | `message_id` | | `null` |
| `delete_essence_msg` | `message_id`，或 `group_id`、`msg_seq`、`msg_random` | | `null` |
| `get_group_ignored_notifies` | | | 包含 `invited_requests`、`InvitedRequest`、`join_requests` 的对象 |
| `get_group_ignore_add_request` | | | 被忽略的入群申请数组 |
| `_get_group_notice` | `group_id` | | 群公告数组，包含 `notice_id`、发布者和公告内容 |
| `_del_group_notice` | `group_id`、`notice_id`（也可用 `fid`） | | `null` |
| `get_group_shut_list` | `group_id` | | QQ 返回的禁言成员数组，包含 `uin`、`uid`、`shutUpTime` 等字段 |
| `set_group_member_invite_policy` | `group_id`、`policy` | | `null`。策略可为 `disabled`、`require_approval`、`no_approval`、`no_approval_under_100` |
| `set_group_member_permissions` | `group_id`，以及 `allow_member_upload_album`、`allow_member_temporary_session`、`allow_member_create_group` 中至少一项 | | `null` |
| `set_group_new_member_history_visibility` | `group_id`、`visible` | | `null` |
| `set_group_todo` | `group_id`、`message_id` 或 `message_seq` | | QQ 确认设置待办后为 `null` |
| `complete_group_todo` | `group_id`、`message_id` 或 `message_seq` | | QQ 确认完成待办后为 `null` |
| `cancel_group_todo` | `group_id`、`message_id` 或 `message_seq` | | QQ 确认取消待办后为 `null` |
| `set_group_sign`（别名 `send_group_sign`） | `group_id` | | QQ 确认群打卡后为 `null` |
| `get_group_member_list` | `group_id` | `no_cache` | 群成员对象数组 |
| `get_group_member_info` | `group_id`、`user_id` | `no_cache` | 单个群成员对象 |
| `get_friend_list` |  |  | 好友对象数组，每项包含 `user_id`、`nickname`、`remark` |
| `get_stranger_info`（别名 `get_user_info`） | `user_id` | `no_cache` | 对象包含 `user_id`、`nickname`、`sex`、`age`、QQ 头像地址 `avatar_url` |
| `get_group_root_files` | `group_id` | `file_count` | 群文件根目录的 `files` 和 `folders` |
| `get_group_file_url` | `group_id`、`file_id` | `busid`，默认 102 | `{ "url": "https://..." }` |
| `get_private_file_url` | `file_id` | `user_id` | 私聊文件消息对应的 `{ "url": "..." }` |
| `get_image` | `file` 或 `file_id` | | 图片的 `file`、`url`、`file_id`、`file_name`、`file_size` |
| `get_record` | `file` 或 `file_id` | `out_format` | 语音信息。指定格式时附带 `out_format` 和转码后的 `base64` |
| `get_file` | `file` 或 `file_id` | | 当前账号已收到的图片、语音、视频或私聊文件信息 |
| `create_group_file_folder` | `group_id`、`name`（也可用 `folder_name`） | `parent_id`，默认 `/` | `{ "folder_id": "..." }` |
| `upload_group_file` | `group_id`、`file`、`name` | `folder` 或 `folder_id`，默认根目录 | `{ "file_id": "..." }` |
| `get_qun_album_list` | `group_id` | `attach_info` | `album_list`、`attach_info`、`has_more` |
| `upload_image_to_qun_album` | `group_id`、`album_id`、`file` | `album_name` | QQ 确认上传后为 `null` |

`no_cache` 默认 `false`。查询媒体优先使用消息段里的 `file_id`。语音 `out_format` 支持 `mp3`、`amr`、`wma`、`m4a`、`spx`、`ogg`、`wav`、`flac`。

### 群管理和申请

| 动作 | 必填参数 | 可选参数 |
| --- | --- | --- |
| `set_group_ban` | `group_id`、`user_id` | `duration`，默认 1800 秒，最大 30 天，传 0 解除禁言 |
| `set_group_whole_ban` | `group_id` | `enable`，默认 `true` |
| `set_group_kick` | `group_id`、`user_id` | `reject_add_request`，默认 `false` |
| `set_friend_add_request` | `flag` | `approve`，默认 `true` |
| `set_group_add_request` | `flag`、`sub_type`（`add` 或 `invite`，也可用 `type`） | `approve`，默认 `true`，拒绝时可传 `reason` |

处理申请时，使用该账号从 `request` 事件收到的 `flag`。群申请还要传事件对应的 `sub_type`。这些动作成功后返回 `data: null`。

### 账号和运行状态

| 动作 | 结果 |
| --- | --- |
| `get_login_info` | `user_id` 为当前账号 QQ 号，当前的 `nickname` 用 QQ 号字符串填充 |
| `get_status` | 已绑定账号的状态对象 `{ "online": true, "good": true }` |
| `get_version_info` | `app_name`、`app_version`、`protocol_version`，其中 `protocol_version` 为 `v11` |

账号和状态动作均无需业务参数，仍遵循同一套账号选择规则。
