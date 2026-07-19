# 后端、PostgreSQL 与 Redis 部署

## 1. 运行架构

- API：`services/api`，交付工具链固定 Node.js `22.23.1` / npm `10.9.x`，使用 TypeScript、Fastify、Socket.IO。
- HTTP 前缀：`/v1`；Socket.IO path：`/socket.io`。
- 数据库：PostgreSQL 16，Prisma 管理 schema 与迁移。
- Redis：Redis 7，用于 Socket.IO 跨实例 pub/sub、实时就绪检查和 Fastify 跨实例限流；永久消息与幂等权威状态仍以 PostgreSQL 为准。Railway 官方 Redis 模板在项目私网内提供带密码的 `redis://*.railway.internal` 连接，应用仅对此受控私网后缀放行明文传输；任何公网或其他主机仍必须使用 `rediss://`。
- 音频：后端校验并下载阿里云 TTS 临时资产；开发写本地目录，生产强制写私有 S3 兼容存储，数据库只留 asset ref，对外返回需短期签名与 Bearer 双重校验的内部 URL。
- 翻译：开发/CI 使用 mock；生产只允许服务端阿里云适配器，mock 配置会拒绝启动。
- 邮件：开发/CI 使用 mock；生产使用 Resend 逐人发送会议纪要，API Key 只在服务端，发信子域需完成 SPF/DKIM 验证。

推荐生产拓扑：

```text
Mobile Apps
   │ HTTPS / WSS
   ▼
Load Balancer / Reverse Proxy
   ├─ API instance 1 ─┐
   ├─ API instance 2 ─┼─ PostgreSQL 16（私网、备份/PITR）
   └─ API instance N ─┘
           │
           ├─ Redis 7（私网、TLS、持久化/高可用）
           ├─ 私有对象存储（TTS，生命周期清理）
           ├─ 阿里云百炼（ASR / MT / TTS）
           └─ Resend（会议纪要事务邮件）
```

## 2. 本地启动

根目录 `docker-compose.yml` 是开发环境，不是生产模板。它使用公开本机端口和固定弱密码：

```bash
cp .env.example .env
# 填写 JWT_ACCESS_SECRET、JWT_REFRESH_SECRET、PASSWORD_PEPPER
docker compose up -d postgres redis
npm ci
npm run db:generate
npm run db:migrate
npm run dev
```

本地默认 `TRANSLATION_PROVIDER=mock`。如需连真机，API 监听 `0.0.0.0`，App 使用电脑的局域网地址；不要把开发 PostgreSQL/Redis 端口暴露到公网。

完整本地容器可执行：

```bash
docker compose up --build api
```

Compose 从仓库根目录构建 `services/api/Dockerfile`，`migrate` one-shot service 在 PostgreSQL 健康后执行 `prisma migrate deploy`；只有退出码为 0，API 才启动。本地 Compose 会显式覆盖镜像默认值，以 `NODE_ENV=development` 使用容器内的非 TLS PostgreSQL/Redis；正式部署仍必须满足下文的 TLS 和对象存储校验。`.env` 必须先存在。若迁移失败，先查看 `docker compose logs migrate`，不要绕过依赖直接启动旧 schema 上的 API。

