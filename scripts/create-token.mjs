import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// 凭据只写入 Git 忽略的本机目录，不输出令牌内容。
const directory = new URL('../.local/', import.meta.url)
const tokenPath = new URL('connection-token.txt', directory)
const secretsPath = new URL('token-secrets.json', directory)
const rotate = process.argv.includes('--rotate')
if (process.argv.slice(2).some((arg) => arg !== '--rotate'))
  throw new Error('Usage: npm run token:create [-- --rotate]')
await mkdir(directory, { recursive: true, mode: 0o700 })
await chmod(directory, 0o700)
let token
if (!rotate) {
  try {
    token = (await readFile(tokenPath, 'utf8')).trim()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
if (token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(token))
  throw new Error('Existing token file is invalid. Inspect it before rotating.')
token ??= randomBytes(32).toString('base64url')
await writeFile(tokenPath, token + '\n', { mode: 0o600 })
await chmod(tokenPath, 0o600)
await writeFile(
  secretsPath,
  JSON.stringify({ SYNC_TOKEN_SHA256: createHash('sha256').update(token).digest('hex') }, null, 2) +
    '\n',
  { mode: 0o600 },
)
await chmod(secretsPath, 0o600)
process.stdout.write(
  `Connection token saved to ${fileURLToPath(tokenPath)}\nDeployment secret file saved to ${fileURLToPath(secretsPath)}\n`,
)
