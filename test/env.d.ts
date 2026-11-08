import type { Env as MyriadEnv } from '../src/env'

declare global {
  namespace Cloudflare {
    interface Env extends MyriadEnv {}
  }
}
