import { cached } from './data'
import type { Env } from './env'

const SECTIONS = [
  'repositories',
  'contributions',
  'tasks',
  'notifications',
  'actions',
  'releases',
  'activity',
]
const name = (v: string) => /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(v)
const repository = (v: string) => /^[a-z\d][a-z\d-]{0,38}\/[\w.-]{1,100}$/i.test(v)
export function githubQuery(query: Record<string, string>) {
  const user = query.user ?? 'zxaBinbina',
    org = query.org ?? 'Youzai-World-Team',
    section = query.section ?? 'repositories'
  const repos = (query.repos ?? '').split(',').filter(Boolean)
  if (
    !name(user) ||
    (org && !name(org)) ||
    !SECTIONS.includes(section) ||
    repos.length > 8 ||
    repos.some((r) => !repository(r))
  )
    return null
  return { user, org, section, repos: [...new Set(repos)] }
}
type Query = NonNullable<ReturnType<typeof githubQuery>>
export class GithubError extends Error {
  constructor(readonly status: number) {
    super('github-unavailable')
  }
}
const safe = (v: unknown) => {
  if (typeof v !== 'string') return ''
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && u.hostname === 'github.com' ? u.href : ''
  } catch {
    return ''
  }
}
const repoOf = (r: any) => ({
  name: r.full_name,
  url: safe(r.html_url),
  description: typeof r.description === 'string' ? r.description.slice(0, 500) : '',
  stars: r.stargazers_count,
  forks: r.forks_count,
  issues: r.open_issues_count,
  private: r.private === true,
})

