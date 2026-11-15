# 万象 myriad_api · 协作说明

跨仓库的需求、里程碑和进度见上一级目录的 `../AGENTS.md`（不在本仓库中）。接口与部署说明见 [README.md](README.md)。客户端在 `myriad` 仓库的 `packages/core/src/sync/`。

## 约定

- **绑定全部可选**：任何依赖 D1 / KV / R2 / Secret 的代码都要先判断绑定是否存在，缺少时返回 `501`（`*-disabled`）或退回不依赖它的做法，不能抛错。新增功能时同步更新 `src/env.ts` 的 `features()` 和 README 的接口表。
- **免费套餐**：每次请求只有 10ms CPU。不要在请求路径上实例化 `Y.Doc`，同步只做 `Y.mergeUpdates` 级别的二进制合并；需要解析文档内容的工作放到客户端。
- **鉴权**：私有接口都挂在 `/v1/me/*` 下，由 `requireAuth` 校验独立连接令牌（Worker Secret 保存 SHA-256 校验值）或可选 Access JWT。`DEV_AUTH_BYPASS` 只在请求主机名是 localhost / 127.0.0.1 时生效，不要放宽。
- **公开接口**：要挂 `rateLimit`，可缓存的 GET 用 `edge()` 包一层 Cache API。不为未登录访客转发需要 Key 的接口。
- **图标代理**：只接受公网 http(s) 主机名；响应带 `ICON_HEADERS`（CSP sandbox），SVG 不能在本域执行脚本。
- **对象存储**：使用 `src/objects.ts`，R2 优先、D1 分块回退。无 R2 时每个对象最多 10MiB；分块与元数据必须在同一 D1 事务中发布。删除或覆盖要清理旧分块，启用 R2 后仍要支持读取和删除旧 D1 对象。
- **D1**：表结构同时写在 `migrations/` 和 `src/sync.ts` 的 `SCHEMA`（首次请求自动建表），改表时两处一起改，并新增迁移文件。单个 BLOB 不超过 `MAX_UPDATE_BYTES`。
- **格式**：Prettier（无分号、单引号、行宽 100）。

## 验证

```bash
npm run typecheck && npm test
```

测试在 workerd 里运行（`@cloudflare/vitest-plugin`），D1 / KV / R2 由 Miniflare 模拟，Access 用测试里生成的密钥对签发 JWT（`setJwksForTesting`）。

## 已知问题 / 待办

- 2026-11-14 已部署到 `https://myriad.zxabinbina.cc.cd`，D1 / KV / 限流 / 定时任务与数据库迁移完成。本账户配置及资源 ID 在 Git 忽略的 `wrangler.local.toml`，后续部署使用 `npm run deploy -- --config wrangler.local.toml`，不要误用模板覆盖实际配置。详情见 `docs/DEPLOYMENT.md`。
- 本账户尚未启用 Access 和 R2：已按用户要求改为独立令牌鉴权与 D1 分块对象存储，私有接口、备份和文件同步现已可用，无需开通这两项。令牌原文在 Git 忽略的 `.local/connection-token.txt`，Worker 只保存校验值。
- 本机的 npm 10 安装 vitest 4 系列时会因可选 peer 崩溃，因此测试用 vitest 5 + `@cloudflare/vitest-plugin`（`vitest-pool-workers` 的新名字）。
- 2026-11-14：M3 首批公开接口 `/v1/weather`、`/v1/weather/cities`、`/v1/quote` 已实现，固定免费上游、限流 / 边缘及 KV 缓存；无任何绑定时也能运行。天气空气质量失败独立降级。`features.weather` / `features.quote` 列出可用性。
- 2026-11-14：M3 第二批公开接口 `/v1/minecraft`、`/v1/currency`、`/v1/currency/history` 已实现，免费来源、限流及缓存，绑定均可选。Java 版经 DoH 解析 SRV / 公网 IP 并固定解析地址后 SLP 握手（`node:net`），8 秒超时 / 128KiB 包上限；基岩版由 mcstatus.io 提供。只查询当前状态，不记录人数历史。汇率历史查询不得退回当前 ER 报价，日期与最多 31 天的范围由路由验证。
- Java SLP 连接失败后回退到固定 mcstatus.io（再给 8 秒），仅在公网 DNS 验证通过后回退。Cloudflare TCP 会拒绝部分 Cloudflare 托管 / 代理地址，线上已验证 Hypixel 回退；无效地址与内网 DNS 不得进入回退。查询失败日志不包含鉴权信息。
- 2026-11-14：新增私有 `POST /v1/me/translate`，已部署可选 `AI` 绑定和 m2m100，线上英语 → 中文成功；无 AI 时可选固定 DeepL / Microsoft 官方来源（各自 Secret）。入口鉴权 / 限流、24KiB 请求体上限、2000 字符与语言 / provider 验证，m2m100 不接受 auto。响应 `private, no-store`，不存原文 / 结果，不记录上游异常或密钥；禁止重定向，25 秒上游超时。AI 绑定不能取消已启动的推理，客户端隐藏只中止等待并丢弃晚到结果。
- **2026-11-15 M3 完成**：新增 `github.ts`、`qweather.ts` 与公开 / 私有路由。GitHub 公开永远不用 Secret，私有结果不写 KV / edge；和风仅私有使用 Key 或 EdDSA JWT，空气 / 预警独立降级、无配置退回免费天气。现行 v1 接口经过官方 OpenAPI 查证，旧 v7 空气 / 预警已退役。
- 翻译使用 `translationStructure.ts` 保留标题 / 列表 / 空行 / 缩进 / 代码块，与客户端 core 算法镜像；整次 25 秒、最多 3 段并发，失败不返回半译文。Workers fetch 不接受 `redirect:error`，统一用 manual 并拒绝 3xx；`enable_request_signal` 在模板和实际部署配置均启用，私有 Key 不跟随重定向。
- 验证：66 项 workerd 测试、类型检查通过；线上贡献图返回 371 天，匿名仓库 API 额度耗尽返回明确 `github-quota`；无 GitHub Token 返回 501、私有 no-store、无和风配置退回 Open-Meteo 均实测。用户确认未配置和风 / GitHub Key，私有内容通过固定上游模拟测试，不声称真实付费服务已验证。
- 热榜 / RSS 与聚合搜索已在 M4 实现，网站版（M5）复用现有公开接口限流；Turnstile 尚未配置。M4 已完成试用反馈修正。
- Deploy to Cloudflare 按钮与 GitHub Actions 在 M6 加入。
- 微博等站点会拦截机房 IP，图标代理抓不到时客户端回退到图标库或文字图标。