## 3. 生产环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `NODE_ENV=production` | 是 | 启用生产行为 |
| `HOST=0.0.0.0` / `PORT` | 是 | 容器监听地址和端口 |
| `LOG_LEVEL` | 是 | 建议 `info`，不得打印正文/Secret |
| `TRUST_PROXY=true` | 反向代理后是 | 正确识别协议/IP；只信任受控代理 |
| `DATABASE_URL` | 是 | PostgreSQL 私网 TLS 连接串 |
| `REDIS_URL` | 生产是 | 优先使用 Redis TLS/认证连接串；Railway 可使用带密码的 `redis://*.railway.internal` 私网引用，其他明文地址会被拒绝 |
| `RATE_LIMIT_NAMESPACE` | 是 | Redis 限流 key 前缀；开发、预发布、生产必须使用不同值 |
| `JWT_ACCESS_SECRET` | 是 | 独立高熵密钥，至少 32 字节 |
| `JWT_REFRESH_SECRET` | 是 | 与 Access Secret 不同 |
| `PASSWORD_PEPPER` | 密码登录是 | Secret Manager 管理，轮换需迁移方案 |
| `SYSTEM_ADMIN_USER_IDS` | 管理后台初始引导时 | 已注册且正常账号的不可复用 User ID 白名单，逗号分隔；不得用未验证且可重新注册的邮箱授予权限 |
| `ADMIN_PASSWORD_RESET_TTL_MINUTES` | 是 | 管理员签发的一次性密码重置凭证有效期，默认 30，范围 5–1440 |
| `ACCESS_TOKEN_TTL_SECONDS` | 是 | 默认 900 |
| `REFRESH_TOKEN_TTL_SECONDS` | 是 | 默认 2592000 |
| `PUBLIC_APP_URL=https://www.ruscny.net` | 是 | 已确定的邀请链接、H5 参会和下载主站；与 API 同源 |
| `PUBLIC_API_URL=https://www.ruscny.net` | 是 | 已确定的 API、管理后台和内部音频播放 HTTPS origin |
| `CORS_ORIGINS=https://www.ruscny.net` | 是 | 浏览器允许的正式来源；不得在生产使用 `*` |
| `INVITE_TTL_MINUTES` | 是 | 邀请默认有效期 |
| `UPLOAD_MAX_BYTES` | 是 | 二进制音频上限，默认且最大 6,000,000 字节，为 Base64/JSON 封装预留上游请求空间 |
| `TRANSLATION_PROVIDER=aliyun` | 是 | 生产禁止 mock |
| `ALIYUN_*` | 是 | 见阿里云接入文档 |
| `EMAIL_PROVIDER=resend` | 生产是 | 生产配置为 mock 会拒绝启动 |
| `RESEND_API_KEY` | 生产是 | 仅服务端 Secret；不得进入 App、日志或仓库 |
| `RESEND_API_BASE_URL` | 是 | 默认 `https://api.resend.com`，生产强制 HTTPS |
| `EMAIL_FROM` | 生产是 | 已验证域名的发件人，例如 `RUSCNY <minutes@send.ruscny.net>` |
| `EMAIL_REPLY_TO` | 否 | 可选客服/主持方回复邮箱 |
| `EMAIL_REQUEST_TIMEOUT_MS` | 是 | 单封请求超时，默认 15000，范围 1000–60000 |
| `AUDIO_STORAGE_DRIVER=s3` | 生产是 | 生产配置为 local 会拒绝启动 |
| `AUDIO_LOCAL_DIRECTORY` | 开发 local 时是 | 单机开发目录，不可作为多实例共享存储 |
| `AUDIO_URL_SIGNING_SECRET` | 生产是 | 独立高熵 HMAC 密钥，至少 32 字符 |
| `AUDIO_SIGNED_URL_TTL_SECONDS` | 是 | 内部播放 URL 有效期，默认 900 秒，范围 60–86400 |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` | 生产是 | 私有 S3 兼容对象存储位置；生产 endpoint 强制 HTTPS |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 生产是 | 最小读写删权限凭据 |
| `S3_FORCE_PATH_STYLE` | 是 | 默认 `false`；阿里云 OSS 必须保持 virtual-hosted style，仅兼容服务明确要求时设 `true` |

密钥通过部署平台 Secret Manager/工作负载身份注入，不烘焙进镜像、`.env` 文件、CI 日志或 Git。开发、预发布、生产必须使用不同数据库、Redis、对象存储和阿里云 Key。

## 4. 构建镜像

从仓库根目录执行，确保 workspace lockfile 生效：

```bash
npm ci
npm run db:generate
npm run build
npm test
docker build --file services/api/Dockerfile --target runtime \
  --tag translator-api:<git-sha> .
docker build --file services/api/Dockerfile --target migration \
  --tag translator-api-migration:<git-sha> .
