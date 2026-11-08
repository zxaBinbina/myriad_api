import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          ACCESS_TEAM_DOMAIN: 'https://myriad-test.cloudflareaccess.com',
          ACCESS_AUD: 'test-aud',
          ALLOWED_ORIGINS: 'https://zxabinbina.cc.cd',
        },
      },
    }),
  ],
})
