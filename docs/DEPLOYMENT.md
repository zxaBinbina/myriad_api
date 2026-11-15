# 本工作区部署记录

2026-11-14 已将不依赖 Access / R2 的方案部署到 <https://myriad.zxabinbina.cc.cd>。

| 项目                | 当前状态                                                                            |
| ------------------- | ----------------------------------------------------------------------------------- |
| Worker / 自定义域名 | 已部署，`GET /v1/health` 返回 200                                                   |
| 鉴权                | Worker 独立连接令牌；正确令牌返回 200，缺失或错误令牌返回 401                       |
| D1                  | `myriad`，迁移 `0001_init.sql`、`0002_objects.sql`、`0003_credentials.sql` 均已完成 |
| KV                  | `myriad-api-cache`，绑定为 `CACHE`                                                  |
| 同步                | Yjs 增量同步与大快照，已验证双向同步                                                |
| 备份                | 存入 D1，每日默认保留 2 份，其他备份保留 5 份                                       |
| 文件                | 自动分块存入 D1，单个对象最多 10MiB                                                 |
| 图标代理            | Cache API 缓存，正常可用                                                            |
| 天气 / 城市 / 一言  | M3 首批免费来源已部署，线上接口均返回 200                                           |
| 汇率 / 历史         | 免费来源已部署，CNY → USD 当前值及 30 天历史返回 200                                |
| Minecraft           | Java 优先 SLP，TCP 失败回退 mcstatus.io；Java / 基岩线上验证 200                    |
| 翻译                | 已绑定 AI，私有 m2m100 英语 → 中文返回 200，匿名请求拒绝 401                        |
| GitHub              | 公开贡献图 371 天已实测；匿名仓库 API 达到 IP 额度时明确返回 github-quota           |
| 服务密钥            | 扩展 / 小组件界面填写，AES-GCM + HTTPS 上传，独立 D1 加密存储                       |
| 和风 / GitHub 私有  | 用户未配置密钥，模拟测试通过；天气实际回退 Open-Meteo，私有 GitHub 返回 501         |
| 热榜 / RSS          | M4 已部署；10 源热榜与 IT 之家 RSS 实测 200，B 站 / 抖音 Worker 受限                |
| 阅读 / AI 摘要      | reader 与私有 fast-v2 摘要实测 200，重复摘要一致；仅预览时生成                      |
| 聚合搜索            | 公开 npm 搜索 200；Google CSE / Brave 真 Key 未配置，私有搜索明确返回 501           |
| 限流                | 公开数据接口每 IP 每分钟 120 次                                                     |
| 定时任务            | 每天 UTC 20:00（北京时间 04:00）执行                                                |
| Access / R2         | 不需要开通；保留为可选兼容路径                                                      |
| Unsplash            | 未提供 Key，关闭                                                                    |

当前 Worker 版本：`3614b8b5-d42b-40e1-9f1a-6561d27433b9`（2026-11-15 M4 信息流、搜索与摘要模型更新）。

## 连接扩展

1. 在 `chrome://extensions` 中重新加载万象。Chrome / Firefox 两个扩展构建均已更新。
2. 打开万象「设置 → 同步」，认证方式选择「连接令牌」。
3. 服务地址填写 `https://myriad.zxabinbina.cc.cd`。
4. 打开本仓库 `.local/connection-token.txt`，将内容粘贴到令牌输入框，点击连接并允许访问该地址。

每台设备使用同一令牌。该文件仅限本机账户读取，`.local/` 已被 Git 忽略；原令牌不上传到 Worker，也不进入 JSON 导出或 Yjs 同步。服务器的 `SYNC_TOKEN_SHA256` Secret 只保存校验值。

旧版 Access 连接方式和凭据会在本机数据升级时保留，可以手动切换认证方式。

## 更新部署

`wrangler.toml` 是自部署模板，R2 默认注释；本账户资源 ID 与域名保存在 Git 忽略的 `wrangler.local.toml`。在 `myriad_api/` 目录运行：

```bash
npm run deploy -- --config wrangler.local.toml
npm run db:migrate -- --config wrangler.local.toml
```

首次配置或轮换令牌：

