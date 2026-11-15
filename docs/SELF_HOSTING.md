# 自部署万象 API

需要 Node.js 22.12 以上、Cloudflare 账户和自己的万象扩展。默认使用 Workers 免费套餐；D1 用于同步、凭据、文件与备份，KV 用于缓存。R2、Access 和 AI 都可选。

## 使用 Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zxaBinbina/myriad_api)

按钮会将公开仓库复制到你的 GitHub / GitLab 账户，在你的 Cloudflare 账户中部署 Worker，自动创建默认 D1 / KV。模板不含作者的域名或资源 ID，默认使用你的 `workers.dev` 地址。此按钮用于 API Worker；网站仍使用现有 Cloudflare Pages 部署方式。

首次部署即可使用公开接口。私有接口在设置鉴权前保持关闭。按钮不会替你生成无法取回的连接令牌：部署完成后克隆自己的仓库，再执行下节的令牌生成步骤，将 SHA-256 校验值设为 Worker Secret，并将原文只保留在自己的设备上。

## 本机部署与连接

```bash
git clone https://github.com/zxaBinbina/myriad_api.git
cd myriad_api
npm ci
npx wrangler login
cp wrangler.toml wrangler.local.toml
npm run token:create
npm run deploy -- --config wrangler.local.toml --secrets-file .local/token-secrets.json
npm run db:migrate -- --config wrangler.local.toml
```

复制配置后可修改 Worker 名称、数据库名与 `SYNC_IDENTITY`。Wrangler 自动创建未填写 ID 的资源；迁移通过绑定名 `DB` 找数据库，修改数据库名不影响命令。首次请求也会初始化表结构。保留 Wrangler 写回的资源 ID，后续使用同一份本机配置部署。

如果已通过按钮部署，先在 Cloudflare 确认 Worker 名称、D1 / KV 的资源 ID，并将它们填入本机配置，避免新建另一组资源。然后执行 `npm run token:create`，通过以下命令上传生成文件中的校验值，执行数据库迁移即可，无需再次部署代码：

```bash
npx wrangler secret bulk .local/token-secrets.json --config wrangler.local.toml
npm run db:migrate -- --config wrangler.local.toml
```

在扩展「设置 → 同步」选择「连接令牌」，填写自己的 HTTPS Worker 地址，把 `.local/connection-token.txt` 的内容粘贴到连接令牌框，点击连接并允许该地址。每台设备使用同一令牌。原文只保存在设备和 `.local/`；Worker 仅保存校验值。`.local/`、`wrangler.local.toml` 与本机环境文件不提交。

`npm run token:create` 再次运行会复用原令牌。只有主动轮换时使用 `npm run token:create -- --rotate`，重新上传校验值并更新各设备。轮换会让已有服务密钥密文无法解密，需重新填写；不会改变设备上的清单端到端加密密钥。

## 按需配置

| 能力                           | 配置与缺失行为                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| 同步、备份、私有文件、服务密钥 | 默认 `DB`；无 D1 时关闭，其他公开接口仍可运行。无 R2 时单个对象最多 10MiB。                     |
| 热榜、RSS、正文、天气等缓存    | 默认 `CACHE`；无 KV 时回退 Cache API。热榜仅按需刷新，不增加抓取 Cron。                         |
| AI 翻译与文章摘要              | 取消 `[ai]` 注释后重新部署。无 AI 时关闭这些能力，不影响公开阅读。AI 有供应商额度。             |
| R2 文件与备份                  | 账户启用 R2 后再取消 `[[r2_buckets]]` 注释；未启用保持注释。旧 D1 对象仍可读取。                |
| 第三方服务密钥                 | 连接后在扩展「服务密钥」填写并加密上传，无需逐项配置 Worker Secrets。公开接口不会使用个人 Key。 |
| Access                         | 可选，配置团队域名与 AUD，扩展选择 Service Token。独立连接令牌不需要 Access。                   |
| 自定义域名                     | 在本机配置中填写自己的 `routes`。带凭据跨域的自有网页还需填写 `ALLOWED_ORIGINS`。               |
| 限流与统计                     | 默认 `RATE_LIMIT` 每 IP 每分钟 120 次；Analytics Engine 可按需启用。                            |

## 更新、检查与恢复

更新前可从扩展导出 JSON 并检查云端备份。拉取源码后执行 `npm ci`、`npm run typecheck` 和 `npm test`，再使用既有 `wrangler.local.toml` 部署和迁移；不要重新创建令牌或用公共模板覆盖本机配置。自动化部署环境设置 Cloudflare 部署凭据，不将它们写入源码。

访问 `https://你的地址/v1/health` 检查 `features`，再从扩展连接以验证私有鉴权与同步。`401` 表示令牌缺失 / 错误，`503 auth-not-configured` 表示尚未配置鉴权，`501 *-disabled` 表示对应绑定 / 服务缺失。断网可继续使用本机数据，恢复后自动同步；云端备份可以在设置中回滚。

GitHub Actions 只执行类型、workerd 单元测试与 Wrangler dry-run，不修改生产资源。按钮部署后的持续发布由 Cloudflare Workers Builds 管理。构建命令 `npm run build`、部署命令 `npm run deploy`；数据库新增迁移后仍运行上面的迁移命令。
