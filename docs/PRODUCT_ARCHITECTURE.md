# 产品与架构说明

## 1. 产品目标

当前版本是一款 Android、iPhone 和 iPad 基础兼容的中俄双向翻译 App。多人会议仍采用按住说话、松开提交的可追溯轮次翻译；Android 工作区另已接入好友一对一实时语音/视频通话及中俄实时翻译实验链路。主持人创建独立会议，任意数量的注册用户和临时用户可通过 App 内好友邀请、二维码、邀请链接或房间码加入。

核心产品承诺不是“连续同传”，而是稳定、可追溯的轮次翻译：

1. 一次录音对应一次提交和一条最终消息。
2. 一个会议保留原有主要客户归档关系，但可包含一名主持人和多名参会者。
3. 所有消息绑定一个且仅一个会议。
4. 只有最终结果进入历史；原始录音和临时识别默认不保存。
5. ASR、机器翻译、TTS、数据库和签名密钥只存在于服务端。

## 2. 当前版本边界

包含：

- 正式账号登录、临时用户资料确认和多人快速加入。
- 注册用户好友搜索、申请、接受/拒绝、删除、在线/可邀请状态和 App 内会议邀请。
- Android 好友一对一实时语音/视频选择，视频来电可明确降级为语音接听；服务端以最终协商的 `mediaType` 为权威状态。
- 客户创建、编辑、搜索和客户历史。
- 独立会议、二维码、邀请链接、房间码和历史访问策略。
- 中文 `zh` 与俄语 `ru` 两个明确输入方向，不做自动语言识别。
- 按住录音、松开上传、最终原文与译文、TTS 自动播放/重播。
- WebSocket 双端同步、消息顺序、重连后补拉与去重。
- 带发言者归属的 TXT/Markdown 导出、按发言者整理、结构化会议纪要、会议删除和账号注销。

不包含：多人会议的连续同声传译、多人同时抢占同一麦克风通道、iOS 好友视频通话、Viewer、完整 CRM、企业级 SSO/组织后台、长期录音、语音克隆和付费系统。Android 音视频仍需生产部署与双真机验收，不能因本地模拟器可见入口而视为已上线。

## 3. 角色和权限

正式注册账号只有一种 `USER` 类型，不显示“主持人账号/参会者账号”选择。主持人是单次会议角色：任一注册用户创建会议后，服务端把认证主体写入 `Conversation.ownerId`，并为其创建 `Participant.role = HOST`；该用户加入别人创建的会议时只是该会议的注册参会者。

| 能力 | 注册用户（自己创建的会议） | 注册用户（加入他人会议） | 临时用户 |
| --- | --- | --- | --- |
| 创建/编辑客户 | 是，仅自己的客户 | 仍可管理自己的客户 | 否 |
| 创建新会议 | 是，创建后自动成为该会议主持人 | 是，可另外创建自己的会议 | 否 |
| 结束/删除当前会议 | 是，仅自己拥有的会议 | 否 | 否 |
| 加入当前会议 | 作为 owner 或真实 Participant | 经邀请且授权 | 仅凭有效邀请并完成资料 |
| 发送语音 | 会议有效时 | 作为参与者且会议有效时 | 仅当前会议有效时 |
| 查看会后历史 | 全部自己的会议 | 仅参与且仍获授权的会议 | 仅当前会议且按策略限时 |
| 查看其他客户或会议 | 否 | 否 | 否 |

服务端权限判断必须基于认证主体和数据库关系，不能信任 App 传来的 `role`、`ownerId`、`contactId` 或 `participantId`。主持人权限每次都由服务端按当前 `conversationId` 验证，不能从账号类型推断。

## 4. 逻辑架构

```text
Flutter App（统一注册用户 / 临时用户；会议内区分主持人）
  ├─ HTTPS：认证、客户、会议、音频上传、历史、导出
  └─ WSS：加入房间、参与者状态、翻译结果、断线补拉通知
                 │
                 ▼
Node.js / TypeScript API
  ├─ Auth 与设备会话
  ├─ Contact / Conversation 权限域
  ├─ Realtime Gateway 与 sequence
  ├─ Translation Orchestrator
  │    ├─ Qwen3-ASR-Flash：明确识别 zh 或 ru
  │    ├─ Qwen-MT：zh⇄ru 翻译与术语约束
  │    └─ Qwen3-TTS/CosyVoice：仅最终译文
  ├─ PostgreSQL：权威业务数据
  ├─ Redis：Socket.IO 跨实例 pub/sub 与实时就绪状态
  └─ 对象存储：可选的短期 TTS 音频
```

