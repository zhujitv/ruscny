# 服务器管理后台

管理后台由 API 服务同源提供，正式地址为 `https://www.ruscny.net/admin`。界面支持中文和俄文，可查看概览、翻译用量、用户与设备会话、会议与参会人员、可分页检索的翻译故障，以及可筛选的管理审计记录。

## 1. 权限边界

- 管理员先通过现有的 `/v1/auth/login` 使用正式账号登录。
- 正式账号只有统一的 `USER` 类型；会议主持人是创建者在单次会议中的角色，不是账号类型，也不代表服务器管理权限。
- 每一个 `/v1/admin/*` 请求都会先校验 Access Token 与设备 `sessionId`，然后重新从 PostgreSQL 读取不可变 User ID、账号状态和 `isSystemAdmin`。不信任 Token 中的会议角色、邮箱或浏览器传入值。
- 只有 `ACTIVE` 账号且 `isSystemAdmin=true`，或不可复用的 User ID 明确列入 `SYSTEM_ADMIN_USER_IDS`，才能进入。Guest 永远不能进入。邮箱不是管理权限依据，因为当前注册流程尚未验证邮箱且注销后邮箱可以重新注册。
- 管理端的 Access/Refresh Token 只放在当前标签页 `sessionStorage`，不写入 URL 或长期本地存储。

## 2. 初始管理员

1. 先通过 App/注册 API 创建一个具有强密码的独立运维账号。
2. 通过受控数据库只读查询按邮箱定位并复核该账号，取得其不可复用的 `User.id`；不要把邮箱本身作为权限标识。
3. 在 Secret Manager 中设置 `SYSTEM_ADMIN_USER_IDS=<user_id>`；多个 ID 用英文逗号分隔。
4. 重新部署 API，使用该账号登录 `/admin`，验证 `/v1/admin/me` 成功。
5. 如需把权限固化到数据库，由受控运维变更将对应 `User.isSystemAdmin` 设为 `true`，核对后再移除 User ID 白名单。这个底层变更不开放给管理界面，避免被窃取的管理会话自行提权。

建议至少保留两个独立管理账号，并对数据库的管理权限变更保留部署平台/工单证据。界面禁止停用当前管理员和持久 `isSystemAdmin` 账号。

## 3. 管理 API

| 方法与路径 | 作用 |
| --- | --- |
| `GET /v1/admin/me` | 确认当前服务器管理身份 |
| `GET /v1/admin/overview` | 用户、会议、在线参会者、消息、失败和删除队列概览 |
| `GET /v1/admin/metrics?days=30` | 按状态、服务商、原文语言和错误码聚合用量；`days` 范围 1–365 |
| `GET /v1/admin/users` / `GET /v1/admin/users/:id` | 分页搜索/筛选用户及查看设备元数据 |
| `PATCH /v1/admin/users/:id/status` | 启用/停用；停用会在同一事务撤销全部设备会话 |
| `POST /v1/admin/users/:id/revoke-sessions` | 强制所有设备退出并立即断开 Socket |
| `POST /v1/admin/users/:id/password-reset` | 签发一次性重置凭证和带 URL fragment 的链接 |
| `GET /v1/admin/conversations` / `GET /v1/admin/conversations/:id` | 搜索会议，查看参会人员和消息状态计数，默认不暴露会议正文 |
| `POST /v1/admin/conversations/:id/end` | 事务化结束会议、失败化处理中消息、终止参会/邀请并广播 `room.ended` |
| `GET /v1/admin/failures` | 按关键词/服务商分页检索失败翻译，仅返回故障元数据，不返回会议正文 |
| `POST /v1/admin/failures/:id/retry` | 仅对有可靠原文、可恢复错误、仍有效会议和有效参会者执行安全重试 |
| `GET /v1/admin/health` | 数据库、实时通信、供应商配置和队列积压状态 |
| `GET /v1/admin/tasks` / `POST /v1/admin/tasks/:type/:id/retry` | 查看音频清理/纪要邮件任务并审计人工重试 |
| `GET /v1/admin/admins` / `PATCH /v1/admin/admins/:id/role` | 查看并调整已有管理员职责，不提供普通用户提权入口 |
| `GET /v1/admin/email/distributions` / `:id` | 邮件分发运营与脱敏收件人状态查看 |
| `GET/POST/PATCH/DELETE /v1/admin/system-glossary` | 公共术语运营；与用户私人术语隔离，停用代替物理删除 |
| `GET /v1/admin/quality/corrections` | 质量审核队列；列表不返回会议正文 |
| `GET /v1/admin/quality/corrections/:id?reason=` | 填写调查原因后查看纠错差异并写入审计 |
| `PATCH /v1/admin/quality/corrections/:id/decision` | 通过 CAS 确认或拒绝当前待审核修订 |
| `GET/PATCH /v1/admin/governance/deletions` | 删除台账、匿名化步骤及跨存储异常状态 |
| `GET/PATCH /v1/admin/settings` | 仅管理注册和质量审核等已接入业务流程的安全开关 |
| `GET /v1/admin/audit-logs` | 按关键词、动作、对象类型或操作人分页筛选管理写操作审计记录 |

