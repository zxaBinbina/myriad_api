# 万象 myriad_api · 协作说明

跨仓库的需求、里程碑和进度见上一级目录的 `../AGENTS.md`（不在本仓库中）。接口与部署说明见 [README.md](README.md)。客户端在 `myriad` 仓库的 `packages/core/src/sync/`。

## 约定

- **绑定全部可选**：任何依赖 D1 / KV / R2 / Secret 的代码都要先判断绑定是否存在，缺少时返回 `501`（`*-disabled`）或退回不依赖它的做法，不能抛错。新增功能时同步更新 `src/env.ts` 的 `features()` 和 README 的接口表。
- **免费套餐**：每次请求只有 10ms CPU。不要在请求路径上实例化 `Y.Doc`，同步只做 `Y.mergeUpdates` 级别的二进制合并；需要解析文档内容的工作放到客户端。
- **鉴权**：私有接口都挂在 `/v1/me/*` 下，由 `requireAuth` 校验 Access JWT。`DEV_AUTH_BYPASS` 只在请求主机名是 localhost / 127.0.0.1 时生效，不要放宽。
- **公开接口**：要挂 `rateLimit`，可缓存的 GET 用 `edge()` 包一层 Cache API。不为未登录访客转发需要 Key 的接口。
- **图标代理**：只接受公网 http(s) 主机名；响应带 `ICON_HEADERS`（CSP sandbox），SVG 不能在本域执行脚本。
- **D1**：表结构同时写在 `migrations/` 和 `src/sync.ts` 的 `SCHEMA`（首次请求自动建表），改表时两处一起改，并新增迁移文件。单个 BLOB 不超过 `MAX_UPDATE_BYTES`。
- **格式**：Prettier（无分号、单引号、行宽 100）。

## 验证

```bash
npm run typecheck && npm test
```

测试在 workerd 里运行（`@cloudflare/vitest-plugin`），D1 / KV / R2 由 Miniflare 模拟，Access 用测试里生成的密钥对签发 JWT（`setJwksForTesting`）。

## 已知问题 / 待办

- 本机的 npm 10 安装 vitest 4 系列时会因可选 peer 崩溃，因此测试用 vitest 5 + `@cloudflare/vitest-plugin`（`vitest-pool-workers` 的新名字）。
- 热榜、RSS、翻译、天气、GitHub、Minecraft、汇率等数据接口在 M3 / M4 加入；Turnstile 在网站版（M5）加入。
- Deploy to Cloudflare 按钮与 GitHub Actions 在 M6 加入。
- 微博等站点会拦截机房 IP，图标代理抓不到时客户端回退到图标库或文字图标。
