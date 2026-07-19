# HTTP API 合同

## 1. 总则

- Base URL：`https://www.ruscny.net/v1`。
- 内容：除音频上传与导出外使用 `application/json; charset=utf-8`。
- 时间：ISO 8601 UTC。
- 认证：`Authorization: Bearer <accessToken>`。
- 客户端设备：`X-Device-Id: <stable-random-device-id>`；注册、登录、刷新也在 body 中明确传 `deviceId`。
- 音频提交：`multipart/form-data`，必须带 `Idempotency-Key`。
- 语言：仅 `zh`、`ru`。
- ID：不透明字符串，客户端不得解析或推断。

正式公开域名已经确定为 `www.ruscny.net`。Access/Refresh Token、房间令牌和签名音频 URL 不得写日志。

## 2. 响应封装

成功：

```json
{
  "ok": true,
  "data": {}
}
```

列表的 `data` 可以是数组；未来增加游标时改为：

```json
{
  "ok": true,
  "data": {
    "items": [],
    "nextCursor": null
  }
}
```

客户端必须兼容这两种列表封装，但同一 API 版本的单个端点不能随请求随机改变形状。

失败：

```json
{
  "ok": false,
  "code": "CONVERSATION_NOT_FOUND",
  "message": "会议不存在",
  "details": null,
  "requestId": "req_123"
}
```

- `code` 是客户端逻辑依据，`message` 用于用户提示。
- `details` 只包含脱敏的字段校验信息。
- 生产响应不返回堆栈、SQL、供应商正文、内部 URL 或 Secret。
- 所有响应应带 `X-Request-Id`；客户端可在报错页显示该 ID。

## 3. HTTP 状态

| 状态 | 语义 |
| --- | --- |
| 200 | 查询、更新、幂等结束/退出成功 |
| 201 | 新资源创建成功 |
| 202 | 已受理异步处理，例如未来的后台音频翻译；当前音频接口同步返回最终结果 |
| 204 | 删除成功且无 body；当前客户端也接受 `{ok:true,data:{}}` |
| 400 | schema、语言、音频或业务输入无效 |
| 401 | 未登录、Access/Refresh/Guest Token 失效 |
| 403 | 已知资源但当前操作/历史期限不允许 |
| 404 | 资源不存在或为防枚举而隐藏越权资源 |
| 409 | 邮箱/关系已存在、状态冲突、幂等冲突 |
| 413 | 音频超过大小限制 |
| 429 | 请求/房间码/供应商限流 |
| 500/502/503/504 | 内部或上游故障，不暴露内部细节 |

跨 owner 的 Contact/Conversation 默认返回 404，避免泄露资源是否存在。

健康检查不使用 `/v1` 前缀：

```text
GET /health/live   只证明进程可响应
GET /health/ready  检查 PostgreSQL、实时 Redis 状态，并返回当前 provider 名称
```

生产启动必须连通 Redis；运行期 publisher 或 subscriber 失联时，ready 返回 `503 REALTIME_NOT_READY`，部署平台不得继续把该实例视为可接流量。

同源网页也不使用 `/v1` 前缀：`GET /` 返回客户官网；`GET /account` 返回中俄双语注册/登录页，`GET /register` 与 `GET /login` 为直接入口；`GET /privacy` 和 `GET /terms` 返回中俄双语法律候选页面；`GET /join` 为浏览器参会；`GET /admin` 为服务器管理后台。账号页提交仍使用正式 `POST /v1/auth/register`、`POST /v1/auth/login`、`POST /v1/auth/refresh` 和 `POST /v1/auth/logout` 合同。原 API 服务元信息位于 `GET /v1`。

## 4. 核心数据对象

### User / Guest session

```json
{
  "id": "user_123",
  "role": "USER",
  "displayName": "王经理",
  "email": "host@example.com",
  "phone": null
}
```

正式账号只有一种账号类型，统一返回 `role: "USER"`，产品界面不展示账号类型。`HOST` 只属于某个会议的 Participant 角色：已登录用户创建会议后，服务端把该用户写为该会议 owner，并创建 `Participant.role = HOST`；同一用户加入他人会议时不是该会议主持人。临时身份返回 `GUEST` 和固定 `conversationId`。

### Contact

```json
{
  "id": "contact_123",
  "ownerId": "user_123",
  "linkedUserId": null,
  "displayName": "Ivan",
  "company": "Example LLC",
  "country": "RU",
  "phone": null,
  "email": null,
  "notes": "莫斯科批发商",
  "createdAt": "2026-07-18T09:00:00.000Z",
  "updatedAt": "2026-07-18T09:00:00.000Z"
}
```

`ownerId` 由服务端从创建会议的已认证注册用户生成，不接受客户端覆盖。

### Conversation

```json
{
  "id": "conv_123",
  "ownerId": "user_123",
  "contactId": "contact_123",
  "title": "SPC 产品报价",
  "hostLanguage": "zh",
  "guestLanguage": "ru",
  "status": "WAITING",
  "roomToken": "only-returned-when-authorized",
  "roomCode": "381204",
  "inviteUrl": "https://www.ruscny.net/join/<token>",
  "guestHistoryPolicy": "ACCESS_FOR_24_HOURS",
  "guestAccessExpiresAt": null,
  "expiresAt": "2026-07-19T09:00:00.000Z",
  "startedAt": null,
  "endedAt": null,
  "contact": {
    "id": "contact_123",
    "displayName": "Ivan",
    "company": "Example LLC"
  },
  "messageCount": 0,
  "participantCount": 1,
  "createdAt": "2026-07-18T09:00:00.000Z",
  "updatedAt": "2026-07-18T09:00:00.000Z"
}
```

邀请 Secret 只在创建者明确需要邀请时返回；普通历史列表应返回空值或省略。数据库只保存 token/code 哈希。

### TranslationMessage