列表接口使用 `page`/`pageSize`，`pageSize` 最大 100。用户状态、强制退出、签发重置凭证和结束会议可传 `reason` 作为审计说明，最长 500 字符。

## 4. 一次性密码重置

1. 服务器签发 32 字节随机凭证；数据库只保存包含 `PASSWORD_PEPPER` 的摘要。
2. 旧的未使用凭证会在新签发时失效。默认有效期 30 分钟，`ADMIN_PASSWORD_RESET_TTL_MINUTES` 可在 5–1440 分钟内调整。
3. Token 放在 `#token=...` URL fragment，不会发到 HTTP 服务器。`/reset-password` 读取后立即清除地址栏内容。
4. `POST /v1/auth/password/reset` 使用数据库 CAS 只允许消费一次，更新后在同一事务撤销该用户所有设备，并立即断开实时连接。

当前不会自动发送重置邮件；链接只在签发响应/界面中显示一次，运营人员必须通过已验证的受信渠道发送。

## 5. 审计和可观测边界

`AdminAuditLog` 记录操作人、动作、对象、非敏感 metadata、请求 ID、IP 和时间。它不得保存密码、Bearer/Refresh Token、重置 Token 或会议正文。管理写操作与业务变更放在同一 PostgreSQL 事务。

后台的“错误”当前是 PostgreSQL 中持久化的翻译消息失败。HTTP 5xx、进程崩溃、Redis/PostgreSQL/对象存储资源指标仍由生产日志、APM 和云平台告警承担；不应为了管理界面而在业务库中记录可能含敏感请求体的全量错误。

## 6. 管理员职责

| 职责 | 能力 |
|---|---|
| `SUPER_ADMIN` | 全部后台能力和已有管理员职责调整 |
| `OPERATIONS` | 用户/会议运营、故障与任务重试、审计查看 |
| `SUPPORT` | 用户与会议客服操作 |
| `QUALITY` | 翻译故障调查和安全重试 |
| `AUDITOR` | 只读运营状态和完整审计 |
| `VIEWER` | 只读运营数据 |

职责只作用于已经具有 `isSystemAdmin=true` 的账号。后台不提供普通用户提权入口；初始提权仍由受控运维流程完成。当前超级管理员不能降低自己的职责，防止误操作导致后台失去控制。

## 7. 第二阶段业务运营边界

- 邮件中心仅展示脱敏邮箱，不允许输入任意收件人进行群发。
- 公共术语存入独立 `SystemGlossaryTerm`；用户 `GlossaryTerm` 仍为私人数据，后台不浏览和改写。匹配冲突时用户私人术语优先。
- 质量列表只返回纠错人、类型、状态和时间。打开原文/译文差异必须填写调查原因，并写 `QUALITY_CONTENT_VIEWED` 审计。
- 删除台账证明在线数据库匿名化步骤，不代表 Redis、第三方供应商和历史备份已全部完成删除；这些步骤可以标记部分失败并持续跟踪。
- 系统配置采用版本号比较更新。后台永远不返回或修改数据库密码、JWT Secret、供应商 API Key、对象存储密钥等机密。
