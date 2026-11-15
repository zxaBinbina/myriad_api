<p align="center"><img src="https://raw.githubusercontent.com/zxaBinbina/myriad/main/docs/logo.svg" width="96" height="96" alt="万象"></p>

# 万象 myriad_api

[万象（Myriad）](https://github.com/zxaBinbina/myriad) 的后端：一个 Cloudflare Worker，提供多设备同步、云端备份、高清图标代理和若干数据接口。接口统一在 `/v1/*` 下。

除 Worker 本身外，**所有绑定都是可选的**：缺少某个绑定时对应功能自动关闭，其余照常运行。`GET /v1/health` 会列出当前可用的功能。

## 接口

| 接口                                                                             | 鉴权 | 说明                                                                      | 依赖                              |
| -------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------- | --------------------------------- |
| `GET /v1/health`                                                                 | 公开 | 版本与可用功能                                                            | —                                 |
| `GET /v1/geo`                                                                    | 公开 | 按 IP 粗略定位（国家、城市、时区、经纬度），用于判断是否显示农历和节假日  | —                                 |
| `GET /v1/hot?source=&period=`                                                    | 公开 | 12 源热榜，按日缓存与旧快照回退                                           | KV（可选，缺少时 Cache API）      |
| `GET /v1/rss?url=&period=`                                                       | 公开 | RSS / Atom 解析，RSSHub 使用完整订阅 URL                                  | KV（可选，缺少时 Cache API）      |
| `GET /v1/reader?url=`                                                            | 公开 | 提取公开文章标题、摘要与文字 / 媒体块                                     | KV（可选，缺少时 Cache API）      |
| `GET /v1/search?engine=&q=&page=&lang=`                                          | 公开 | 官方站内搜索 API，不使用用户 Key                                          | —                                 |
| `GET /v1/me/search?engine=&q=&page=&lang=`                                       | 私有 | Google CSE / Brave 通用网页搜索                                           | 保存凭据或搜索 Secret             |
| `POST /v1/me/summary`                                                            | 私有 | 按公开正文与语言缓存 AI 摘要                                              | AI，KV（可选）                    |
| `GET /v1/weather?latitude=&longitude=&air=1`                                     | 公开 | Open-Meteo 当前 / 逐小时 / 7 天天气、日出日落，可选美国 AQI               | KV（可选）                        |
| `GET /v1/weather/cities?name=&language=zh`                                       | 公开 | Open-Meteo 城市搜索（名称至少 2 字符；`zh` / `en`）                       | KV（可选）                        |
| `GET /v1/me/weather?latitude=&longitude=&provider=auto&air=1&warnings=1&lang=zh` | 私有 | 和风天气 / AQI / 预警，缺少配置或失败退回 Open-Meteo                      | 保存凭据或和风 Secret、KV（可选） |
| `GET /v1/github?user=&org=&repos=&section=`                                      | 公开 | 公开仓库、贡献图、Actions、Release、关注动态                              | KV（可选），不使用 Token          |
| `GET /v1/me/github?user=&org=&repos=&section=`                                   | 私有 | 账号数据、指派 / 审阅请求和通知，仅鉴权请求使用 Token                     | 保存凭据或 `GITHUB_TOKEN`         |
| `GET /v1/quote?day=YYYY-MM-DD&c=a&c=b`                                           | 公开 | 按设备日期与分类缓存的一言；`c` 可重复，不填为全部                        | KV（可选）                        |
| `GET /v1/minecraft?address=&kind=java`                                           | 公开 | Java SLP 当前状态，连接失败回退 mcstatus.io；支持基岩版，不存历史         | KV（可选）                        |
| `GET /v1/currency?base=CNY&quote=USD&date=latest`                                | 公开 | 免费汇率与来源日期，`date` 也可为 YYYY-MM-DD                              | KV（可选）                        |
| `GET /v1/currency/history?base=&quote=&from=&to=`                                | 公开 | Frankfurter 时间序列；日期范围最多 31 天                                  | KV（可选）                        |
| `GET /v1/icon?url=&size=`                                                        | 公开 | 抓取网站的 apple-touch-icon / 高清 favicon，找不到返回 404                | R2、KV（可选）                    |
| `GET /v1/holidays/:year`                                                         | 公开 | 中国法定节假日（[holiday-cn](https://github.com/NateScarlet/holiday-cn)） | KV（可选）                        |
| `GET /v1/me`                                                                     | 私有 | 当前身份与可用功能（用于测试连接）                                        | —                                 |
| `POST /v1/me/translate`                                                          | 私有 | m2m100 / 五家官方服务 / OpenAI 兼容翻译，不存原文和结果                   | AI 或翻译 Secret                  |
| `POST /v1/me/sync`                                                               | 私有 | 同步：上传本机的 Yjs 更新，取回其他设备的更新                             | D1                                |
| `GET / POST /v1/me/backups`                                                      | 私有 | 列出备份 / 立即备份                                                       | D1（R2 可选）                     |
| `GET / DELETE /v1/me/backups/:id`                                                | 私有 | 下载（Yjs 快照）/ 删除备份                                                | D1（R2 可选）                     |
| `PUT /v1/me/backups/config`                                                      | 私有 | 每日备份开关与保留份数（默认 2 份）                                       | D1（R2 可选）                     |
| `PUT / GET / DELETE /v1/me/blobs/:key`                                           | 私有 | 用户上传的壁纸等文件（D1 单个最大 10MiB / R2 50MiB）                      | D1 或 R2                          |
| `GET /v1/me/wallpaper/unsplash?query=`                                           | 私有 | Unsplash 每日一图                                                         | `UNSPLASH_ACCESS_KEY`             |

公开接口按 IP 限流（`RATE_LIMIT` 绑定，默认每分钟 120 次），并用 Cache API 做边缘缓存。

免费天气缓存 30 分钟（失败时 KV 可返回旧值），城市搜索缓存一天，一言按日期与分类保存。天气与一言均无需 Key；AQI 上游失败返回 `aqi: null`，不阻断天气。公开上游固定为 Open-Meteo / Hitokoto，传入的鉴权头不会转发。和风天气仅在私有路径使用自己的凭据，预警失败不会丢失天气。

### 在扩展中配置服务密钥

无需在 Worker 控制台逐项配置 Secret。在万象「设置 → 服务密钥」或相关小组件设置中填写，使用现有连接令牌鉴权与 AES-GCM + HTTPS 上传；Worker 独立 D1 表二次加密保存，只在私有调用时解密。支持和风、GitHub、Unsplash、DeepL、百度、有道、腾讯、Microsoft、OpenAI 兼容服务以及 Google CSE / Brave 搜索。

- `GET /v1/me/credentials`：返回 `enabled` 与各服务的配置状态、已保存字段名、版本与来源；永远不返回密钥值。
- `PUT /v1/me/credentials/:service`：仅接受 `{v:1,iv,data}` 密文。明文为 `{fields,version,remove?}`，`version` 取上次读取结果；空白字段保留，`remove:true` 删除已保存记录。请求体上限 40KiB、鉴权 / 限流 / 白名单 / 必填验证，旧版本返回 409，密文或字段错误返回 400。
- 加密协议见 `credentialCrypto.ts`：从连接令牌 SHA-256 经 HKDF-SHA256 派生 AES-GCM-256，96 位随机 nonce；传输 AAD 绑定 origin / 服务，存储使用独立上下文。D1 表不进入 Yjs 文档或文档备份。旧 Secrets 是兼容回退，界面保存值覆盖对应项。
- `features.credentials` 表示有 D1 与连接令牌；鉴权 `/v1/me` 的能力包含已保存值与无秘密版本，公开 `/health` 不读取凭据。只有个人令牌可保存应用层密文；原有 Access 接口继续可用。
- 连接令牌轮换后旧密文无法解密，状态标记 `locked`，需要重新填写或删除服务凭据；无需额外加密 Secret。OpenAI Key 绑定完整 HTTPS 公网端点，地址变化时需要重新输入 Key，所有请求拒绝重定向。Worker 能解密凭据调用服务，这不是清单 E2E。

### 信息流、阅读与 AI 摘要

`source` 支持 `zhihu/weibo/bilibili/v2ex/hackernews/github/sspai/ithome/juejin/36kr/baidu/douyin`。`period` 是当前本地刷新周期起点的毫秒时间戳，最多向前两天、允许一分钟时钟偏差；不填使用当前 UTC 日起点。每个源 / RSS 地址共享快照，成功后保留到下一周期，失败返回标记 `stale` 的旧值并短暂延后重试，不靠 Cron 主动抓榜单。KV 缺失时回退 Cache API。

RSS 和 reader 只允许公网 HTTP(S) 域名及标准端口；每次跳转都验证地址和公开 DNS，跨来源移除 Cookie / Authorization，最多跟随三次重定向，上游正文上限 1MiB。RSS / Atom 与热榜 HTML 用 inert 解析器处理，返回文字和安全链接。阅读模式不输出上游可执行 HTML。

`POST /v1/me/summary` 请求体为 `{ "url": "https://example.com/article", "lang": "zh-CN" }`，`lang=en` 返回英文，其他值用中文。只处理公开文章，模型 `@cf/meta/llama-3.1-8b-fast-v2`，按 URL、正文及语言缓存七天，缺少 AI 返回 `501 summary-disabled`。私有响应 `private, no-store`；正文 / 摘要缓存可以使用 KV 或 Cache API。客户端只在打开预览时请求。旧 instruct 模型的绑定已退役，不继续使用。

2026-11-15 本工作区实测 10 个热榜源成功；B 站 / 抖音的 Worker 抓取受上游限制，分别返回 `502 source-unavailable`。扩展自动模式可以尝试本机网络回退，抖音本机也未稳定成功。已实现适配器不代表上游长期可用；提取失败明确返回错误，不生成虚构榜单。

### 聚合搜索

公开 `/search` 支持 `github/npm/mdn/wikipedia/mcwiki/stackoverflow/hackernews` 的官方 API，`page` 从 0 开始，最大 49，`q` 最多 300 字符。站内来源的 IP 额度仍以供应商为准。Google / Bing / 百度 / DDG HTML 抓取在扩展本机执行，Worker 不抓取它们的结果 HTML。

私有 `/me/search` 支持 `google/bing/baidu/duckduckgo`，返回实际 `provider`，仅 Google CSE / Brave 可用时转发。Google 优先 CSE、其他引擎优先 Brave，缺少时尝试另一个已配置服务；无配置返回 `501 search-disabled`。界面填写 Google CSE Key / Search Engine ID 或 Brave Key，复用独立加密凭据；也兼容 `GOOGLE_SEARCH_KEY` / `GOOGLE_SEARCH_ID` 与 `BRAVE_SEARCH_KEY` Secrets。上游地址固定，禁止重定向，不缓存私有搜索，不记录带 Key 的错误 URL。

`features.feeds/reader/search` 表示公开能力，`features.summary` 表示 AI 绑定，`features.searchWeb` 列出可用搜索 API。公开 `/health` 只使用环境配置，不读取个人凭据；私有 `/me` 返回个人已保存配置对应的能力。公开搜索不会借用用户 Key；网站访客的通用网页搜索使用跳转链接。当前尚未配置真实搜索 Key，只验证了固定上游模拟与无 Key 降级。

### 和风天气与 GitHub

和风需配置专属域名 `QWEATHER_HOST`（如 `abc123.qweatherapi.com`），以及 `QWEATHER_API_KEY`；也支持 EdDSA JWT：`QWEATHER_PRIVATE_KEY`（PKCS#8 PEM）、`QWEATHER_KID` 与 `QWEATHER_SUB`。默认在扩展界面填写上述字段并加密保存；也兼容用 `wrangler secret put <NAME> --config wrangler.local.toml` 配置旧 Secrets，不把密钥写入 Git。已使用现行 v1 天气、空气和预警接口；旧 v7 空气 / 预警在 2026 年退役。`provider=auto/qweather/open-meteo`，`air` / `warnings` 为 0 时关闭对应项，`lang=zh/en`。和风缓存 15 分钟，缺少配置或失败退回免费天气；预警不可用时返回 `warningsUnavailable: true`。

GitHub 的 `section` 为 `repositories/contributions/tasks/notifications/actions/releases/activity`；默认 `user=zxaBinbina`、`org=Youzai-World-Team`，`repos` 为逗号分隔的最多 8 个 `owner/repo`，可将 `org` 留空。私有路径需 `GITHUB_TOKEN`，缺失返回 `501 github-disabled`，具备何种数据取决于 Token 的读取权限。待处理任务以 Token 所属用户为准。公开路径禁止 tasks / notifications，且不会使用 Token；公开贡献图读取 GitHub 官方贡献页面，其余使用官方 REST。匿名 REST 按 IP 限额，额度耗尽返回 `502 github-quota`；私有不足额度 / 权限返回 `github-quota-or-scope`。

GitHub 私有响应始终 `private, no-store`，不进入 KV / 边缘缓存；公开仓库缓存 5 分钟，公开贡献图缓存一小时。全部来源固定官方域名，Worker 用 `redirect: manual` 拒绝 3xx，不把凭据跟随重定向发送。配置保留 `enable_request_signal`，支持客户端离开后取消上游等待（[Cloudflare 官方说明](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests)）。`features.qweather/github/githubPrivate` 只返回可用性，不返回密钥。

Minecraft 状态缓存 60 秒。Java 服务器仅接受公网地址，默认端口会经 DoH 查询 SRV；验证解析结果后固定数值 IP 进行 SLP 握手，8 秒超时，响应上限 128KiB。Cloudflare TCP 不能连接部分托管或代理地址，握手失败后使用固定 mcstatus.io 免费来源（额外最多 8 秒），回退保留未显式指定端口的地址以支持 SRV。无效 / 内网 DNS 解析不进入回退，两种来源均失败时返回 `502 server-unavailable`，不据此断言服务器离线。已有历史由客户端直连用户状态接口，Worker 不主动探测或记录人数。

汇率缓存 12 小时，主备为 Frankfurter → ExchangeRate-API → Currency API，均不需要 Key。历史日期查询跳过只有最新报价的 ExchangeRate-API；范围接口失败时客户端可每五天获取离散历史样本。返回上游实际报价日期；缺少支持或上游失败返回 502，KV 有旧值时可降级返回缓存。

### 翻译

```json
{ "text": "Hello world", "source": "en", "target": "zh", "provider": "ai" }
```

`POST /v1/me/translate` 返回 `{ "text": "您好世界" }`（支持自动识别的服务可带 `detected`）。`provider` 可为 `ai`（默认）、`deepl`、`baidu`、`youdao`、`tencent`、`microsoft`、`openai`；`source` / `target` 支持 `zh,en,ja,ko,fr,de,es,ru,pt,it,ar`。DeepL / Microsoft 可用 `source: "auto"`，m2m100 必须明确原文语言。

启用 AI 时在自己的配置中取消 `[ai]` / `binding = "AI"` 的注释后部署；也可用 `wrangler secret put DEEPL_API_KEY --config wrangler.local.toml` 或 `MICROSOFT_TRANSLATOR_KEY` 配置官方服务。DeepL Free Key 的 `:fx` 后缀自动选择免费端点，Microsoft 区域 Key 另配置 `MICROSOFT_TRANSLATOR_REGION`。缺少所选绑定 / Secret 返回 `501 translation-disabled`，健康接口 `features.translation` / `features.translators` 只公开可用性，不公开密钥。

只允许登录后的请求，默认沿用每 IP 每分钟 120 次限流；输入最多 2000 字符、请求体最多 24KiB，非法参数返回 400，上游失败 / 超时返回 502。POST 与响应 `private, no-store`，不会缓存、记录或存储原文和结果。外部来源固定、禁止重定向，25 秒超时；AI 绑定没有取消已开始推理的能力。模型与服务各有额度和语言支持限制。

多行文字逐行翻译后重新组装，保留换行类型、空行、缩进及 Markdown 标题 / 列表 / 引用 / checklist 前缀；围栏代码和分隔线不翻译。最多 3 段并发，25 秒为整次预算；部分失败不返回混合译文，多行内容会增加上游调用次数。

### 同步协议

```
POST /v1/me/sync
{ "doc": "main", "after": 42, "update": "<base64 Yjs 更新，可省略>" }
→ { "seq": 57, "update": "<base64，after 之后其他来源的更新，已合并>", "full": false }
```

- 客户端推送的更新按顺序追加到 D1，自增 id 就是序号；客户端记住收到的最大序号，下次带上 `after`。
- 刚推送的那条不会返回给客户端自己。客户端的 `after` 早于快照（或服务器数据被清空）时返回完整状态，`full` 为 `true`。
- 更新超过 48 条时用 `Y.mergeUpdates` 压缩进快照，以 `upto` 做乐观锁，并发压缩不会丢更新。快照超过 D1 单值上限（约 2MB）时优先放进 R2，否则分块存入 D1。
- 服务器只做二进制合并、不实例化文档，CPU 开销很小（免费套餐每次请求 10ms CPU）。

冲突检测在客户端完成：客户端保留一份「最近一次与服务器一致」的基准文档，与本机、远端做三方比较。

### 定时任务

每天 UTC 20:00（北京时间 04:00）：压缩同步数据、做一份每日备份（内容没变则跳过）、刷新今年（第四季度加上明年）的节假日缓存。

## 部署

需要 Node.js 22 以上和一个 Cloudflare 账户。**Worker + D1 即可提供同步、备份与文件存储，无需开通 Access 或 R2。** KV 可选；Access 与 R2 保留为可选替代配置。

```bash
git clone https://github.com/zxaBinbina/myriad_api.git
cd myriad_api
npm install
npx wrangler login
cp wrangler.toml wrangler.local.toml
```

`wrangler.local.toml` 与 `.local/` 已被 Git 忽略，本机配置和令牌不提交到仓库。

1. 修改 `wrangler.local.toml` 的域名，或删除 `routes` 使用 `*.workers.dev`；`SYNC_IDENTITY` 填自己的显示名称。
2. 运行 `npm run token:create`，生成一个 256 位随机连接令牌。原文保存在 `.local/connection-token.txt`，SHA-256 校验值保存在 `.local/token-secrets.json`；命令不会输出令牌内容。再次运行会复用原令牌。
3. 部署并迁移数据库：

   ```bash
   npm run deploy -- --config wrangler.local.toml --secrets-file .local/token-secrets.json
   npm run db:migrate -- --config wrangler.local.toml
   ```

   Wrangler 自动创建未填写 ID 的 D1 / KV，并绑定自定义域名。Worker 只接收令牌校验值，原令牌不上传。后续部署可以省略 `--secrets-file`，已配置的 Secret 会保留。

4. 重新加载万象扩展。在「设置 → 同步」选择「连接令牌」，填写服务地址，把 `.local/connection-token.txt` 的内容粘贴到令牌框，点击连接并允许访问该地址。每台设备使用同一令牌；令牌只保存在设备本机，不导出、不同步。

需要轮换令牌时运行 `npm run token:create -- --rotate`，随后带 `--secrets-file` 重新部署，并在各设备更新令牌。旧令牌会在新版本上线后失效。

本工作区的部署状态与连接步骤见 [部署记录](docs/DEPLOYMENT.md)。

### D1 文件与备份

没有 R2 时，备份、壁纸和大同步快照自动分块存入 D1，每块最多 1,000,000 字节，每个对象最多 **10MiB**。元数据与分块在同一事务中写入，覆盖、删除和备份清理会一并清理分块。每日备份默认保留 2 份，手动 / 导入前 / 回滚前另保留最近 5 份；内容未改变的每日备份跳过。

较大的视频壁纸仍可保存在本机，或使用图片 / 视频链接。图标代理使用 Cache API 缓存，不将公开图标写入 D1。D1 备份与同步数据位于同一个数据库，可继续导出 JSON 保留独立的离线副本。

### 可选 Access / R2

- **Access**：仍支持现有 JWT、Service Token 和登录 Cookie。创建 Zero Trust 团队、GitHub 登录、Self-hosted 应用（路径 `v1/me`），设置 Allow 与 Service Auth 策略；填写团队域名与 AUD 后重新部署。在扩展选择「Cloudflare Access」并填写 Client ID / Secret。没有连接令牌校验值，也未配置 Access 时，私有接口返回 503；已配置连接令牌时，无令牌或错误令牌返回 401。
- **R2**：账户已启用 R2 时可取消配置中 `[[r2_buckets]]` 的注释并重新部署。对象优先写入 R2，单文件上限提高到 50MiB；以前存入 D1 的文件和备份仍能读取、列出和删除。账户未启用时保持此绑定注释，避免错误码 10042。
- **Unsplash**：可通过 `npx wrangler secret put UNSPLASH_ACCESS_KEY --config wrangler.local.toml` 配置。

| 变量 / Secret                            | 说明                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `SYNC_TOKEN_SHA256`                      | Secret，独立连接令牌的 SHA-256 十六进制校验值；用 `token:create` 生成后部署 |
| `SYNC_IDENTITY`                          | 独立令牌对应的显示名称，默认 `owner`                                        |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`      | 可选的 Access 团队域名与应用 AUD                                            |
| `ALLOWED_IDENTITIES`                     | 可选的 Access 身份白名单；独立令牌的权限由校验值控制                        |
| `ALLOWED_ORIGINS`                        | 允许带凭据跨域访问的网页来源；扩展靠主机权限访问                            |
| `UNSPLASH_ACCESS_KEY`                    | 可选 Secret，Unsplash 每日壁纸                                              |
| `DEEPL_API_KEY`                          | 可选 Secret，私有 DeepL 翻译                                                |
| `MICROSOFT_TRANSLATOR_KEY`               | 可选 Secret，私有 Microsoft 翻译                                            |
| `MICROSOFT_TRANSLATOR_REGION`            | 可选变量 / Secret，区域 Key 对应的 Microsoft 区域                           |
| `BRAVE_SEARCH_KEY`                       | 可选 Secret，私有 Brave 搜索；优先使用界面保存值                            |
| `GOOGLE_SEARCH_KEY` / `GOOGLE_SEARCH_ID` | 可选 Secret，私有 Google CSE Key / Search Engine ID；优先使用界面保存值     |

## 开发

```bash
cp .dev.vars.example .dev.vars   # DEV_AUTH_BYPASS=true：只对 localhost 请求跳过 Access
npm run dev                      # http://127.0.0.1:8787，D1 / KV / R2 都在本地模拟
npm test                         # Vitest，在 workerd 运行时里跑（@cloudflare/vitest-plugin）
npm run typecheck
npm run format
```

| 文件                | 说明                                   |
| ------------------- | -------------------------------------- |
| `src/index.ts`      | 路由（Hono）、边缘缓存、定时任务       |
| `src/env.ts`        | 绑定与变量类型、可用功能判断           |
| `src/auth.ts`       | Access JWT 校验                        |
| `src/middleware.ts` | 跨域、强制 HTTPS + HSTS、按 IP 限流    |
| `src/sync.ts`       | 同步存储（D1 追加 + 快照压缩）         |
| `src/backups.ts`    | 备份与保留策略                         |
| `src/icons.ts`      | 图标代理（HTMLRewriter 解析、R2 缓存） |
| `src/data.ts`       | KV 缓存、节假日、地理位置、Unsplash    |
| `src/objects.ts`    | R2 / D1 分块对象存储                   |
| `src/widgets.ts`    | 天气 / 城市 / 一言免费上游             |
| `src/minecraft.ts`  | Java SLP 与基岩服务器当前状态          |
| `src/currency.ts`   | 免费汇率及历史来源                     |
| `migrations/`       | D1 表结构                              |

## 许可证

[Apache License 2.0](LICENSE)

### 阅读模式媒体

`GET /v1/reader?url=` 的 `blocks` 按原文顺序包含 `text`、`image`、`video`、`audio` 或 `unavailable`，保留 `paragraphs` 供旧客户端与 AI 使用。媒体只输出安全 http(s) 地址及纯文本标签，不返回原始 HTML；支持相对地址、最终重定向路径、常见懒加载图片 / picture、原生视频与音频。第三方 iframe / object 等输出占位块，客户端媒体加载 / 播放失败也显示占位符。reader v2 缓存不会复用旧的纯文本快照。