多人会议的 ASR/MT/TTS 仍只由服务端直连阿里云，避免泄露 API Key，也保证术语、限流、审计与客户隔离统一执行。好友实时通话是例外：App 使用服务端按通话、账号和设备授权后签发的限时 ARTC 凭证连接 RTC 供应商，AppKey 仍只在服务端参与签名。当前 ARTC token 不包含轨道级 AUDIO/VIDEO 权限，因此最终媒体同意可由服务端记录和校验，但尚不能仅靠该 token 在供应商层强制禁止改造客户端发布视频轨。

## 5. 核心标识与不变量

- `ownerId`：创建该会议的注册用户数据域。所有 Contact 和 Conversation 都由它限定，也是该会议主持人权限的服务端依据。
- `contactId`：会议所属客户。Conversation 创建时必填，创建后不可修改。
- `conversationId`：实时房间、消息、历史、导出和会议纪要的唯一范围。
- `participantId`：一次会议中的稳定参与者身份；注册用户按 `(conversationId,userId)` 唯一，临时用户按 `(conversationId,guestIdentityId)` 唯一。
- `messageId`：一次翻译提交对应的稳定 ID。
- `sequence`：同一会议内由服务端单调递增的消息序号，用于排序和补拉。
- `roomToken`：高熵、不可预测、可撤销的邀请凭证；不得由数据库自增 ID 推导。Host 轮换邀请时 token/code 哈希在同一行锁事务内一起替换，旧凭证立即失效。
- `roomCode`：便于人工输入的短码，只是查找线索，不是唯一授权凭证。
- `sessionId`：正式设备登录或 GuestIdentity 的服务端会话代际；Access/Refresh/Guest Token 必须与当前代际一致，重新登录、授权重入或撤销后旧 Token 不能复活。

数据库写入消息时必须在同一事务中验证 Conversation 状态、Participant 归属并分配 `sequence`。任何查询都先限定可访问的 Conversation，再查询消息；禁止先按用户提供的 message ID 读取后在客户端过滤。

## 6. 会议状态机

```text
WAITING ──客户加入/主持人开始──> ACTIVE ──主持人结束──> ENDED
   │                                │
   └────────────到期──────────────> EXPIRED <────────到期────────┘
```

- `WAITING`：可加入，不应产生正式翻译消息。
- `ACTIVE`：授权参与者可提交语音。
- `ENDED`：永久拒绝新语音；按历史策略只读。
- `EXPIRED`：拒绝加入和语音提交。
- 状态转换只由服务端执行，结束操作要求认证主体等于该会议 `ownerId`，并应幂等。

## 7. 一次按住说话的数据流

1. 客户端生成 `Idempotency-Key`，开始本地录音。
2. 松开后停止录音；空音频、过短或超长内容在客户端先拦截。
3. 通过 HTTPS multipart 上传 `audio`、`sourceLanguage` 和幂等键。
4. 服务端验证 Token、会议状态、参与者和语言方向，在数据库事务中分配 `sequence` 并创建 `PROCESSING` 消息。
5. `PROCESSING` 只保留在服务端，发言者客户端显示本地上传状态，不向房间广播占位卡片。
6. 服务端把当前接受的音频缓冲编码为 data URL，调用 ASR 并只采纳最终识别，再调用 MT 生成明确目标语言译文。当前未做服务端转码/解码级校验，录音编码必须由移动端与供应商实测对齐。
7. 服务端对最终译文尝试 TTS 并持久化音频；TTS 失败记为可降级结果，不丢弃已成功的文本翻译。
8. 服务端用状态条件更新同一条 `PROCESSING` 消息，保存最终原文、译文、音频引用或 `TTS_FAILED`，不再分配新 `sequence`。ASR/MT 失败只保留内部 FAILED 记录并向发言者的 HTTP 请求返回错误。
9. 仅成功时广播 `translation.final`；音频成功时带内部签名 URL，失败时 `audioUrl=null` 并带 `TTS_FAILED`。当前没有异步 `translation.audio.ready` 事件或独立 TTS 重试端点。
10. 客户端只合并 FINAL 消息，按 `messageId` 去重、按 `sequence` 排序，并根据自动播放设置入队。