```json
{
  "id": "msg_456",
  "messageId": "msg_456",
  "conversationId": "conv_123",
  "participantId": "participant_123",
  "speakerRole": "HOST",
  "speakerDisplayName": "王经理",
  "speakerCompany": "图远科技",
  "speakerLanguage": "zh",
  "sourceLanguage": "zh",
  "targetLanguage": "ru",
  "sourceText": "这个产品有库存。",
  "translatedText": "Этот товар есть в наличии.",
  "audioUrl": "https://www.ruscny.net/v1/audio/assets/tts-...?expires=...&signature=...",
  "status": "FINAL",
  "sequence": 35,
  "startedAtMs": 0,
  "endedAtMs": 2150,
  "provider": "aliyun",
  "errorCode": null,
  "errorMessage": null,
  "createdAt": "2026-07-18T10:20:00.000Z"
}
```

`providerRequestId` 和供应商原始错误默认不返回 App。`audioUrl` 是短期签名地址，可为空。

数据库不保存阿里云返回的临时 URL，而保存 `asset:<opaque-key>` 形式的内部引用；资产在开发环境写本地目录，生产强制写私有 S3 兼容存储。每次 Message DTO 序列化时，服务端生成 `PUBLIC_API_URL` 下默认 15 分钟有效的内部签名播放 URL；客户端不得持久依赖某次响应中的 URL，且每次播放必须携带当前 Access Token。

## 5. 认证

### `POST /auth/register`

正式账号注册：

```json
{
  "displayName": "王经理",
  "email": "host@example.com",
  "password": "minimum-8-characters",
  "deviceId": "random-device-id-at-least-8"
}
```

