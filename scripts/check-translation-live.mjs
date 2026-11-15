import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const base = 'https://myriad.zxabinbina.cc.cd'
const health = await fetch(`${base}/v1/health`)
assert.equal(health.status, 200)
const info = await health.json()
assert.equal(info.features.translation, true)
assert.ok(info.features.translators.includes('ai'))
console.log('PASS translation AI feature enabled')
const body = JSON.stringify({ text: 'Hello world', source: 'en', target: 'zh', provider: 'ai' })
const anonymous = await fetch(`${base}/v1/me/translate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
})
assert.equal(anonymous.status, 401)
console.log('PASS anonymous requests rejected')
const token = (await readFile('.local/connection-token.txt', 'utf8')).trim()
const response = await fetch(`${base}/v1/me/translate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body,
  signal: AbortSignal.timeout(45000),
})
assert.equal(response.status, 200, `translation HTTP ${response.status}`)
assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
const result = await response.json()
assert.ok(typeof result.text === 'string' && /[\u3400-\u9fff]/u.test(result.text))
console.log('PASS authenticated m2m100 translation:', result.text)

const commit = `feat: add translation widget and related functionality

- Implemented the Translation widget in WidgetEditor.vue, allowing users to save translation settings.
- Registered the translation widget in the widget registry with appropriate settings and component.
- Created a new composable useWidgetVisibility to manage widget visibility based on intersection and document visibility.
- Added translation-related messages to English and Chinese i18n files.
- Introduced a new state management file for translation, handling translation credentials and requests.
- Developed a regression test script for translation functionality using Playwright.
- Updated UI tests to ensure proper functionality of the new translation features.`
const formatted = await fetch(`${base}/v1/me/translate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ text: commit, source: 'en', target: 'zh', provider: 'ai' }), signal: AbortSignal.timeout(45000),
})
assert.equal(formatted.status, 200, `formatted translation HTTP ${formatted.status}`)
const translated = (await formatted.json()).text
assert.equal(translated.split('\n').length, commit.split('\n').length)
assert.equal(translated.split('\n')[1], '')
assert.equal(translated.split('\n').filter(line => line.startsWith('- ')).length, 7)
assert.ok(/[\u3400-\u9fff]/u.test(translated.split('\n')[0]))
console.log('PASS user commit retains title, blank line and all seven list items')
console.log(translated)