## 8. 可靠性设计

- HTTP 音频提交使用幂等键；同一参与者、会议和幂等键只能生成一条消息。
- 幂等键和消息状态的权威条件保存在 PostgreSQL，不依赖 Redis 内存；当前 Fastify 请求限流也是实例内状态，多实例统一账号/设备限流尚需独立共享 store。
- 当前每个外部 fetch 使用统一总超时；未单独配置连接/首包超时，也未在 provider 内实现 429/5xx 退避重试。客户端重试必须复用同一幂等键。
- ASR 或可选 Gummy 适配器的临时结果不入库、不广播为最终消息。
- TTS 是可降级步骤；失败时文本仍为 FINAL、音频为空。独立语音重试是后续能力，当前 UI 不应展示无后端支持的重试成功承诺。
- 消息列表、导出和 Socket `room.join` 补拉前会把超过 `max(120 秒, 4 × provider timeout)` 的陈旧 `PROCESSING` 原子收敛为 `FAILED / PROCESSING_TIMEOUT`，关闭进程崩溃留下的 sequence 空洞；客户端用同一幂等键重试时仍遵守现有消息状态合同。
- WebSocket 断线不丢权威数据。重连后客户端携带最后 `sequence`，服务端补发缺失项。
- Redis 不作为永久消息来源；Redis 丢失时可从 PostgreSQL 恢复。

## 9. 移动端架构

移动端位于 `apps/mobile`，使用 Flutter、Riverpod、Dio、安全存储、本地 SQLite、Socket.IO、`record`、`just_audio`、`mobile_scanner` 和 `app_links`。运行时只注入公共地址：

```text
API_BASE_URL=https://www.ruscny.net
SOCKET_URL=https://www.ruscny.net
APP_LINK_HOST=www.ruscny.net
```

Access Token 和 Refresh Token 存入系统安全存储；历史缓存只用于离线展示，服务端仍是权限与数据的唯一权威来源。

## 10. 会议纪要与后续生成式摘要

`ConversationSummary` 保存参会人员、核心讨论、各方观点、确认事项、待办和未解决问题，并通过指定 `conversationId` 读取消息。只有会议结束后，主持人才可明确生成或更新；普通查看严格使用 GET，不会重写纪要。生产通过服务端阿里云百炼通义千问文本模型生成结构化草稿，沿用现有百炼 API Key，但使用独立 `ALIYUN_SUMMARY_MODEL` 配置；客户端不接触密钥，也不需要百炼智能体、工作流或长期记忆产品。`SummaryGeneration` 用 `conversationId + Idempotency-Key` 和来源 hash 持久记录生成任务、失败、供应商 request id、模型/prompt 版本及 token 用量，并保证同一来源只有一个活动任务；陈旧任务可以接管恢复。模型输出的概要及每项结论必须引用本会议发言 sequence，服务端复验发言归属、负责人和来源版本后才保存。每份纪要记录来源最大序号、来源消息数、消息最后更新时间和 revision；因此确认纠错即使不新增消息也会使旧纪要过期，AI 整理期间发生变化也会拒绝保存。旧版无可靠来源边界时标记为“无法验证”，不能伪装成最新。任何未来的客户长期总结必须由用户显式选定 `contactId` 后合并，不允许按日期或当前界面上下文隐式跨会议取数。AI 草稿需要主持人批准当前 revision 才能邮件分发，任何更新都会撤销旧批准；质量评测不得阻塞实时翻译链路。

会议结束且纪要来源未过期、当前 revision 已批准时，会议 owner 可以选择有权限且有邮箱的 Participant 邮件分发纪要。注册用户邮箱来自 User，临时用户在加入时填写并写入 GuestIdentity/Participant 会议快照；客户端只得到脱敏邮箱提示。`SummaryEmailDistribution` 与 `SummaryEmailRecipient` 是 PostgreSQL 持久任务/逐收件人 claim，保存纪要 revision、请求幂等摘要和供应商受理结果。API 快速返回，后台 worker 可在进程重启后继续扫描；多副本通过收件人 CAS 避免同时发送。邮件逐人发送，不使用群发 To/CC；worker 在任务开始、每封发送前都重验批准 revision、纪要来源和参会权限。生产使用 Resend，API Key 只存在服务端 Secret Manager，发信域名必须验证 SPF/DKIM。

