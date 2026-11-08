<p align="center"><img src="https://raw.githubusercontent.com/zxaBinbina/myriad/main/docs/logo.svg" width="96" height="96" alt="万象"></p>

# 万象 myriad_api

[万象（Myriad）](https://github.com/zxaBinbina/myriad) 的后端：一个 Cloudflare Worker，提供多设备同步、云端备份、高清图标代理和若干数据接口。接口统一在 `/v1/*` 下。

除 Worker 本身外，**所有绑定都是可选的**：缺少某个绑定时对应功能自动关闭，其余照常运行。`GET /v1/health` 会列出当前可用的功能。

## 接口

| 接口                                   | 鉴权 | 说明                                                                      | 依赖                  |
| -------------------------------------- | ---- | ------------------------------------------------------------------------- | --------------------- |
| `GET /v1/health`                       | 公开 | 版本与可用功能                                                            | —                     |
| `GET /v1/geo`                          | 公开 | 按 IP 粗略定位（国家、城市、时区、经纬度），用于判断是否显示农历和节假日  | —                     |
| `GET /v1/icon?url=&size=`              | 公开 | 抓取网站的 apple-touch-icon / 高清 favicon，找不到返回 404                | R2、KV（可选）        |
| `GET /v1/holidays/:year`               | 公开 | 中国法定节假日（[holiday-cn](https://github.com/NateScarlet/holiday-cn)） | KV（可选）            |
| `GET /v1/me`                           | 私有 | 当前身份与可用功能（用于测试连接）                                        | —                     |
| `POST /v1/me/sync`                     | 私有 | 同步：上传本机的 Yjs 更新，取回其他设备的更新                             | D1                    |
| `GET / POST /v1/me/backups`            | 私有 | 列出备份 / 立即备份                                                       | D1、R2                |
| `GET / DELETE /v1/me/backups/:id`      | 私有 | 下载（Yjs 快照）/ 删除备份                                                | D1、R2                |
| `PUT /v1/me/backups/config`            | 私有 | 每日备份开关与保留份数（默认 2 份）                                       | D1、R2                |
| `PUT / GET / DELETE /v1/me/blobs/:key` | 私有 | 用户上传的壁纸等文件（单个最大 50MB）                                     | R2                    |
| `GET /v1/me/wallpaper/unsplash?query=` | 私有 | Unsplash 每日一图                                                         | `UNSPLASH_ACCESS_KEY` |

公开接口按 IP 限流（`RATE_LIMIT` 绑定，默认每分钟 120 次），并用 Cache API 做边缘缓存。

### 同步协议

```
POST /v1/me/sync
{ "doc": "main", "after": 42, "update": "<base64 Yjs 更新，可省略>" }
→ { "seq": 57, "update": "<base64，after 之后其他来源的更新，已合并>", "full": false }
```

- 客户端推送的更新按顺序追加到 D1，自增 id 就是序号；客户端记住收到的最大序号，下次带上 `after`。
- 刚推送的那条不会返回给客户端自己。客户端的 `after` 早于快照（或服务器数据被清空）时返回完整状态，`full` 为 `true`。
- 更新超过 48 条时用 `Y.mergeUpdates` 压缩进快照，以 `upto` 做乐观锁，并发压缩不会丢更新。快照超过 D1 单值上限（约 2MB）时放进 R2。
- 服务器只做二进制合并、不实例化文档，CPU 开销很小（免费套餐每次请求 10ms CPU）。

冲突检测在客户端完成：客户端保留一份「最近一次与服务器一致」的基准文档，与本机、远端做三方比较。

### 定时任务

每天 UTC 20:00（北京时间 04:00）：压缩同步数据、做一份每日备份（内容没变则跳过）、刷新今年（第四季度加上明年）的节假日缓存。

## 部署

需要 Node.js 22 以上和一个 Cloudflare 账户。

```bash
git clone https://github.com/zxaBinbina/myriad_api.git
cd myriad_api
npm install
npx wrangler login
```

1. **改 `wrangler.toml`**：把 `routes` 里的域名换成自己的（域名需托管在 Cloudflare），或删掉 `routes` 使用 `*.workers.dev`。不需要的绑定直接删掉。
2. **部署**：`npm run deploy`。新版 wrangler 会自动创建没有填 id 的 D1 / KV / R2。表结构在首次请求时自动创建，也可以运行 `npm run db:migrate`。
3. **配置 Cloudflare Access**（私有接口必须，未配置时 `/v1/me/*` 一律返回 503）：
   1. 打开 [Zero Trust](https://one.dash.cloudflare.com/)，首次使用时创建团队，记下团队域名（`<team>.cloudflareaccess.com`）。
   2. Settings → Authentication → Login methods 添加 **GitHub**。
   3. Access → Service credentials → Service Tokens，创建一个令牌，记下 Client ID 和 Client Secret（Secret 只显示一次）。
   4. Access → Applications → Add an application → **Self-hosted**：域名填 Worker 的域名，路径填 `v1/me`（会覆盖其下所有路径）。添加两条策略：
      - Action **Allow**，Include → Emails → 你的 GitHub 邮箱（网站版登录用）
      - Action **Service Auth**，Include → Service Token → 上一步创建的令牌（扩展用）
   5. 在应用的 Overview 里复制 **Application Audience (AUD) Tag**。
   6. 把团队域名和 AUD 写进 `wrangler.toml` 的 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`，重新部署。Worker 会再校验一次 `Cf-Access-Jwt-Assertion`，防止有人绕过 Access 直接访问。
4. **可选 Secrets**：`npx wrangler secret put UNSPLASH_ACCESS_KEY`。
5. 在万象扩展的 设置 →「同步」里填服务地址和 Service Token，点「连接」。

| 变量 / Secret         | 说明                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN`  | Access 团队域名，如 `https://myteam.cloudflareaccess.com`                               |
| `ACCESS_AUD`          | Access 应用的 AUD 标签                                                                  |
| `ALLOWED_IDENTITIES`  | 可选的身份白名单（逗号分隔的邮箱或 Service Token 的 Client ID），留空只依赖 Access 策略 |
| `ALLOWED_ORIGINS`     | 允许带凭据跨域访问的网页来源（逗号分隔）；浏览器扩展靠主机权限访问，不用列在这里        |
| `UNSPLASH_ACCESS_KEY` | Secret，Unsplash 每日壁纸                                                               |

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
| `src/backups.ts`    | R2 备份与保留策略                      |
| `src/icons.ts`      | 图标代理（HTMLRewriter 解析、R2 缓存） |
| `src/data.ts`       | KV 缓存、节假日、地理位置、Unsplash    |
| `migrations/`       | D1 表结构                              |

## 许可证

[Apache License 2.0](LICENSE)