```

末尾的 `.` 是必要的 monorepo build context：Dockerfile 读取根 `package-lock.json` 与 workspace manifests；不能改回 `services/api` 子目录 context。runtime target 只保留 production dependencies/生成的 Prisma Client/编译产物，migration target 单独保留 Prisma CLI。每次发布只运行一个 migration job，API 副本本身不执行迁移。

仓库 CI 已配置固定 Node、PostgreSQL/Redis 服务、`prisma migrate deploy`、build/typecheck、单元测试、独立 API/Socket 集成套件和 runtime image build。2026-07-19 的 GitHub CI 已成功完成这些校验；实际数量、运行链接和未验证边界以 [测试报告](./TEST_REPORT.md) 为准，不在部署文档硬编码易过期的测试计数。

生产镜像要求：

- 当前镜像固定 `node:22.23.1-alpine3.24`；升级 Node/Alpine 时单独更新并重新生成验证证据。
- 多阶段构建，只复制运行必需产物与 production dependencies。
- 使用非 root 用户，文件系统尽量只读；临时目录和缓存显式挂载。
- 镜像标签使用不可变 Git SHA，不用可漂移的 `latest` 作为回滚依据。
- 生成 SBOM 并做依赖/镜像漏洞扫描。
- 不把 `.env`、测试数据、私钥、keystore 或本地音频复制进镜像。

## 5. PostgreSQL

### 创建与连接

使用托管 PostgreSQL 16 或等价高可用部署。数据库不开放公网；API 使用最小权限应用账号。生产连接启用 TLS 并设置连接数、语句超时和空闲事务超时。高并发或无服务器场景可增加 PgBouncer，但必须验证 Prisma 的连接模式。

### 迁移

部署顺序：

1. 在预发布数据库从备份副本演练迁移。
2. 备份生产并记录恢复点。
3. 由单独 migration job 执行已提交的 Prisma deployment migration；不要让每个 API 副本同时迁移。
4. 验证 schema 与关键约束。
5. 再滚动发布 API。

仓库根脚本 `npm run db:migrate` 当前映射到 workspace 的 `prisma migrate deploy`，适合发布已提交的迁移；本地创建新迁移才使用 `prisma:migrate:dev`。生产禁止交互式 `migrate dev`。

`202607180003_device_sessions` 和 `202607180005_auth_session_families` 建立服务端会话代际；`202607190001_auth_data_hardening` 增加软删除墓碑、近期认证时间和稳定 GuestPrincipal；`202607190002_audio_deletion_outbox` 建立持久音频删除任务；`202607190003_audio_asset_lookup` 为播放权限反查建立索引；`202607190004_admin_console` 增加独立系统管理权限、不可变管理审计和只存摘要的一次性密码重置凭证；`202607190005_message_corrections` 增加消息纠错状态、revision 和不可变纠错审计；`202607190006_summary_revision_and_language_backfill` 增加纪要来源边界/revision；`202607190007_summary_email_distribution` 增加纪要邮件分发；`202607190008_summary_message_update_boundary` 增加消息更新时间来源边界；`202607190009_unified_registered_user_role` 把正式账号统一为 `USER`；`202607190010_admin_operations_phase1` 增加管理员职责分级；`202607190011_admin_business_operations_phase2` 增加公共术语、安全业务配置和删除台账，并为历史已注销账号回填最小化完成记录。必须先完成全部迁移再发布新 API。

上线前在 Resend 控制台验证独立发信子域（建议 `send.ruscny.net`）并添加平台生成的 SPF、DKIM 记录；不要猜测 DNS 值。使用真实收件箱验证中文、俄文、退信、限流和垃圾邮件表现。当前 API 记录的是供应商“已受理/失败”结果；若运营需要最终 delivered/bounced/complained 状态，应再配置签名 webhook 并完成重放和伪造事件测试。

API 进程启动后同时启动纪要邮件 worker。POST 只提交 PostgreSQL 持久任务，App 通过状态 GET 轮询；进程重启会重新扫描 `PROCESSING`。多实例允许同时运行 worker，逐收件人状态使用 CAS claim。供应商调用使用稳定幂等键；结果不明且已超过安全重试窗口的 claim 会失败并要求人工核对，禁止自动重复发送。

涉及删除列、改类型或大表索引时使用可回滚的 expand-and-contract：先新增兼容结构、回填、切流，再在后续版本删除。一次发布不要同时做不可逆 schema 删除和代码切换。

### 备份与恢复

- 启用每日快照和 point-in-time recovery，保留周期按运营主体政策确定。
- 备份加密，恢复权限与生产写权限分离。
- 至少每季度恢复到隔离环境，验证 Contact、Conversation、Participant、Message、sequence 和设备会话完整性。
- 用户注销/会议删除建立删除清单；从旧备份恢复后重新应用，避免已删除数据复活。

## 6. Redis

单进程开发允许无 Redis 的本地 Socket.IO 和内存限流回退；生产必须在启动时连通 Redis，同一连接服务同时为 Fastify 限流提供共享计数，Socket.IO 使用独立 pub/sub 连接。因此多副本不能通过切换 API 实例绕过账号/设备限流。消息幂等状态保存在 PostgreSQL，不随 Redis 丢失。

生产要求：

- 私网、ACL/密码和 TLS；不使用默认开放端口。
- 设置明确 key 前缀区分环境和应用。
- pub/sub 用于 Socket.IO 跨实例广播；带 TTL 的计数 key 用于 HTTP 限流；永久消息先写 PostgreSQL，再发布事件。
- 限流 key 必须使用环境前缀；不得把 PostgreSQL 幂等权威约束降级成只存 Redis。
- 根据业务选择 AOF/托管高可用；Redis 丢失时 API 可从 PostgreSQL 恢复历史，Socket.IO 连接和房间成员快照可以重建。
- 监控内存、淘汰、连接、延迟、失败和复制状态。不要使用 `allkeys-lru` 淘汰关键幂等状态而不评估后果。

## 7. 对象存储

`AUDIO_STORAGE_DRIVER=local` 只用于开发，生产配置校验强制 `s3`。TTS provider 返回 URL 后，API 仅接受 `aliyuncs.com`/`aliyun.com` 及其子域、禁止重定向，并在超时和 15 MB 上限内下载；原上游 URL 不写数据库。持久化成功后数据库保存内部 `asset:` 引用：

使用阿里云 OSS 时必须保持 `S3_FORCE_PATH_STYLE=false`，因为 OSS 只接受 virtual-hosted-style 请求。`S3_ENDPOINT` 使用地域服务 endpoint，bucket 名只放在 `S3_BUCKET`；如果 endpoint 内已嵌入 bucket，SDK 还会按 virtual-hosted style 再次添加，生成错误主机名。MinIO 等兼容存储若确实需要 path style，才在对应环境显式设为 `true`。上线前用真实 bucket 分别验证 Put/Get/Delete 和服务端加密。

- bucket 禁止公共读；Message DTO 把 asset ref 转成 `PUBLIC_API_URL/v1/audio/assets/...` 的 HMAC 签名 URL，默认 15 分钟有效。每次下载还必须携带 Access Token，API 会反查所属会议并重新校验当前权限。
- 对象 key 使用随机 ID/哈希，不包含姓名、电话、会议标题或原文。
- 对象只保存必要音频内容与 MIME/私有缓存属性，不在 key 或元数据写姓名、会议标题、原文或 Token。
- 生命周期规则自动清理过期 TTS；上传原始录音不进入长期 bucket。当前对象 key 未区分 provisional，应先为整个 TTS 前缀设置符合业务保留政策的最大生命周期；若后续增加独立 provisional 前缀，再为其配置更短规则，以覆盖数据库和对象存储同时不可用、无法写入清理任务的极端窗口。
- API 角色只具备指定 bucket/prefix 的读写删除权限。
- 下载域名启用 TLS、限速和日志脱敏。
- 删除会议时，API 在事务内写入 `AudioDeletionJob` 后级联删除业务行；提交后 worker 以 CAS 租约、陈旧锁恢复和指数退避删除本地/S3 对象。未引用 TTS 直接删除失败后也会入队。账号注销不删除共享会议的 TTS。上线前仍必须用真实 bucket 演练部分失败、长故障、备份恢复和生命周期兜底。

多实例不能把 `AUDIO_LOCAL_DIRECTORY` 当共享存储；容器重启、滚动发布或请求落到另一实例都会造成音频不可用。

## 8. 反向代理与 WebSocket

Nginx 概念配置：

```nginx
location /socket.io/ {
    proxy_pass http://translator_api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 75s;
}