/** Public graph comes from GitHub's own contribution page; no proxy token or invented commits. */
export async function publicContributions(user: string, signal: AbortSignal) {
  const response = await fetch(`https://github.com/users/${user}/contributions`, {
    headers: { 'User-Agent': 'Myriad' },
    redirect: 'manual',
    signal,
  })
  if (!response.ok) throw new GithubError(response.status)
  const cells = new Map<string, { date: string; count: number | null; level: number }>()
  const tooltips = new Map<string, string>()
  let tooltip = '',
    buffer = ''
  const parsed = new HTMLRewriter()
    .on('[data-date][data-level]', {
      element(e) {
        const date = e.getAttribute('data-date') ?? '',
          id = e.getAttribute('id') ?? date
        if (/^\d{4}-\d{2}-\d{2}$/.test(date))
          cells.set(id, {
            date,
            count: null,
            level: Math.max(0, Math.min(4, Number(e.getAttribute('data-level')) || 0)),
          })
      },
    })
    .on('tool-tip', {
      element(e) {
        tooltip = e.getAttribute('for') ?? ''
        buffer = ''
        e.onEndTag(() => {
          tooltips.set(tooltip, buffer)
        })
      },
      text(t) {
        buffer += t.text
      },
    })
    .transform(response)
  await parsed.text()
  if (!cells.size) throw new GithubError(502)
  for (const [id, cell] of cells) {
    const text = tooltips.get(id) ?? ''
    const count = /([\d,]+) contributions?/i.exec(text)?.[1]
    cell.count = count
      ? Number(count.replaceAll(',', ''))
      : /No contributions/i.test(text) || cell.level === 0
        ? 0
        : null
  }
  return [...cells.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-371)
}
export async function github(env: Env, query: Query, personal: boolean, signal: AbortSignal) {
  if (personal && !env.GITHUB_TOKEN) throw new GithubError(501)
  if (!personal && ['tasks', 'notifications'].includes(query.section)) throw new GithubError(401)
  const token = personal ? env.GITHUB_TOKEN : undefined
  const get = async (path: string, init: RequestInit = {}, missing = false): Promise<any> => {
    signal.throwIfAborted()
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Myriad',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    })
    if (response.status === 404 && missing) return null
    if (!response.ok) throw new GithubError(response.status)
    return response.json()
  }
  const load = async () => {
    const { section, user, org } = query
    const base = { section, personal, at: Date.now() }
    if (section === 'contributions') {
      if (!token) return { ...base, days: await publicContributions(user, signal) }
      const data = await get('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query:
            'query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{weeks{contributionDays{date contributionCount contributionLevel}}}}}}',
          variables: { login: user },
        }),
      })
      const weeks = data?.data?.user?.contributionsCollection?.contributionCalendar?.weeks
      if (!Array.isArray(weeks)) throw new GithubError(502)
      const levels = [
        'NONE',
        'FIRST_QUARTILE',
        'SECOND_QUARTILE',
        'THIRD_QUARTILE',
        'FOURTH_QUARTILE',
      ]
      return {
        ...base,
        days: weeks.flatMap((w: any) =>
          w.contributionDays.map((d: any) => ({
            date: d.date,
            count: d.contributionCount,
            level: Math.max(0, levels.indexOf(d.contributionLevel)),
          })),
        ),
      }
    }
    if (section === 'tasks') {
      const owner = await get('/user')
      if (!name(owner.login)) throw new GithubError(502)
      const results = await Promise.all(
        ['assignee', 'review-requested'].map((filter) =>
          get(
            `/search/issues?q=${encodeURIComponent(`is:open ${filter}:${owner.login}`)}&sort=updated&per_page=20`,
          ),
        ),
      )
      return {
        ...base,
        tasks: results.flatMap((r, i) =>
          (r.items ?? []).map((x: any) => ({
            id: `${i}:${x.id}`,
            title: x.title,
            url: safe(x.html_url),
            kind: x.pull_request ? 'pr' : 'issue',
            reason: i ? 'review' : 'assigned',
            updated: x.updated_at,
          })),
        ),
        more: results.some((r) => r.total_count > 20),
      }
    }
    if (section === 'notifications') {
      const data = await get('/notifications?per_page=30')
      return {
        ...base,
        notifications: data.map((n: any) => {
          const subject =
            typeof n.subject?.url === 'string'
              ? /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)\/(issues|pulls)\/(\d+)$/.exec(
                  n.subject.url,
                )
              : null
          return {
            id: String(n.id),
            title: n.subject?.title ?? '',
            repository: n.repository?.full_name ?? '',
            reason: n.reason,
            url: subject
              ? `https://github.com/${subject[1]}/${subject[2] === 'pulls' ? 'pull' : 'issues'}/${subject[3]}`
              : 'https://github.com/notifications',
            updated: n.updated_at,
          }
        }),
        more: data.length === 30,
      }
    }
    if (section === 'activity') {
      const data = await get(`/users/${user}/received_events${token ? '' : '/public'}?per_page=30`)
      return {
        ...base,
        activity: data.map((e: any) => ({
          id: String(e.id),
          actor: e.actor?.login ?? '',
          kind: e.type,
          repository: e.repo?.name ?? '',
          url: repository(e.repo?.name ?? '')
            ? `https://github.com/${e.repo.name}`
            : `https://github.com/${user}`,
          date: e.created_at,
        })),
        more: data.length === 30,
      }
    }
    const errors: string[] = []
    const [owned, organization] = await Promise.all([
      get(`/users/${user}/repos?sort=updated&per_page=30`),
      org
        ? get(`/orgs/${org}/repos?sort=updated&per_page=30`).catch(() => {
            errors.push(org)
            return []
          })
        : [],
    ])
    const found = [...owned, ...organization]
    const watched = await Promise.all(
      query.repos.map(
        async (r) =>
          found.find((x: any) => x.full_name?.toLowerCase() === r.toLowerCase()) ??
          get(`/repos/${r}`).catch(() => {
            errors.push(r)
            return null
          }),
      ),
    )
    const repos = [
      ...watched.filter(Boolean),
      ...found.filter(
        (r: any) => !query.repos.some((n) => n.toLowerCase() === r.full_name?.toLowerCase()),
      ),
    ].filter((r: any, i: number, all: any[]) => all.findIndex((x) => x.id === r.id) === i)
    if (section === 'repositories')
      return {
        ...base,
        repos: repos.map(repoOf),
        errors,
        more: owned.length === 30 || organization.length === 30,
      }
    const selected = (
      query.repos.length
        ? repos.filter((r) =>
            query.repos.some((n) => n.toLowerCase() === r.full_name?.toLowerCase()),
          )
        : repos
    ).slice(0, 8)
    const items = await Promise.all(
      selected.map(async (r: any) => {
        const data = await get(
          `/repos/${r.full_name}/${section === 'actions' ? 'actions/runs?per_page=3' : 'releases/latest'}`,
          {},
          true,
        ).catch(() => {
          errors.push(r.full_name)
          return null
        })
        return section === 'actions'
          ? (data?.workflow_runs ?? []).map((a: any) => ({
              id: String(a.id),
              repository: r.full_name,
              title: a.display_title || a.name,
              url: safe(a.html_url),
              status: a.conclusion || a.status,
              date: a.updated_at,
            }))
          : data
            ? [
                {
                  id: String(data.id),
                  repository: r.full_name,
                  title: data.name || data.tag_name,
                  url: safe(data.html_url),
                  status: data.tag_name,
                  date: data.published_at,
                },
              ]
            : []
      }),
    )
    return { ...base, [section]: items.flat(), errors }
  }
  // Never put private tasks, notifications or token-assisted repository data into KV/edge cache.
  return personal
    ? load()
    : cached(
        env,
        `github:v1:${JSON.stringify(query)}`,
        query.section === 'contributions' ? 3600 : 300,
        load,
        86400,
      )
}