- **2026-11-15 服务密钥**：私有 GET `/v1/me/credentials` 只返回配置状态，PUT `/v1/me/credentials/:service` 只接收 origin / service 绑定的 AES-GCM 密文，额外要求独立连接令牌；Access 与旧环境凭据仍兼容读取。D1 新表 `service_credentials` 在迁移 0003 与 SCHEMA 中同时定义，保存时重新以独立 HKDF 上下文加密。白名单字段、必填校验、版本 CAS 与明确删除，不能记录请求正文或返回密钥。`credentialEnv` 仅私有路由使用，公开 GitHub / 天气不得调用。
- 所有已实现 API 凭据读取同一存储：和风、GitHub、Unsplash、DeepL / 百度 / 有道 / 腾讯 / Microsoft、OpenAI 兼容服务。`translationProvider.ts` 镜像 core 请求算法（workerd 不支持 credentials / cache 与 redirect:error），腾讯固定签名向量保持一致；OpenAI Key 绑定 HTTPS 公网完整端点，更换端点需新 Key，禁重定向。连接令牌轮换会令旧密文锁定，要求重新填写；文档备份不含此表。Google / Brave 存储在 M4 用于私有搜索转发。

- 服务密钥验证：core 79 / 扩展后台 4 / Worker 74 项测试、类型检查、Chrome / Firefox / playground 构建通过；界面、翻译、M3 与真实本地 Worker 的凭据浏览器回归通过，包括另一标签页即时更新、密文上传、失败保留输入、空白保留、删除和端点绑定。线上 Worker 已更新，凭据接口只读鉴权 / no-store 检查通过；真实第三方密钥仍待填写后验证供应商权限与额度。

## M4 · 信息流与聚合搜索（2026-11-15）

- 新增公开 `/hot`、`/rss`、`/reader`、`/search` 和私有 `/me/search`、POST `/me/summary`；公开路由限流，私有路由鉴权且 no-store。`features()` 与 README 同步列出 feeds / reader / summary / search / searchWeb。
- `content.ts` / `hotSources.ts` / `search.ts` 与客户端 core 镜像且字节一致。RSS / HTML 使用 inert htmlparser2；任意内容 URL 只接受公网域名及标准端口，每个重定向验证 DNS，跨 origin 删除 Cookie / Authorization，正文限 1MiB。不得把用户任意请求头转发上游，不记录 Key-bearing URL。
- 12 个热榜源固定适配，微博 / B 站提供上游 Referer，抖音仅使用官方临时 CSRF 引导，无存储用户 Cookie。KV 缺失时 Cache API；日周期只在按需请求刷新，失败短暂节流并标注旧快照。未指定 period 默认当前 UTC 日起点，避免新快照立刻过期。不要加热榜 Cron。
- AI 摘要只处理公开正文，按正文、URL 与语言缓存七天，缺少 AI 501。已实测 `@cf/meta/llama-3.1-8b-fast-v2`，旧 instruct 绑定返回退役错误；REST 兼容别名能成功不代表 Worker 绑定仍可用。
- 公开搜索只调用官方站内 API。通用搜索调用 private credentialEnv 获取 Google CSE / Brave 保存值或旧 Secrets，无 Key 501；Google Search Engine ID 必需。访客不转发用户 Key，不缓存私有搜索。
- 验证：83 项 workerd 测试、类型检查通过；客户端 101 + 扩展 7 项测试及双浏览器构建通过，M4 浏览器 20 项检查通过。线上 10 源成功，B 站 / 抖音 Worker 502，RSS / reader / npm 搜索 / 私有摘要 200；真实搜索密钥未配置，不声称验证了付费搜索额度。
- 当前部署版本 `d72d58ca-8a79-45dc-ad0a-a025382d0f16`，使用 wrangler.local.toml，M4 无新增数据库迁移。M5 访客网站本地开发完成，等待试用反馈，复用当前公开接口。

- **2026-11-15 M4 阅读媒体**：reader 返回按 DOM 顺序排列的 blocks（text / image / video / audio / unavailable），保留 paragraphs 兼容旧客户端与 AI。支持图片懒加载属性 / picture、相对 URL、视频 source / poster 及音频；只返回 http(s) 无凭据地址，不返回可执行 HTML，iframe / object 等为占位块。使用最终重定向地址解析相对媒体，reader 缓存升至 v2。客户端镜像字节一致；85 项 workerd 测试通过，线上 reader example.com / MDN 返回 200 和新 blocks。已部署到原域名，无迁移。

- **2026-11-15 M5**：用户取消网站隐藏登录 / OAuth，homepage 只调用免费公开接口。个人同步、私有搜索、服务密钥与 AI 摘要均不可用于访客；公开路由仍使用既有限流，不要求新增数据库、密钥或部署。content.ts 增加明确类型以支持 npm 声明输出，与 core 镜像继续字节一致，运行行为无变化。
