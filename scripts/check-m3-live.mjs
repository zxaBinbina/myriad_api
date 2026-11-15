import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const base = 'https://myriad.zxabinbina.cc.cd'
const health = await (await fetch(`${base}/v1/health`)).json()
assert.equal(health.features.github, true)
console.log('PASS M3 GitHub feature enabled; QWeather and private GitHub need user configuration')
for (const section of ['repositories', 'contributions']) {
  const response = await fetch(`${base}/v1/github?section=${section}`, {
    signal: AbortSignal.timeout(45000),
  })
  if (section === 'repositories' && response.status === 502) {
    assert.deepEqual(await response.json(), { error: 'github-quota' })
    console.log('PASS exhausted public GitHub API quota returns a clear quota error')
    continue
  }
  assert.equal(response.status, 200, `public GitHub ${section} HTTP ${response.status}`)
  const result = await response.json()
  assert.equal(result.personal, false)
  assert.ok((section === 'repositories' ? result.repos : result.days).length > 0)
  console.log(`PASS public GitHub ${section}: ${(result.repos ?? result.days).length} entries`)
}
const token = (await readFile('.local/connection-token.txt', 'utf8')).trim()
const headers = { Authorization: `Bearer ${token}` }
const privateGithub = await fetch(`${base}/v1/me/github?section=notifications`, { headers })
assert.equal(privateGithub.status, 501)
assert.equal(privateGithub.headers.get('Cache-Control'), 'private, no-store')
console.log('PASS unconfigured GitHub token reports disabled without exposing credentials')
const weather = await fetch(`${base}/v1/me/weather?latitude=39.9&longitude=116.4&air=0`, {
  headers,
  signal: AbortSignal.timeout(30000),
})
assert.equal(weather.status, 200)
const reading = await weather.json()
assert.equal(reading.provider, 'open-meteo')
assert.equal(typeof reading.current.temperature_2m, 'number')
console.log('PASS authenticated weather retains Open-Meteo fallback without QWeather keys')