```bash
npm run token:create                         # 已有令牌时复用
# npm run token:create -- --rotate           # 明确需要轮换时使用
npm run deploy -- --config wrangler.local.toml --secrets-file .local/token-secrets.json
```

轮换后旧令牌失效，需要在每台设备更新。后续部署未指定 `--secrets-file` 时，原 Secret 会保留。

## 存储边界

每个 D1 分块不超过 1,000,000 字节，每个备份、文件或大快照对象最多 10MiB。元数据和全部分块在同一事务中写入，失败时回滚；覆盖和删除会清理旧分块。较大视频壁纸可保存在本机或使用视频链接。

D1 备份与同步数据位于同一个数据库，可用于误操作回滚；独立的离线副本继续通过 JSON 导出保留。以后启用 R2 时，旧 D1 对象仍可读取、列出和删除。

## 验证

- 类型检查通过，core 75 项、扩展后台 4 项、Worker 66 项测试通过，Chrome / Firefox 与 playground 构建成功。
- 用户完整 commit 原文经线上 m2m100 翻译后保留标题、空行及 7 条列表，浏览器显示与复制格式一致。M3 新回归覆盖 GitHub 各视图 / 私有缓存隔离 / 原生校验、农历与法定假期、和风预警与隐藏取消；另重跑原界面、天气、服务和便签回归。
- 正式 Chrome 的当前 Minecraft 地址 `play.mcyzw.top:25703` 返回 502；2026-11-15 公开 DoH 查询无 A / AAAA 记录，属于该来源地址不可解析，保留「无法查询」，未更改用户配置或伪报离线。
- 原有浏览器冒烟与 Dock 背景包覆回归通过；M3 浏览器验证了城市 / 收藏 / 单位设置、手动经纬度零值与小数、每日缓存与跨日更新、多标签页复用、视口外 / 后台不请求以及隐藏取消进行中的请求。
- M3 第二批 30 项浏览器检查通过：去掉编号小标签、共享监控快照、刷新间隔与不轮询、未知 / 零人数处理、MOTD 安全文字与颜色、仅显示已配置的历史、汇率主备来源与历史日期、设置持久化。深浅主题截图已检查。
- 线上汇率最新值与历史返回 200（Frankfurter，CNY → USD，2026-11-13 报价，30 天范围含 22 个样本）。Java `mc.hypixel.net` 经 mcstatus.io 回退、基岩 `play.cubecraft.net` 均返回 200，人数与版本有效；内网服务器地址返回 400。Cloudflare TCP 拒绝部分托管地址，SLP 分片包与中止逻辑通过固定数据单元测试，线上验证覆盖了第三方回退路径。
- M3 线上健康、天气、城市、一言接口均返回 200；天气返回 7 天天气与 168 个小时样本，当前温度与 AQI 有效。一言无需鉴权返回有效句子。Secret 与 D1 / KV 绑定沿用原部署。
- 两个隔离浏览器页面在本地 Worker 上验证了独立令牌连接、设置跨设备同步、D1 手动备份与回滚、2.1MB 文件分块往返与删除，以及刷新后自动恢复同步。
- 线上验证健康接口、有效身份、错误 / 缺失令牌拒绝、独立测试文档的双向 Yjs 同步、D1 分块文件和备份列表；临时测试文档与文件已清理。
- 原用户浏览器数据未参与测试；线上 `main` 文档未写入测试数据，等待用户加载扩展后连接。

浏览器联调脚本为 `myriad/scripts/check-sync.py`，线上检查为 `scripts/check-deployment.mjs`。后者使用本机令牌和独立测试文档，结束后清理测试数据。

M3 组件浏览器测试另有 `myriad/scripts/check-m3.py`、`check-translation.py`、`check-memo.py`，使用固定数据源和隔离存储，不写线上同步文档。线上 M3 检查为 `scripts/check-m3-live.mjs`、`check-translation-live.mjs`；当前未配置和风 / GitHub 私有 Key，不验证真实付费调用。

## 服务密钥界面配置（2026-11-15）

