// Pure formatting and parsing: no `$`, so tests exercise it directly.

const pad = (n: number) => String(n).padStart(2, '0')

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${n < 10_000 ? trim((n / 1000).toFixed(1)) : Math.round(n / 1000)}k`
  return `${trim((n / 1_000_000).toFixed(1))}M`
}

const trim = (s: string) => s.replace(/\.0$/, '')

/** A running duration as a clock: `0:42`, `12:05`, `1:02:09`. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** A span in words-free short form: `8s`, `45m`, `2h10m`, `3d4h`. */
export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h${pad(m % 60)}m`
  const d = Math.floor(h / 24)
  return h % 24 === 0 ? `${d}d` : `${d}d${h % 24}h`
}

export function fmtUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  return n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`
}

/** `claude-opus-5-5[1m]` → `Opus 5.5 1M`; anything unrecognised is shown as given. */
export function fmtModel(id: string): string {
  const big = /\[1m\]/i.test(id) ? ' 1M' : ''
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(id)
  if (!m || m[1] === undefined) return id.replace(/\[[^\]]*\]$/, '') + big
  const family = m[1][0]!.toUpperCase() + m[1].slice(1)
  return `${family} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}${big}`
}

/** `claude-haiku-4-5-20251001` → `haiku`; an alias (`opus`) stays itself. */
export function modelFamily(id: string): string {
  return (/claude-([a-z]+)/i.exec(id)?.[1] ?? id.replace(/\[[^\]]*\]$/, '')).toLowerCase()
}

const COST: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

/** How many agents run on each model family, cheapest first: `haiku 2 · opus 1`. */
export function tierTally(models: string[]): string {
  const counts = new Map<string, number>()
  for (const m of models) counts.set(modelFamily(m), (counts.get(modelFamily(m)) ?? 0) + 1)
  return [...counts]
    .sort(([a], [z]) => (COST[a] ?? 9) - (COST[z] ?? 9) || a.localeCompare(z))
    .map(([f, n]) => `${f} ${n}`)
    .join(' · ')
}

const plainMd = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .trim()

/** A markdown checklist's counts and its last `keep` open items (`- [ ]`), each
 * under the nearest heading above it. Fenced code is skipped, so an example
 * checklist inside a fence is not a task. */
export function parseTodo(md: string, keep: number): { open: number; done: number; items: { section: string; text: string }[] } {
  let section = ''
  let fence = false
  let done = 0
  const items: { section: string; text: string }[] = []
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      section = plainMd(h[1] ?? '')
      continue
    }
    const c = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (!c) continue
    if (c[1] === ' ') items.push({ section, text: plainMd(c[2] ?? '') })
    else done += 1
  }
  return { open: items.length, done, items: items.slice(-keep) }
}

/** A Workflow call's name: a saved workflow's `name`, else the script's
 * `meta.name` (the first `name:` in it, since a script begins with its meta). */
export function workflowName(input: Record<string, unknown>): string | null {
  if (typeof input.name === 'string' && input.name) return input.name
  if (typeof input.script !== 'string') return null
  return /\bname\s*:\s*['"`]([^'"`\n]+)['"`]/.exec(input.script)?.[1] ?? null
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A bar `width` cells wide at `pct`, split so each part can take its own colour. */
export function barParts(pct: number, width: number): { full: string; partial: string; empty: string } {
  const cells = (Math.min(100, Math.max(0, pct)) / 100) * width
  let full = Math.floor(cells)
  let eighth = Math.round((cells - full) * 8)
  if (eighth === 8) {
    full += 1
    eighth = 0
  }
  const partial = EIGHTHS[eighth] ?? ''
  return { full: '█'.repeat(full), partial, empty: ' '.repeat(Math.max(0, width - full - (partial ? 1 : 0))) }
}

export const WARN_AT = 70
export const BAD_AT = 85

export type Level = 'ok' | 'warn' | 'bad' | 'none'

export function level(pct: number | null | undefined): Level {
  if (pct === null || pct === undefined) return 'none'
  return pct >= BAD_AT ? 'bad' : pct >= WARN_AT ? 'warn' : 'ok'
}

export function worst(...levels: Level[]): Level {
  return levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : levels.includes('ok') ? 'ok' : 'none'
}

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The one-line subject of a tool call, as the Activity card lists it. */
export function callLabel(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (tool) {
    case 'Bash':
      return s('command').split('\n')[0]!.trim()
    case 'Read':
    case 'Edit':
    case 'Write':
      return base(s('file_path'))
    case 'NotebookEdit':
      return base(s('notebook_path'))
    case 'Grep':
    case 'Glob':
      return s('pattern')
    case 'WebFetch':
      return host(s('url'))
    case 'WebSearch':
      return s('query')
    case 'Agent':
    case 'Task':
      return s('description') || s('subagent_type')
    case 'Skill':
      return s('skill')
  }
  if (tool.startsWith('mcp__')) return tool.split('__').slice(2).join('__')
  return ''
}

/** `mcp__obscura__browser_click` → `obscura`; built-ins as named. */
export function toolName(tool: string): string {
  return tool.startsWith('mcp__') ? (tool.split('__')[1] ?? 'mcp') : tool
}

export type Porcelain = {
  branch: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  status: Record<string, string>
}

/** `git status --porcelain=v2 --branch`, paths relative to the repository root. */
export function parsePorcelain(out: string): Porcelain {
  const p: Porcelain = { branch: null, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, status: {} }
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      p.branch = line.slice(14)
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        p.ahead = Number(m[1])
        p.behind = Number(m[2])
      }
    } else if (line.startsWith('? ')) {
      p.untracked += 1
      p.status[line.slice(2)] = '?'
    } else if (/^[12u] /.test(line)) {
      const f = line.split(' ')
      const xy = f[1] ?? '..'
      const at = line[0] === '1' ? 8 : line[0] === '2' ? 9 : 10
      const path = f.slice(at).join(' ').split('\t')[0] ?? ''
      if (xy[0] !== '.') p.staged += 1
      if (xy[1] !== '.') p.unstaged += 1
      p.status[path] = xy[0] !== '.' ? xy[0]! : xy[1]!
    }
  }
  return p
}

/** `git diff --numstat`: path → [added, removed]; binary files count as 0. */
export function parseNumstat(out: string): Record<string, [number, number]> {
  const map: Record<string, [number, number]> = {}
  for (const line of out.split('\n')) {
    const [a, r, ...rest] = line.split('\t')
    if (a === undefined || r === undefined || rest.length === 0) continue
    map[rest.join('\t')] = [Number(a) || 0, Number(r) || 0]
  }
  return map
}

/** Shortens `/abs/root/a/b.ts` to `a/b.ts` under `root`, else to `~/…`. */
export function relPath(path: string, root: string | null, home: string | null): string {
  if (root && path.startsWith(root + '/')) return path.slice(root.length + 1)
  if (home && path.startsWith(home + '/')) return '~/' + path.slice(home.length + 1)
  return path
}

/** Short lowercase names for the context breakdown's categories. */
export function categoryName(name: string): string {
  const n = name.toLowerCase()
  if (n.startsWith('message')) return 'msgs'
  if (n.includes('mcp')) return 'mcp'
  if (n.includes('memory')) return 'memory'
  if (n.includes('system prompt')) return 'system'
  if (n.includes('tool')) return 'tools'
  if (n.includes('agent')) return 'agents'
  if (n.includes('skill')) return 'skills'
  if (n.includes('command')) return 'commands'
  return n.split(' ')[0] ?? n
}