## 10.1 服务器运营面

`apps/admin-web` 是与 API 同源交付的轻量管理界面，不引入第二套认证或客户端权限源。它复用已完成邮箱认证的正式账号登录，但所有管理 API 都额外从 PostgreSQL 重新验证 `isSystemAdmin`/不可复用 User ID 引导白名单；即使已认证且可重新注册的邮箱也永远不是权限依据。该运营面只默认显示会议元数据、参会人员和消息计数，不把全量会议正文变成默认后台浏览面。用户停用、会话撤销、一次性密码重置和强制结束会议均有事务内审计记录。

## 11. 多人会议领域模型

- `Participant` 是会议授权、展示和发言归属的权威记录，保存显示名称、公司、语言、注册/临时身份和 `ONLINE | OFFLINE | LEFT | REMOVED` 状态。
- 客户端提交消息时只提交本次录音和语言；服务端从认证主体反查 Participant，忽略客户端伪造的姓名、角色、participantId 和 ownerId。
- `TranslationMessage` 在创建时复制 `speakerDisplayName`、`speakerCompany`、`speakerLanguage`。参会者之后改名或换公司，历史消息仍保留发言当时的身份快照。
- `TranslationMessage.sourceText/translatedText` 保留供应商原始结果；人工修改和重新翻译追加到 `MessageCorrection`。消息行以 revision CAS 物化待确认及最后确认文本，历史/导出/纪要读取确认版本，同时保留原始文本与完整操作人快照供审计。
- 纠错写入在 provider/TTS 调用后按正式账号 `Conversation → User → UserDevice → Participant`、Guest `Conversation → GuestIdentity → Participant` 的统一顺序重新锁定；若调用期间发生退出、会议结束、移出、访客撤销、账号停用或设备下线，写入立即失败。历史权限仍可只读查看纠错记录。确认译文变化时重建 TTS，旧音频通过删除 outbox 清理。
- Host 移出注册用户只撤销其 Participant 和 App 内邀请。移出临时 Guest 时还会轮换共享二维码/房间码，防止其清除浏览器/设备标识后伪装成新访客重入；已在会中的其他 Participant 不受影响，但后续新访客必须使用新邀请。
- `ConversationSummary` 保存 `participantRoster`、`coreDiscussion`、`partyViews`、`confirmedItems`、`actionItems` 和 `openQuestions`；核心讨论逐条保留 participantId 和发言者快照，并用来源边界、revision、批准 revision 及生成审计字段标识内容状态。
- `SummaryGeneration` 是 AI 整理的幂等任务和可检索审计记录；活动来源 hash 唯一，超时任务可失败释放后由新键接管。
- `SummaryEmailDistribution`/`SummaryEmailRecipient` 记录主持人对一个纪要 revision 发起的逐人邮件分发；收件地址由服务端身份关系解析，客户端 participantId 只用于选择，不能覆盖邮箱或权限。
- `FriendRequest`、`Friendship` 和 `MeetingInvitation` 只关联注册 User；临时用户仍使用二维码、邀请链接或房间码。

## 12. 兼容迁移

多人版本使用正式增量迁移：`202607180006_multi_participant_meetings` 添加资料、状态、好友/邀请、发言者快照和纪要字段；`202607180007_remove_single_guest_constraint` 删除旧版“每个会议只有一名 GUEST”的部分唯一索引；`202607190005_message_corrections` 增加不可变纠错审计、review 状态和 revision 字段；`202607190006_summary_revision_and_language_backfill` 增加纪要来源边界/revision，并仅在历史 Participant 语言快照一致时回填旧身份语言；`202607190007_summary_email_distribution` 增加 Guest/Participant 邮箱快照及纪要分发/逐收件人状态；`202607190008_summary_message_update_boundary` 让确认纠错使旧纪要和排队邮件立即过期，并增加对应消息索引；`202607190009_unified_registered_user_role` 把旧 `HOST`/`CUSTOMER` 正式账号统一迁移为 `USER`，会议 `ParticipantRole` 保持不变；`202607190012_ai_summary_hardening` 增加政策版本、生成任务、模型审计、来源引用和主持人批准字段。迁移不改写 Conversation、Participant 或 TranslationMessage 的主键与原始翻译字段，旧一对一会议继续按原 `conversationId` 查看和导出。