已连接 Worker 后，在扩展「设置 → 服务密钥」或天气 / GitHub / 翻译组件设置中填写。无需逐项添加 Worker Secrets，也无需 Access 或 R2。覆盖和风、GitHub、Unsplash、五家官方翻译与 OpenAI 兼容服务。空白保留已保存字段，删除使用明确按钮；状态不返回秘密，普通文档同步 / JSON / 备份不含凭据。更换连接令牌后需重新填写服务密钥，清单 E2E 密钥仍只在设备上。

隔离本地 Worker 的浏览器验证使用 `myriad/scripts/check-credentials.py`，只使用临时测试库与假密钥；正式服务验证只读取健康与配置状态，不写测试 Key。

- 2026-11-15 正式 Chrome 验证：通过用户提供的 127.0.0.1:9222 调试连接，确认没有未保存编辑后重载扩展；「服务密钥」页九类服务入口、状态读取与空白密钥输入正常，未填写 / 上传测试密钥。截图：`myriad/artifacts/credentials-real-chrome.png`。

## M4 信息流与聚合搜索（2026-11-15）

Worker 新增公开热榜、RSS、reader、官方站内搜索与私有通用搜索 / AI 摘要，已部署，无新增迁移。连接扩展后可添加「热榜 / RSS」组件；聚合搜索默认关闭，在「设置 → 搜索」开启。Google CSE / Brave 凭据可选，在「服务密钥」界面加密保存，无 Key 不影响官方站内搜索及第三方跳转。

- Worker 热榜成功：知乎 30、微博 50、V2EX 10、Hacker News 30、GitHub Trending 15、少数派 30、IT 之家 36、掘金 20、36 氪 17、百度 51 条。B 站与抖音当前返回 502；B 站本机带浏览器 UA / Referer 的请求成功，扩展支持本机回退但上游是否接受当前 Cookie / 来源仍需试用，抖音本机也未稳定成功。
- IT 之家 RSS 60 条、example.com 正文提取、npm 的 vue 搜索 20 条，均返回 200。没有搜索 Key 的私有 Bing 回退返回 501 与 `private, no-store`，符合预期。
- AI 绑定的旧 instruct 模型返回已退役错误；REST 别名会转新模型，与绑定行为不同。改用 `@cf/meta/llama-3.1-8b-fast-v2` 后私有摘要连续两次 200、内容一致、响应均 no-store；按正文与语言复用服务端缓存。
- core 101 / 扩展 7 / Worker 83 项测试及类型检查、Chrome / Firefox / playground 构建通过。M4 浏览器 20 项、原界面 / Dock、天气每日缓存 / 可见性、M3 GitHub 表单 / 私有数据等回归通过。M4 离线脚本：`npm run build:web` 后运行 `MYRIAD_OFFLINE=1 python3 scripts/check-m4.py`。
- Chrome 不允许把 `declarativeNetRequest` 声明为可选，实际使用 `declarativeNetRequestWithHostAccess`；GitHub 表单 pattern 按现行 v 模式转义连字符。预览规则仅指定 tab、精确 URL、扩展 initiator 与 sub_frame；拒绝权限或嵌入失败可转阅读模式。
- 线上测试不写 main 文档或测试密钥；AI 测试仅处理公开正文。Chrome 验证使用内存隔离测试数据，用户实际清单、提醒和同步配置不参与测试。M4 交付试用，M5 尚未开始。

## M4 试用反馈修正（2026-11-15）

已部署 `d72d58ca-8a79-45dc-ad0a-a025382d0f16`，继续使用 wrangler.local.toml 与原域名，无数据库迁移。reader 增加有序图片、视频、音频与不可展示媒体块，保留旧 paragraphs；按最终重定向地址解析相对媒体，缓存版本 v2。客户端加入单实例平台 / 订阅记忆及文章悬浮阅读，保留点击弹窗。

core 105 / 扩展 7 / Worker 85 项测试、类型检查、Chrome / Firefox / 网页构建通过；M4 原有 20 项与反馈 23 项交互检查通过，包括真实本地 WebM / WAV 播放、媒体失败占位符和 Chrome v 正则校验。线上 reader example.com 与 MDN 返回 200 / 新 blocks，MDN 第三方嵌入输出占位块。测试不用线上 main 文档或用户凭据。另用临时 Worker、随机测试令牌与隔离 D1 验证双设备同步、备份 / 回滚、文件分块及重载恢复，通过后清理临时库。