location /join {
    proxy_pass http://translator_api;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location /v1/ {
    proxy_pass http://translator_api;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 6000000;
}

location / {
    proxy_pass http://translator_api;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

实际 `client_max_body_size` 与 `UPLOAD_MAX_BYTES` 一致。根路径官网、`/account`、`/register`、`/login`、`/privacy`、`/terms`、`/admin`、`/join`、`/v1` 与 `/socket.io` 必须保持同源；最后的 `location /` 将客户官网和其他服务端页面交给 API，不能指向另一份过期静态首页。官网账号页和 H5 仅向当前 origin 发送认证凭证，且 CSP 只允许同源连接。不要把 `apps/customer-web` 或 `deploy/deep-links/site` 单独部署成无 API 反代的静态站。负载均衡器 idle timeout 必须高于 Socket.IO ping 周期。启用 Redis adapter 后 WebSocket 不依赖 sticky session；若保留 polling fallback，则按 Socket.IO 部署要求配置会话亲和或强制客户端 websocket transport。

只开放 443；80 重定向 HTTPS。TLS 证书自动续期，HSTS 在确认所有子域后启用。CORS 仅允许正式 App/网页来源；原生 App 仍依赖 Token，不能把 CORS 当授权。

## 9. 健康检查与发布

建议区分：

- Liveness：进程事件循环可响应，不依赖第三方。
- Readiness：数据库连接和实时 Redis publisher/subscriber 就绪；Redis 运行期失联返回 503。
- Provider check：定期验证阿里云配置，但避免每次 readiness 产生计费调用。

滚动发布：

1. CI 执行 build、类型检查、单元/API/WebSocket/隔离测试。
2. 执行 migration job。
3. 部署一个 canary，readiness 成功后做登录、建会、加入和受控真供应商 smoke；mock 只允许非生产环境。
4. 逐步替换其余实例；旧实例停止接新连接并给 Socket.IO 足够 drain 时间。
5. 核对错误率、P95、数据库连接、Redis pub/sub、供应商超时和重复 message 指标。
6. 失败时回滚到上一不可变镜像；数据库回滚按已演练的兼容方案执行。

## 10. 监控和告警

至少监控：

- HTTP/Socket 连接数、状态码、握手/加入失败和重连率。
- 音频上传大小/耗时，ASR/MT/TTS 分阶段 P50/P95/P99、错误和 429。
- 每会议 sequence 冲突、幂等命中、重复事件、补拉条数和空洞。
- PostgreSQL 连接、锁、慢查询、复制延迟、磁盘和备份状态。
- Redis 延迟、内存、淘汰、断连和 pub/sub 错误。
- 对象存储上传/读取/删除失败、签名 URL 刷新和生命周期清理。
- 账号异常登录、房间码暴力尝试、跨域授权拒绝和 Secret 扫描。

日志使用 `requestId`、内部 `conversationId` 和 provider request ID 关联，默认不记录音频、完整原文/译文、Token、邀请令牌或签名 URL。

## 11. 上线检查表

- [ ] 生产 Secret 全部来自密钥管理，mock provider 已禁用。
- [ ] PostgreSQL/Redis/对象存储仅私网访问并启用认证/TLS。
- [ ] migration 在备份副本演练，生产恢复点已记录。
- [ ] 音频删除 worker 的部分失败、实例中断、租约回收和 bucket 生命周期兜底已演练。
- [ ] 多副本 Socket.IO 通过 Redis adapter 互通。
- [ ] 正式域名、证书、App Link 和 Universal Link 文件可访问。
- [ ] `/`、`/account`、`/register`、`/login`、`/privacy`、`/terms`、`/og.png`、`robots.txt` 和 `sitemap.xml` 以中俄双语官网内容正确响应，账号页保持 `no-store`。
- [ ] 使用隔离测试邮箱从网页完成注册、刷新、退出和重新登录，并确认同一账号可在 Android/iOS App 登录。
- [ ] `/join/<token>` 、`/join/app.js`、`/v1`、Socket.IO 客户端脚本和 WebSocket Upgrade 在同一 HTTPS origin 通过。
- [ ] iOS Safari / Android Chrome 已实测 H5 中俄语言、Guest 续期、录音上传、断线补拉、TTS 与被移出权限。
- [ ] 音频大小、请求超时、代理 idle timeout 与客户端一致。
- [ ] 隔离、幂等、结束竞态、Token 轮换和断线补拉测试通过。
- [ ] 中文/俄语 ASR→MT→TTS 真实账号验收通过。
- [ ] 备份、监控、成本、安全和供应商告警已触发演练。
- [ ] 回滚镜像、负责人和值班/故障联系路径已记录。