注册请求不接受账号类型选择；即使旧客户端继续提交 `role`，服务端也会忽略它并创建统一 `USER` 账号。成功 data：

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "user": {
    "id": "user_123",
    "role": "USER",
    "displayName": "王经理",
    "email": "host@example.com"
  }
}
```

错误：`EMAIL_EXISTS`、`VALIDATION_ERROR`。

### `POST /auth/login`

```json
{
  "email": "host@example.com",
  "password": "...",
  "deviceId": "random-device-id-at-least-8"
}
```

成功与注册相同。账号不存在、密码错误或不能登录统一返回 `401 INVALID_CREDENTIALS`，不枚举邮箱。

### `POST /auth/guest`

访客创建仅限一个会议的短期身份。`inviteToken`/`roomToken`/`roomCode` 至少一个有效：

```json
{
  "displayName": "Ivan",
  "company": "Example LLC",
  "email": "ivan@example.com",
  "preferredLanguage": "ru",
  "deviceId": "random-device-id-at-least-8",
  "guestPrincipalToken": "optional-token-returned-by-an-earlier-guest-join",
  "inviteToken": "high-entropy-room-token"
}
```

成功：

```json
{
  "accessToken": "guest-access-token",
  "conversationId": "conv_123",
  "guestIdentityId": "guest_123",
  "guestPrincipalToken": "store-in-platform-secure-storage",
  "role": "GUEST",
  "displayName": "Ivan",
  "email": "ivan@example.com"
}
```

Guest 不发 Refresh Token。`guestPrincipalToken` 是服务端签发的稳定访客主体能力：App 必须存入平台安全存储，后续 Guest 加入时携带，成功响应后以服务端返回值原子替换。普通 logout 保留它，明确“删除访客身份”时清除。旧客户端未携带时仍可以同 `deviceId` 升级；换设备时必须携带。某会议移出只撤销该 GuestIdentity，不全局封禁 GuestPrincipal；服务端同时使旧共享房间凭证失效，防止主动清除客户端标识后重入。

Guest Access Token 与正式账号使用同一短有效期（默认 15 分钟），并绑定当前 GuestIdentity 的 `sessionId`、`deviceId` 和单一 `conversationId`。长会议不延长 Access Token，而是使用下方受控的 Guest 续期端点重新验证服务端关系。被移除、退出、撤销、会议过期或历史授权到期会立即阻止续期。同一会议允许多个 Guest 和注册 Participant。新版本 Guest 必须填写姓名、公司、接收会议纪要的邮箱和语言；邮箱规范化后同时保存到 GuestIdentity 与会议 Participant 快照。缺少或无效资料返回 `VALIDATION_ERROR`；加入错误还包括 `ROOM_NOT_FOUND`、`ROOM_EXPIRED`、`PARTICIPANT_REMOVED`、`GUEST_PRINCIPAL_INVALID`。

### `POST /auth/guest/refresh`

临时参会者的长会话续期。不要求当前 Bearer Token，也不接受共享邀请、房间码、客户端姓名或角色：

```json
{
  "guestPrincipalToken": "stable-token-from-secure-storage",
  "conversationId": "conv_123",
  "deviceId": "same-device-id-used-when-joining"
}
```

成功返回新 `accessToken`、`conversationId`、`guestIdentityId`和服务端保存的姓名/公司/语言快照，不返回 Refresh Token。服务端只通过带 Pepper 的 `guestPrincipalToken` 摘要查找访客主体，在事务内锁定 Conversation、GuestPrincipal、GuestIdentity 和 Participant，验证未撤销/未到期/未移除、会议或历史策略可访问，然后轮换 `sessionId` 并断开旧 Socket。并发 401 恢复在短窗口内收敛到同一会话代际，避免后一个响应立即使前一个响应失效。

`deviceId` 必须与首次入会时服务端保存的值完全一致；`guestPrincipalToken` 不是可跨设备携带的通用 Refresh Token。清除浏览器/App 安全存储后必须通过当前有效邀请重新入会；不能依靠已轮换的旧邀请。未知主体、错误会议/设备、撤销、移除、到期和 CAS 竞争失败统一返回 `401 GUEST_REFRESH_INVALID`，不枚举身份或会议。客户端对一批 401 只发起一次续期；成功后原子替换 Access Token 并重试/重连一次，失败则清理当前会议会话。

### `POST /auth/refresh`

```json
{
  "refreshToken": "...",
  "deviceId": "same-device-id"
}
```

成功返回新 Access、旋转后的新 Refresh 和 User。Access/Refresh 都绑定同一服务端 `sessionId` 会话族；同一会话族内的旧 JTI/Refresh 再用时返回 `REFRESH_TOKEN_REUSED`，并撤销该会话族。同设备重新登录后，上一登录族的 Refresh 只返回 `REFRESH_TOKEN_INVALID`，绝不撤销新登录。设备不匹配返回 `REFRESH_DEVICE_MISMATCH`。缺少会话声明的旧 Token 会被拒绝，部署本轮认证迁移后客户端必须能回到登录页重新认证。

### `GET /auth/me`

需要 Bearer Token。正式账号返回 User；Guest 返回：

```json
{
  "id": "guest_123",
  "role": "GUEST",
  "displayName": "Ivan",
  "company": "Example LLC",
  "conversationId": "conv_123"
}
```

### `PATCH /auth/profile`

正式账号修改自己的资料，Guest 返回 `FORMAL_ACCOUNT_REQUIRED`：

```json
{
  "displayName": "王经理",
  "phone": "+86 13800000000",
  "avatarUrl": "https://cdn.example.com/avatar/user_123.jpg"
}
```

三个字段均可选但至少提供一个；`phone`/`avatarUrl` 可传 null 清空。成功返回不含凭据的 User。当前接口只接受已托管的 HTTPS 头像 URL，不负责上传文件。

### `GET /auth/devices`

正式账号查看自己的设备会话，按最近活跃倒序：

```json
[
  {
    "deviceId": "device-uuid",
    "platform": "ANDROID",
    "lastSeenAt": "2026-07-18T10:20:00.000Z",
    "createdAt": "2026-07-01T08:00:00.000Z",
    "revokedAt": null,
    "isCurrent": true
  }
]
```

不返回 Refresh Token、哈希、pushToken 或内部数据库 ID。Guest 返回 `FORMAL_ACCOUNT_REQUIRED`。

### `DELETE /auth/devices/:deviceId`

正式账号撤销自己名下指定设备，幂等返回 `{deviceId}`。服务端立即设置 revokedAt 并清空该设备 Refresh Token；此后该设备已有 Access Token 的每次 HTTP/Socket 认证也因设备检查返回 `DEVICE_REVOKED`。客户端撤销当前设备时应清空本地 Token 并返回登录页。

### `POST /auth/logout`

```json
{
  "refreshToken": "optional-current-refresh-token"
}
```

幂等。正式账号携带有效 Bearer Token 时，即使 Refresh Token 已丢失、过期或是旧值，服务端也会按 `userId + deviceId + sessionId` 撤销当前设备会话并断开该设备 Socket；若另带可验证的 Refresh Token，还会独立按 `userId + deviceId + sessionId + jti + hash` 精确撤销匹配族。Guest 携带有效 Bearer Token 时使当前 Guest 会话到期、标记其有效 Participant 已离开并断开该主体 Socket，之后仍可凭未失效的新邀请重新授权加入。Guest logout 和续期使用相同的 Conversation 首锁顺序；若自动续期在 Bearer 验证后抢先轮换了代际，已验证的显式 logout 仍使同一 identity/conversation/device 的当前代际失效，不会以旧 `sessionId` CAS=0 静默遗留新会话。无效 Token 不暴露存在性。App 无论网络结果如何都清除本地 Token。

### `DELETE /auth/account`

需要 Bearer Token，不接受客户端传入的 `userId`。注册用户在最近 10 分钟内完成密码登录/注册时可提交空 body；超过窗口返回 `401 RECENT_AUTH_REQUIRED`，重试时提交 `{ "password": "..." }`。Guest 使用当前会议范围内的有效 Bearer 删除该临时身份。成功返回：

```json
{
  "ok": true,
  "data": {}
}
```

服务端锁定相关会议，将正式账号软删除为 `DELETED` 墓碑，清除认证凭证与直接个人资料，将 Participant/User 或 GuestIdentity 关联设为空并匿名化发言人快照。TranslationMessage 的 `participantId`、文本、语言、时间和 `sequence` 保留，不因某一参会者注销破坏其他人的会议历史。注册用户注销时，其作为 owner 创建的活动会议同时结束；成功提交后服务端断开该主体 Socket。该路径不删除共享会议的 TTS 资产，也不代表 Redis、第三方和备份传播已完成；边界见 [账号注销](./ACCOUNT_DELETION.md) 和 [当前限制](./KNOWN_LIMITATIONS.md)。

### `POST /auth/password/forgot`

```json
{ "email": "user@example.com" }
```

无论邮箱是否存在都返回统一受理结果，避免账号枚举。发送验证码/邮件、过期、频率限制和密码重置完成接口必须在正式启用前补齐；未配置邮件服务时应明确返回功能未启用，不能假成功让用户等待。

自助“忘记密码”邮件发送路径当前稳定返回 `501 PASSWORD_RESET_NOT_CONFIGURED`，不会伪称邮件已发送。服务器管理员可通过独立的一次性凭证流程完成人工重置；自助发送链仍需正式邮件服务后才能开放。

## 6. 客户管理（注册用户）

所有端点要求正式 `USER`，并强制 `ownerId = auth.subjectId`。账号类型不决定主持人资格；任何注册用户都能维护自己的客户并创建会议。

### `GET /contacts`

查询：`search` 可选，匹配显示名称/公司。当前返回 `{items: Contact[]}`；生产数据量增长后必须加入游标分页。

### `POST /contacts`

```json
{
  "displayName": "Ivan",
  "company": "Example LLC",
  "country": "RU",
  "phone": null,
  "email": null,
  "notes": "莫斯科批发商"
}
```

`displayName` 必填；其他字段可选。客户端不得传 `ownerId`。

### `GET /contacts/:contactId`

只返回当前注册用户自己的 Contact。其他用户的 ID 也返回 `CONTACT_NOT_FOUND`。

### `PATCH /contacts/:contactId`

允许更新：`displayName`、`company`、`country`、`phone`、`email`、`notes`。不允许更新 `ownerId`。`linkedUserId` 应通过单独验证流程绑定，不能直接信任普通 PATCH。

### `DELETE /contacts/:contactId`

若仍有 Conversation，建议返回 `409 CONTACT_HAS_CONVERSATIONS`，避免级联混乱；产品应先删除/迁移允许处理的会议。不得把已有会议改绑到其他客户。

## 7. 会议

### `POST /conversations`（注册用户）

```json
{
  "contactId": "contact_123",
  "title": "SPC 产品报价",
  "hostLanguage": "zh",
  "guestLanguage": "ru",
  "guestHistoryPolicy": "ACCESS_FOR_24_HOURS"
}
```

服务端验证 Contact 属于当前注册用户，以认证主体写入 `ownerId`，并为创建者建立 `Participant.role = HOST`；随后固定 `zh ⇄ ru`，生成高熵 roomToken、独立 6–8 位 roomCode 和邀请 URL。成功返回 Conversation 和一次性明文邀请字段。`contactId` 创建后不可 PATCH。

历史策略：`NO_ACCESS_AFTER_END | ACCESS_FOR_24_HOURS | ACCESS_FOR_7_DAYS | PERMANENT`。

### `POST /conversations/:id/invitation/rotate`（Host）

Host 可为自己尚未结束、尚未过期的会议轮换邀请。成功 data 直接返回：

```json
{
  "conversationId": "conv_123",
  "roomToken": "new-high-entropy-token",
  "roomCode": "592381",
  "inviteUrl": "https://www.ruscny.net/join/new-high-entropy-token",
  "expiresAt": "2026-07-19T09:00:00.000Z"
}
```

响应使用 `private, no-store`；新凭证提交后旧 `roomToken` 和旧 `roomCode` 立即失效。并发轮换不会让较早请求覆盖较新的凭证；冲突返回 `409 INVITATION_ROTATE_CONFLICT`，随机凭证连续碰撞返回 `409 INVITATION_COLLISION`。结束会议返回 `409 ROOM_ENDED`，过期会议返回 `403 ROOM_EXPIRED`。

### `POST /conversations/join`

其他正式注册用户或已经获得 Guest Token 的主体加入：

```json
{
  "roomToken": "high-entropy-token",
  "displayName": "王伟",
  "company": "示例公司",
  "language": "zh"
}
```

也可使用 `roomCode` 代替 `roomToken`。注册用户进入前可用本次会议的 `displayName`、`company`、`language`（`zh`/`ru`）确认或覆盖账号默认资料；临时用户的完整资料在 Guest Token 创建时已由服务端保存。服务端验证身份、状态、期限并为每一名注册用户或临时用户建立/恢复独立且稳定的 Participant，不限制会议只能有一名客户；成功返回包含完整参会者列表的 Conversation。房间码应按 IP/设备/账号限速。若该正式用户或临时 Guest 的 Participant 已被 Host 移除，服务端保留移除标记并统一返回 `403 PARTICIPANT_REMOVED`；同一账号/访客身份不能用原邀请令牌或房间码重新加入。

### `GET /conversations`

注册用户：返回自己创建的全部会议，以及自己参与且仍有历史权限的其他会议。Guest：最多当前会议。

查询：

- `contactId`：Host 按客户筛选。
- `search`：标题搜索。
- `from` / `to`：UTC 时间范围。
- 生产分页预留 `cursor` / `limit`。

### `GET /conversations/:conversationId`

返回当前主体可访问的 Conversation。历史策略过期返回 `HISTORY_ACCESS_EXPIRED`；越权 ID 返回 `CONVERSATION_NOT_FOUND`。

### `PATCH /conversations/:conversationId`（Host）

第一版只允许修改标题：

```json
{ "title": "包装方式确认" }
```

禁止修改 `ownerId`、`contactId`、语言、roomToken、roomCode、status 和 sequence。历史策略若允许修改，应使用单独字段白名单并记录审计。

### `POST /conversations/:conversationId/end`（Host）

无 body，幂等。原子设置 `ENDED`、`endedAt` 和 `guestAccessExpiresAt`，然后广播 `room.ended`。与音频上传竞态时，数据库事务中的状态校验决定是否接收；结束后绝不新增翻译。

### `DELETE /conversations/:conversationId/participants/:participantId`（Host）

移出当前会议中仍有效的非主持人 Participant。服务端验证会议属于当前 Host，将目标 Participant 标记为 `REMOVED`；若是临时 Guest，同时撤销并到期其 GuestIdentity；若是注册用户，撤销该会议的 App 内邀请。会议和其他参会者状态不变，服务端广播 `participant.removed` 并立即断开目标 Socket。成功：

```json
{
  "conversationId": "conv_123",
  "participantId": "participant_123",
  "removedAt": "2026-07-19T10:30:00.000Z",
  "invitationRotated": true
}
```

移出临时 Guest 时，服务端会在同一行锁事务中撤销 GuestIdentity 并使旧 `roomToken`/`roomCode` 立即失效，防止通过更换客户端设备 ID 绕过移出。响应中 `invitationRotated=true`，主持人需调用邀请轮换接口获得新明文链接/房间码；已接受的注册用户参会关系不受该共享凭证轮换影响。移出注册用户时该字段为 `false`。不能移出 Host，也不能用一个会议的 participantId 操作另一会议。已不存在或已移出时返回 `404 PARTICIPANT_NOT_FOUND`。被移出主体此后对该会议的 HTTP/Socket 授权均失效；完整 Participant 快照保留该行并显示 `REMOVED`。

### `DELETE /conversations/:conversationId`（Host）

二次确认由 App 负责。服务端验证 owner 并锁定会议，在同一 PostgreSQL 事务内先为所有 TTS 引用写入 `AudioDeletionJob`，再级联删除 Conversation、Participant、Message 和 Summary。提交后 worker 抢占任务并删除本地/S3 对象，失败会指数退避重试，不会把已提交的会议删除误报为回滚。成功 data 为 `{}`。重复删除不应泄露其他 Host 资源。该路径不覆盖 Redis、第三方和备份传播，边界见 [账号注销](./ACCOUNT_DELETION.md)。

## 8. 消息与音频

### `GET /conversations/:conversationId/messages`

查询：

```text
afterSequence=34
limit=100
```

`afterSequence` 默认 0，`limit` 应限制在安全范围。读取前，服务端会把超过完整 provider 处理窗口仍停留在 `PROCESSING` 的消息原子改为 `FAILED / PROCESSING_TIMEOUT`；当前窗口为 `max(120 秒, 4 × ALIYUN_REQUEST_TIMEOUT_MS)`。随后返回当前主体有权读取且 sequence 更大的消息，升序。该端点是 Socket.IO 重连补拉的权威后备；历史权限在每次请求重新验证。

### `POST /conversations/:conversationId/audio`

Headers：

```http
Authorization: Bearer <accessToken>
Idempotency-Key: <uuid>
Content-Type: multipart/form-data
```

Fields：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `audio` | file | 非空、真实类型、大小 ≤ `UPLOAD_MAX_BYTES` |
| `sourceLanguage` | `zh | ru` | 必填，与用户按键一致 |
| `targetLanguage` | `ru | zh` | 必须是来源的相反方向 |

当前允许 AAC/M4A/MP3/Ogg/Opus/WAV 以及浏览器 `MediaRecorder` 生成的 WebM/Opus；服务端同时校验 MIME 与扩展名，并在送入 provider 前把 `audio/webm;codecs=opus` 标准化为 `audio/webm`。生产发布前仍必须用目标 iOS/Android 浏览器与真实 ASR 账号做格式验收。

处理前验证：Participant 属于该 Conversation、会议可发言、未过期/结束、语言有效、幂等键有效。验证失败不得调用阿里云。

受理响应可以是 202：

```json
{
  "messageId": "msg_456",
  "conversationId": "conv_123",
  "status": "PROCESSING"
}
```

相同 Conversation、Participant 和 Idempotency-Key 的重试返回同一 messageId，不创建第二条。最终结果通过 Socket.IO 广播，并可在 messages API 查询。

当前实现会等待 ASR、MT 和 TTS（TTS 可降级）后返回最终 Message DTO，因此 HTTP 状态为 200；处理中、最终或失败事件仍会广播。文字入口在创建 `PROCESSING` 行时即保存客户端提交且已校验的原文；语音入口在 ASR 成功后以 CAS 写入识别原文，因此后续 MT/TTS 失败仍保留已知原文。调用外部 provider 前和写入最终/失败结果前都会在 Conversation 首锁事务中重新校验设备/Guest 会话和 Participant 写权限，退出、移出、结束或撤销先发生时不得提交结果或广播权限错误。TTS 成功只有在受信阿里云 host 的临时资产已由后端下载并持久化为内部 asset ref 后才成立，上游 URL 不进入响应或数据库。若后续改为后台队列，才切换为上述 202 受理响应，且需要保持 messageId 和幂等语义不变。

### `POST /conversations/:conversationId/messages/text`

这是阶段 5 文字同步/受控手工文本入口，跳过 ASR，但仍经过同一会议状态、Participant、幂等、Qwen-MT、TTS、持久化和 Socket.IO 广播链路：

```json
{
  "sourceText": "这个产品有库存。",
  "sourceLanguage": "zh",
  "targetLanguage": "ru",
  "idempotencyKey": "client-generated-key"
}
```

`targetLanguage` 可省略，服务端自动取相反方向；幂等键可由 `Idempotency-Key` header 传入，优先于 body。生产 UI 如不提供文字输入，应隐藏入口但仍保留服务端授权、限流和审计，不能把它当作无需 Participant 的调试后门。

### `GET /audio/assets/:key?expires=<unix>&signature=<hmac>`

内部音频播放端点同时要求短期 HMAC 签名和 `Authorization: Bearer <access-token>`。服务端先验证 asset key/过期时间（默认 900 秒），再由该 asset ref 反查 `conversationId`；真正发送音频字节前，会在同一个 Conversation 首锁事务中重新执行当前设备/Guest 会话、Participant 和历史权限校验。因此被移出、会后授权过期或会话撤销会立即阻止旧 URL 播放，不需等签名自然过期。签名无效返回 `403 AUDIO_URL_INVALID`，资产不存在返回 `404 AUDIO_NOT_FOUND`。客户端应直接使用 Message DTO 的完整 `audioUrl` 并在播放请求携带当前 Access Token，不得自行拼接或延长签名。

### 播放 URL 刷新与 TTS 重试

播放 URL 刷新已由 Message DTO 自动完成：重新调用 messages API，或通过 `room.join` 补拉，会为仍存在的 asset ref 生成新的短期签名 URL；无需把阿里云 URL 暴露给 App。

独立 TTS 重试仍是发布扩展，建议：

```http
POST /v1/conversations/:conversationId/messages/:messageId/tts
```

只允许当前会议授权主体，验证 message 与 conversation 的组合归属。按 messageId 幂等重试 TTS，不创建新消息。该端点未落地前，TTS 生成失败的消息只能保留文本；已有资产的过期 URL 可通过重新获取 Message DTO 刷新。

## 9. 导出

```http
GET /v1/conversations/:conversationId/export?format=txt
GET /v1/conversations/:conversationId/export?format=md
```

Host 和仍有历史权限的参与者可按产品策略导出。响应使用安全文件名、UTF-8、`Content-Disposition: attachment`，只包含该 conversationId 的终态消息（`FINAL` 与 `FAILED`），排除尚未稳定的 `PROCESSING`。失败消息保留已识别原文、失败状态和公开错误信息；没有原文或译文时输出明确占位，`FINAL / TTS_FAILED` 也保留语音合成降级状态。不能接受任意文件路径或跨会议列表。移动端本地导出遵循相同规则，并且只能使用已经通过权限接口取得的当前会议消息。

## 10. 术语表

第一版后端已提供 Host 级术语接口：

```text
GET    /glossary
POST   /glossary
PATCH  /glossary/:id
DELETE /glossary/:id
```

仅 Host 访问自己的术语。字段：`sourceLanguage`（`zh|ru|en`）、`targetLanguage`（`zh|ru`）、`sourceTerm`、`targetTerm`、`category`、`enabled`。GET 支持来源/目标语言筛选并返回 `{items}`。服务端根据 `ownerId` 和当前翻译方向加载启用且命中文本的最多 100 项，映射到 Qwen-MT `translation_options.terms`。移动端管理 UI 未开放时可继续由 API/种子维护，不应展示空白入口。

## 11. 会议纪要

接口以路径中的单个 conversationId 为唯一输入：

```http
POST /v1/conversations/:conversationId/summary
GET  /v1/conversations/:conversationId/summary
GET  /v1/conversations/:conversationId/summary/email-recipients
POST /v1/conversations/:conversationId/summary/email-distributions
GET  /v1/conversations/:conversationId/summary/email-distributions/:distributionId
```

GET 允许所有仍有历史权限的 Participant，且严格只读；POST 仅会议 owner，并且只允许状态为 `ENDED` 的会议，活动会议返回 `SUMMARY_REQUIRES_ENDED_CONVERSATION`。授权、Conversation 状态校验、来源消息读取和 upsert 在同一个 Conversation 首锁事务中完成。服务端只查询该 conversationId 的 FINAL 消息，`participantRoster` 从 Participant 生成，`coreDiscussion` 固定从不可变 Message 发言人快照生成，客户端不能提交或替换这两类身份数据。

POST 只接受可选 `summary`，以及严格结构的 `partyViews`、`confirmedItems`、`actionItems` 和 `openQuestions`。每项必须通过 `sourceSequences` 引用本会议存在的发言；`partyViews.participantId` 必须与被引用消息的实际发言人一致，`actionItems.assigneeParticipantId` 必须是本会议 Participant。保存时服务端为注释补全发言人/负责人姓名、公司和原始消息快照；多余字段、伪造 participantId 或不存在的 sequence 返回 400。每次保存同时记录 `sourceMaxSequence`、`sourceMessageCount`、`sourceLatestMessageUpdatedAt` 并递增 `revision`；GET 返回 `isStale`。消息数量/序号未变但确认纠错更新了原文或译文时也会立即标记过期；旧迁移数据因没有可信来源边界时返回 `null`，不能伪报为最新。移动端查看使用 GET，只有主持人明确确认“生成或更新”才调用 POST。未接入生产 AI 摘要 provider 时，默认 `summary` 是可解释的会议标题/发言数统计，不冒充 AI 生成结论。禁止默认合并同一天会议。

邮件收件人和分发接口仅允许该会议 owner。收件人接口从服务端 Participant → User/GuestIdentity 关系解析邮箱，只返回脱敏 `emailHint`、`eligible/reason`；普通参会者名单和分发结果都不返回完整邮箱。被移出、账号删除/停用、访客撤销、历史权限过期或没有邮箱的 Participant 不可选择。分发只允许 `ENDED` 会议且纪要来源边界必须与当前 FINAL 消息完全一致，否则返回 `SUMMARY_STALE`。POST body 为 `{ "participantIds": ["participant_123"] }`，并强制 `Idempotency-Key` header；相同键的并发请求收敛到同一任务，换纪要或换收件人则返回 `IDEMPOTENCY_KEY_REUSED`。

POST 只持久化任务并返回 `PROCESSING`，不会在一个长 HTTP 请求内等待所有邮件；服务端多实例安全 worker 从 PostgreSQL 扫描任务，逐人调用邮件供应商，绝不把多个地址放入同一 To/CC。App 使用 distribution GET 轮询 `PROCESSING | COMPLETED | PARTIAL_FAILURE | FAILED`、成功/失败数量及每位收件人的脱敏结果。worker 启动、每封邮件发送前都会重验纪要来源、Participant、账号/访客关系和邮箱；排队期间出现纠错、移出、撤销或邮箱变化时直接失败且不发旧内容。供应商接受仅表示已受理，不等于最终送达；退信/投诉 webhook 属于生产运营后续校验。供应商调用使用稳定的逐收件人幂等键；结果不明的陈旧 claim 超出安全窗口后标记人工确认，禁止自动重放。

邮件内容按收件人的会议语言使用中文或俄文标题，包含会议、纪要版本、参会人员、概要、核心讨论、各方观点、确认事项、待办与未解决问题；原文和译文仍保留发言者归属。分发记录保存纪要 revision、请求幂等摘要和逐收件人发送状态。账号注销时清除收件邮箱和身份快照，未发送任务标记失败。

## 11.1 多人参会、好友与邀请接口

```http
GET    /v1/conversations/:id/participants
PATCH  /v1/conversations/:id/participants/me
POST   /v1/conversations/:id/leave
DELETE /v1/conversations/:id/participants/:participantId

