import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import { features, type Env } from '../src/env'
import { github, githubQuery, publicContributions } from '../src/github'
import { personalWeather } from '../src/qweather'
import { translate } from '../src/translation'
afterEach(() => vi.restoreAllMocks())
const signal = () => new AbortController().signal
async function call(path: string, bindings: Env = {}, personal = false) {
  const ctx = createExecutionContext()
  const response = await app.request(
    `https://myriad.test/v1${path}`,
    {},
    personal ? { ...bindings, DEV_AUTH_BYPASS: 'true' } : bindings,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return response
}
describe('M3 authenticated adapters', () => {
  it('new private endpoints reject anonymous visitors before touching optional secret APIs', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    for (const path of ['/me/github?section=notifications', '/me/weather?latitude=0&longitude=0']) {
      const response = await call(path, {
        SYNC_TOKEN_SHA256: '0'.repeat(64),
        GITHUB_TOKEN: 'secret',
        QWEATHER_API_KEY: 'secret',
      })
      expect(response.status).toBe(401)
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(features({})).toMatchObject({ github: true, githubPrivate: false, qweather: false })
  })
  it('retains the user commit title, blank line and seven bullet boundaries when AI outputs flat strings', async () => {
    const run = vi.fn(async (_model, input) => ({ translated_text: '译文 ' + input.text }))
    const text =
      'feat: add translation widget and related functionality\n\n' +
      Array.from({ length: 7 }, (_, i) => `- Implemented change ${i}.`).join('\n')
    const result = await translate(
      { AI: { run } as unknown as Ai },
      { text, source: 'en', target: 'zh', provider: 'ai' },
      signal(),
    )
    expect(result.text.split('\n')).toHaveLength(9)
    expect(result.text.split('\n')[1]).toBe('')
    expect(result.text.match(/^- /gm)).toHaveLength(7)
    expect(run).toHaveBeenCalledTimes(8)
  })
  it('uses current QWeather v1 endpoints and isolates alert failures without losing weather', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      expect(url.hostname).toBe('test.qweatherapi.com')
      expect(url.searchParams.get('localTime')).toBe('true')
      expect(new Headers(init?.headers).get('X-QW-Api-Key')).toBe('qweather-secret')
      expect(init?.redirect).toBe('manual')
      if (url.pathname.includes('weatheralert')) return new Response('', { status: 503 })
      if (url.pathname.includes('airquality'))
        return Response.json({ indexes: [{ code: 'us-epa', aqi: 22 }] })
      if (url.pathname.includes('/daily/'))
        return Response.json({
          days: [
            {
              forecastStartTime: '2026-11-14T00:00+08:00',
              temperatureMax: { value: 20 },
              temperatureMin: { value: 10 },
              daytime: { condition: { code: '100' } },
              astro: { sunrise: '2026-11-14T06:00+08:00', sunset: '2026-11-14T18:00+08:00' },
            },
          ],
        })
      if (url.pathname.includes('/hourly/')) return Response.json({ hours: [] })
      return Response.json({
        validTime: '2026-11-14T12:00+08:00',
        temperature: { value: 15 },
        feelsLike: { value: 14 },
        condition: { code: '100', text: '晴' },
      })
    })
    const result = await personalWeather(
      { QWEATHER_HOST: 'test.qweatherapi.com', QWEATHER_API_KEY: 'qweather-secret' },
      39.9,
      116.4,
      true,
      true,
      'zh',
      'auto',
      signal(),
    )
    expect(result).toMatchObject({
      provider: 'qweather',
      current: { temperature_2m: 15, is_day: 1 },
      aqi: 22,
      warningsUnavailable: true,
    })
    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(JSON.stringify(result)).not.toContain('qweather-secret')
  })
  it('falls back to free weather on missing configuration or QWeather errors, never sending keys to fallback hosts', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname.endsWith('qweatherapi.com')) return new Response('', { status: 401 })
      expect(init?.headers).toBeUndefined()
      return Response.json({ current: { temperature_2m: 10 } })
    })
    for (const env of [
      {},
      { QWEATHER_HOST: 'test.qweatherapi.com', QWEATHER_API_KEY: 'secret' },
      { QWEATHER_HOST: 'evil.test', QWEATHER_API_KEY: 'secret' },
    ]) {
      expect(await personalWeather(env, 0, 0, false, true, 'en', 'auto', signal())).toMatchObject({
        provider: 'open-meteo',
        current: { temperature_2m: 10 },
        warningsUnavailable: true,
      })
    }
  })
  it('validates GitHub identifiers and forbids public private-data sections', async () => {
    expect(githubQuery({ user: '../user' })).toBeNull()
    expect(githubQuery({ repos: 'a/b,https://evil.test' })).toBeNull()
    expect(githubQuery({ section: 'secret' })).toBeNull()
    expect((await call('/github?section=tasks', { GITHUB_TOKEN: 'secret' })).status).toBe(401)
    await expect(github({}, githubQuery({})!, true, signal())).rejects.toMatchObject({
      status: 501,
    })
  })
  it('fetches public repositories without Worker credentials and prioritizes watched repositories', async () => {
    const repo = (name: string, id: number) => ({
      id,
      full_name: name,
      html_url: `https://github.com/${name}`,
      stargazers_count: 3,
      forks_count: 2,
      open_issues_count: 1,
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
      const path = new URL(String(input)).pathname
      return Response.json(
        path.includes('/orgs/') ? [repo('team/first', 2)] : [repo('user/second', 1)],
      )
    })
    const result = (await github(
      { GITHUB_TOKEN: 'never-public' },
      githubQuery({ user: 'user', org: 'team', repos: 'team/first' })!,
      false,
      signal(),
    )) as any
    expect(result.repos.map((r: any) => r.name)).toEqual(['team/first', 'user/second'])
  })
  it('uses the token owner for assigned tasks and safely maps notification links', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret')
      const url = new URL(String(input))
      if (url.pathname === '/user') return Response.json({ login: 'owner' })
      if (url.pathname === '/search/issues') {
        expect(url.searchParams.get('q')).toContain(':owner')
        return Response.json({
          items: [{ id: 1, title: 'Fix', html_url: 'https://github.com/owner/repo/issues/1' }],
          total_count: 1,
        })
      }
      return Response.json([
        {
          id: '1',
          subject: { title: 'PR', url: 'https://api.github.com/repos/owner/repo/pulls/3' },
          repository: { full_name: 'owner/repo' },
        },
      ])
    })
    const tasks = (await github(
      { GITHUB_TOKEN: 'secret' },
      githubQuery({ section: 'tasks', user: 'other' })!,
      true,
      signal(),
    )) as any
    expect(tasks.tasks.map((t: any) => t.reason)).toEqual(['assigned', 'review'])
    const notifications = (await github(
      { GITHUB_TOKEN: 'secret' },
      githubQuery({ section: 'notifications' })!,
      true,
      signal(),
    )) as any
    expect(notifications.notifications[0].url).toBe('https://github.com/owner/repo/pull/3')
  })
  it('extracts official public contribution counts and represents unknown counts honestly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<table><td id="d1" data-date="2026-11-14" data-level="4"></td><td id="d2" data-date="2026-11-15" data-level="2"></td></table><tool-tip for="d1">1,234 contributions on November 14.</tool-tip>',
      ),
    )
    expect(await publicContributions('user', signal())).toEqual([
      { date: '2026-11-14', level: 4, count: 1234 },
      { date: '2026-11-15', level: 2, count: null },
    ])
  })
  it('cancels before launching an upstream request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'),
      ctrl = new AbortController()
    ctrl.abort()
    await expect(
      github({ GITHUB_TOKEN: 'secret' }, githubQuery({})!, true, ctrl.signal),
    ).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects redirects without following them or sending private credentials elsewhere', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(init?.redirect).toBe('manual')
      return new Response('', { status: 302, headers: { Location: 'https://evil.test' } })
    })
    await expect(
      github({ GITHUB_TOKEN: 'secret' }, githubQuery({ org: '' })!, true, signal()),
    ).rejects.toMatchObject({ status: 302 })
    await expect(publicContributions('user', signal())).rejects.toMatchObject({ status: 302 })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('maps authenticated GraphQL contribution levels without inventing counts', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://api.github.com/graphql')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret')
      expect(JSON.parse(String(init?.body)).variables.login).toBe('user')
      return Response.json({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: {
                weeks: [
                  {
                    contributionDays: [
                      {
                        date: '2026-11-15',
                        contributionCount: 12,
                        contributionLevel: 'THIRD_QUARTILE',
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      })
    })
    const result = (await github(
      { GITHUB_TOKEN: 'secret' },
      githubQuery({ user: 'user', section: 'contributions' })!,
      true,
      signal(),
    )) as any
    expect(result.days).toEqual([{ date: '2026-11-15', count: 12, level: 3 }])
  })
  it('limits Actions and Releases to watched repositories and distinguishes missing releases from errors', async () => {
    const requested: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname
      requested.push(path)
      if (path === '/users/user/repos')
        return Response.json(
          ['watched', 'other'].map((r, id) => ({
            id,
            full_name: `user/${r}`,
            html_url: `https://github.com/user/${r}`,
          })),
        )
      if (path.endsWith('/actions/runs'))
        return Response.json({
          workflow_runs: [
            { id: 1, display_title: 'CI', html_url: 'javascript:bad', conclusion: 'success' },
          ],
        })
      return new Response('', { status: 404 })
    })
    const query = githubQuery({ user: 'user', org: '', repos: 'user/watched', section: 'actions' })!
    const actions = (await github({}, query, false, signal())) as any
    expect(actions.actions).toMatchObject([
      { repository: 'user/watched', title: 'CI', status: 'success', url: '' },
    ])
    expect(requested).not.toContain('/repos/user/other/actions/runs')
    const releases = (await github({}, { ...query, section: 'releases' }, false, signal())) as any
    expect(releases.releases).toEqual([])
    expect(releases.errors).toEqual([])
  })
  it('uses public activity routes without a token and returns partial repository results on organization failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
      const path = new URL(String(input)).pathname
      if (path.includes('received_events/public'))
        return Response.json([
          { id: 1, type: 'WatchEvent', actor: { login: 'friend' }, repo: { name: 'user/repo' } },
        ])
      if (path.startsWith('/orgs')) return new Response('', { status: 503 })
      return Response.json([
        { id: 1, full_name: 'user/repo', html_url: 'https://github.com/user/repo' },
      ])
    })
    const activity = (await github(
      { GITHUB_TOKEN: 'private' },
      githubQuery({ user: 'user', section: 'activity' })!,
      false,
      signal(),
    )) as any
    expect(activity.activity[0]).toMatchObject({
      actor: 'friend',
      kind: 'WatchEvent',
      url: 'https://github.com/user/repo',
    })
    const repos = (await github(
      {},
      githubQuery({ user: 'user', org: 'team' })!,
      false,
      signal(),
    )) as any
    expect(repos.repos).toHaveLength(1)
    expect(repos.errors).toEqual(['team'])
  })
  it('marks every authenticated GitHub response no-store, including unconfigured credentials', async () => {
    const ctx = createExecutionContext()
    const response = await app.request(
      'http://localhost/v1/me/github?section=notifications',
      {},
      { DEV_AUTH_BYPASS: 'true' },
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(501)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