GET    /v1/users/search?q=<name-email-company>
POST   /v1/friend-requests
GET    /v1/friend-requests?box=incoming|outgoing|all
POST   /v1/friend-requests/:id/respond
GET    /v1/friends
DELETE /v1/friends/:friendId

POST   /v1/conversations/:id/invitations
GET    /v1/meeting-invitations?status=PENDING|ALL|...
POST   /v1/meeting-invitations/:id/respond
```

Participant 返回稳定 `participantId`、`displayName`、`company`、`preferredLanguage`、`registered`、`presence`、`joinedAt`、`leftAt`、`lastSeenAt` 和 `removedAt`。Host 只能管理自己拥有的会议；被移出者立即失去 REST、Socket、消息、名单、导出和纪要权限。

加入请求和接受 App 内邀请时的会议资料：

```json
{
  "displayName": "Ivan Petrov",
  "company": "Example LLC",
  "preferredLanguage": "ru"
}
```

好友申请响应使用 `{ "action": "ACCEPT" }` 或 `DECLINE`。会议邀请响应使用相同 action；接受时必须同时提供完整会议资料。两类响应均以 `PENDING` 为 CAS 条件，并发接只有一个能成功；App 邀请接受在 Conversation 行锁后再确认会议未结束/未过期。`POST /leave` 只允许非 Host Participant，设为 `LEFT` 后当前 Token 不能直接 Socket 重连；注册用户需经新的显式 join 才可恢复。`GET /friends` 还返回 `online` 和 `canInvite`。

`GET /users/search` 仅对姓名和公司做子串搜索；邮箱只允许完整地址精确匹配，所有搜索结果中的邮箱均脱敏。搜索和发送好友申请使用独立的凭证级限速。Participant 显示名和公司拒绝 CR/LF 与其他控制字符。

导出接口支持：

```http
GET /v1/conversations/:id/export?format=txt|md&groupBy=sequence|speaker
```

每条记录使用 `时间｜发言者姓名｜公司｜原文语言`，后跟原文和译文。数据必须来自消息的不可变发言者快照，而不是当前 Participant 资料。服务端对 TXT 头字段去除换行/控制字符并给内容续行缩进；Markdown 输出转义标题和发言人字段，文本用引用块承载，防止消息内容伪造新发言记录。

## 11.2 翻译纠错、确认与术语入库

```http
GET  /v1/conversations/:conversationId/messages/:messageId/corrections
POST /v1/conversations/:conversationId/messages/:messageId/corrections
POST /v1/conversations/:conversationId/messages/:messageId/retranslate
POST /v1/conversations/:conversationId/messages/:messageId/review/confirm
POST /v1/conversations/:conversationId/messages/:messageId/review/reject
POST /v1/conversations/:conversationId/messages/:messageId/glossary
```

人工修改请求必须带 `expectedRevision` 和至少 8 字符的 `idempotencyKey`；可只改 `sourceText` 或 `translatedText`，未提供的一侧由服务端取当前已确认内容。重新翻译请求同样使用 revision CAS 和幂等键，服务端从消息的固定语言方向及会议 owner 的术语库调用 MT，客户端不能指定 provider、ownerId 或 participantId。

原始 `TranslationMessage.sourceText/translatedText` 永不被纠错覆盖。每次提案追加一条 `MessageCorrection` 审计记录；消息行只物化 `reviewStatus`、`reviewRevision`、当前待确认文本和最后确认文本。普通消息 DTO 的 `sourceText/translatedText` 返回最后确认版本，并额外返回 `originalSourceText`、`originalTranslatedText`、`pendingCorrection`、`reviewStatus`、`reviewRevision` 与 `reviewedAt`。历史、TXT/Markdown 导出和新生成的会议纪要使用最后确认版本，发言者身份快照保持不变。

只有进行中会议的 owner 或该消息的实际发言 Participant 可以提案、重译、确认或拒绝；加入术语库仅限 owner，且只能使用消息当前 `reviewRevision` 对应的 `CONFIRMED` 纠错。主动退出、被移出、会议结束或过期后，纠错历史仍按原历史策略可读，但所有纠错写入变为只读。服务端从 Token 反查真实 Participant；正式账号写事务统一按 `Conversation → User → UserDevice → Participant`，Guest 写事务按 `Conversation → GuestIdentity → Participant` 加锁并重新校验状态、left/removed/revoked/session，防止调用 MT/TTS 期间退出、结束或被移出后仍提交。术语入库的身份锁定、当前消息/确认版本复验与 upsert 在同一事务中完成，防止会议结束、移出或会话撤销竞态。确认新译文会重新生成 TTS；若译文未变化且已有私有音频则保留原音频，若新 TTS 失败则确认文本仍成功并返回 `TTS_FAILED` 降级状态。确认成功还会删除此前生成的会议纪要，避免继续展示包含旧文本的快照；owner 需重新生成纪要。

## 11.3 服务器管理后台

```http
GET   /v1/admin/me
GET   /v1/admin/overview
GET   /v1/admin/metrics?days=30
GET   /v1/admin/users?page=1&pageSize=25&q=&status=
GET   /v1/admin/users/:id
PATCH /v1/admin/users/:id/status
POST  /v1/admin/users/:id/revoke-sessions
POST  /v1/admin/users/:id/password-reset
GET   /v1/admin/conversations?page=1&pageSize=25&q=&status=
GET   /v1/admin/conversations/:id
POST  /v1/admin/conversations/:id/end
GET   /v1/admin/failures?page=1&pageSize=25&q=&provider=
POST  /v1/admin/failures/:id/retry
GET   /v1/admin/health
GET   /v1/admin/tasks?page=1&pageSize=25&type=
POST  /v1/admin/tasks/:type/:id/retry
GET   /v1/admin/admins
PATCH /v1/admin/admins/:id/role
GET   /v1/admin/email/distributions
GET   /v1/admin/email/distributions/:id
GET   /v1/admin/system-glossary
POST  /v1/admin/system-glossary
PATCH /v1/admin/system-glossary/:id
DELETE /v1/admin/system-glossary/:id
GET   /v1/admin/quality/corrections
GET   /v1/admin/quality/corrections/:id?reason=
PATCH /v1/admin/quality/corrections/:id/decision
GET   /v1/admin/governance/deletions
PATCH /v1/admin/governance/deletions/:id
GET   /v1/admin/settings
PATCH /v1/admin/settings/:key
GET   /v1/admin/audit-logs?page=1&pageSize=25
POST  /v1/auth/password/reset
```

`/v1/admin/*` 只接受服务器每次从 User 行重新验证的独立管理权限。所有正式账号都是 `USER`，创建会议不会获得服务器管理权限；停用用户、强制退出、签发密码重置和结束会议都在业务变更的同一 PostgreSQL 事务写入 `AdminAuditLog`。

签发密码重置会返回仅显示一次的 `resetToken`/`resetUrl`/`expiresAt`，数据库只保存包含 Pepper 的摘要。用户向公开重置接口提交 `{ "token": "...", "newPassword": "..." }`；成功消费后所有设备会话立即撤销。详见 [服务器管理后台](./ADMIN_CONSOLE.md)。

## 12. 稳定错误码

| code | 状态 | 含义 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 字段或枚举无效 |
| `INVALID_AUDIO` | 400 | 音频为空、超大小或声明 MIME/扩展名不在白名单；当前不验证真实编码/时长 |
| `INVALID_LANGUAGE_PAIR` | 400 | 非 zh⇄ru 或方向相同 |
| `UNAUTHORIZED` | 401 | 未登录或 Access Token 无效 |
| `INVALID_CREDENTIALS` | 401 | 登录凭据无效 |
| `REFRESH_DEVICE_MISMATCH` | 401 | Refresh 与设备不匹配 |
| `REFRESH_TOKEN_INVALID` | 401 | Refresh 签名/声明无效、缺少当前会话族声明，或来自已经被新登录替换的旧会话族；不撤销当前族 |
| `REFRESH_TOKEN_REUSED` | 401 | 同一会话族的 Refresh 已轮换/重放；撤销该族，不误伤更新登录建立的新族 |
| `GUEST_TOKEN_REVOKED` | 401 | Guest 过期、撤销或会议不匹配 |
| `DEVICE_REVOKED` | 401 | 设备会话不存在或已远程撤销 |
| `ACCOUNT_DISABLED` | 401/403 | 账号停用 |
| `FORMAL_ACCOUNT_REQUIRED` | 403 | Guest 尝试正式账号专属操作 |
| `FORBIDDEN` | 403 | 操作不允许 |
| `PARTICIPANT_REMOVED` | 403 | 该注册参会者或临时 Guest 已被会议主持人移出，不能重新加入或读写会议 |
| `PARTICIPANT_LEFT` | 403 | 参会者已主动退出，历史可按策略读取但不能继续写入 |
| `ROOM_EXPIRED` | 403 | 会议或邀请已过期 |
| `ROOM_NOT_ACTIVE` | 403 | 当前会议状态不可发言 |
| `HISTORY_ACCESS_EXPIRED` | 403 | 历史授权已过期 |
| `CONTACT_NOT_FOUND` | 404 | Contact 不存在或不属于 Host |
| `CONVERSATION_NOT_FOUND` | 404 | 会议不存在或不可见 |
| `PARTICIPANT_NOT_FOUND` | 404 | 客户参与者不存在、已移除或不属于该会议 |
| `ROOM_NOT_FOUND` | 404 | 邀请/房间码无匹配 |
| `SUMMARY_NOT_FOUND` | 404 | 本会议尚未生成会议纪要 |
| `EMAIL_EXISTS` | 409 | 邮箱已注册 |
| `ROOM_ENDED` | 409 | 已结束会议不能轮换邀请或恢复写入 |
| `SUMMARY_REQUIRES_ENDED_CONVERSATION` | 409 | 只有已结束会议可以生成最终会议纪要 |
| `SUMMARY_EMAIL_REQUIRES_ENDED_CONVERSATION` | 409 | 只有已结束会议可以邮件分发最终纪要 |
| `SUMMARY_STALE` | 409 | 纪要来源版本落后于当前最终消息，必须重新生成 |
| `SUMMARY_EMAIL_RECIPIENT_INELIGIBLE` | 400 | 收件人不属于会议、无邮箱或当前无纪要访问权 |
| `SUMMARY_EMAIL_DISTRIBUTION_NOT_FOUND` | 404 | 分发任务不存在或不属于路径中的会议 |
| `ROOM_JOIN_IN_PROGRESS` | Socket 409 | 同一 Socket 正在加入该会议，不并发重复查询 |
| `ROOM_JOIN_RATE_LIMITED` | Socket 429 | 同一 Socket 短时间内入会请求过多 |
| `INVITATION_ROTATE_CONFLICT` | 409 | 并发轮换期间凭证已被另一请求更新 |
| `INVITATION_COLLISION` | 409 | 多次生成的新 token/code 均发生唯一冲突，可安全重试 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 同一键被不同请求复用 |
| `MESSAGE_NOT_FINAL` | 409 | 处理中或失败消息不能进入纠错流程 |
| `MESSAGE_REVIEW_CONFLICT` | 409 | `expectedRevision` 已过期，客户端必须刷新后重试 |
| `MESSAGE_REVIEW_FORBIDDEN` | 403 | 非 owner 且不是实际发言者 |
| `MESSAGE_NOT_CONFIRMED` | 409 | 尚无确认版本，不能从该消息加入术语库 |
| `PAYLOAD_TOO_LARGE` | 413 | 音频超限 |
| `RATE_LIMITED` | 429 | 本服务限流 |
| `ASR_NO_SPEECH` | 422 | 未检测到有效语音 |
| `ASR_FAILED` | 502 | 识别失败 |
| `MT_FAILED` | 502 | 翻译失败 |
| `TTS_FAILED` | `200` 的 FINAL Message 字段 | 文本成功但语音降级，`audioUrl=null`；不把整个请求改为 502 |
| `PROCESSING_TIMEOUT` | FAILED Message 字段 | 进程中断后消息超过处理窗口；在消息读取、导出或 Socket join 补拉前收敛为失败 |
| `AUDIO_URL_INVALID` | 403 | 内部播放签名无效或已过期 |
| `AUDIO_NOT_FOUND` | 404 | 签名对应资产不存在或已清理 |
| `PROVIDER_RATE_LIMITED` | 429 | 上游供应商限流，客户端只能用同一幂等键有界重试 |
| `PROVIDER_UNAVAILABLE` | 502 | 无法连接上游 |
| `PROVIDER_FAILED` | 502 | 上游返回非限流业务错误 |
| `PROVIDER_TIMEOUT` | 504 | 上游超时 |
| `PROVIDER_CONFIGURATION_ERROR` | 503 | 生产供应商配置无效 |
| `REALTIME_NOT_READY` | 503 | Redis 实时 publisher/subscriber 未就绪 |
| `PASSWORD_RESET_NOT_CONFIGURED` | 501 | 密码找回发送/重置服务尚未配置 |
| `RESET_TOKEN_INVALID` | 401 | 管理员签发的一次性重置凭证无效、已消费或已过期 |
| `SYSTEM_ADMIN_REQUIRED` | 403 | 当前正式账号不具有服务器管理权限 |
| `SYSTEM_ADMIN_PROTECTED` | 403 | 持久系统管理员不能在界面直接停用 |
| `PARTICIPANT_PROFILE_REQUIRED` | 400/409 | 加入或接受邀请前未确认姓名、公司和语言 |
| `FRIEND_REQUIRED` | 403 | App 内直接邀请的对象不是好友 |

## 13. 安全与幂等检查

- 所有嵌套资源用 `(conversationId, resourceId)` 联合验证，不能先按全局 messageId 读取后交给客户端过滤。
- Host 的 ownerId 永远来自 Token；Guest 的 conversationId 永远来自 Guest Token。
- 音频幂等唯一范围：`conversationId + participantId + Idempotency-Key`。
- `POST .../end`、logout 和删除重试保持稳定，不产生重复副作用。
- 限速至少覆盖登录、刷新、Guest 创建、房间码、音频上传、导出和 TTS 重试。
- 不在响应中返回 passwordHash、refreshTokenHash、roomTokenHash、roomCodeHash、内部 provider error 或数据库字段。

## 14. 当前/目标边界

本合同对应移动端当前依赖的核心路径：认证、Profile、设备撤销、Contact、多人 Conversation、好友/会议邀请、join、参与者管理、messages、audio、text、end、history、export、summary 和 delete。服务器已提供私有 TTS 资产/签名播放、术语 CRUD、按发言者 TXT/Markdown 导出和结构化会议纪要。密码找回发送链、推送通知和 TTS 独立重试仍是后续能力；若代码未实现，必须返回明确错误或隐藏 UI，不能返回伪成功。
