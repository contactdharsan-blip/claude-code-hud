// The drawings: the band above the prompt, the inspector pane's cards and the
// prompt bubble. Pure functions of the data, so a test mounts them directly.

import type { Elements, RenderElement } from 'claude-code'

import type { HudAgent, HudBreakdown, HudCall, HudFlow, HudGit, HudLive, HudPrefs, HudTask, HudTodo, HudUsage } from '../types'
import {
  barParts,
  fmtClock,
  fmtModel,
  fmtSpan,
  fmtTokens,
  fmtUsd,
  level,
  modelFamily,
  relPath,
  tierTally,
  toolName,
  worst,
  type Level,
} from './format'
import { parseBlocks, wrapRuns, type Block, type Inline } from './notion'
import { GLYPH, INK, STATUS_GLYPH, keylineFor, levelInk } from './theme'

type UI = Pick<Elements['terminal'], 'Box' | 'Text'>
type DocUI = Pick<Elements['terminal'], 'Box' | 'Text' | 'Code' | 'Markdown'>

export type HudData = {
  usage: HudUsage
  breakdown: HudBreakdown
  git: HudGit
  calls: HudCall[]
  tasks: HudTask[]
  agents: HudAgent[]
  flows: HudFlow[]
  files: string[]
  todo: HudTodo
  live: HudLive
  prefs: HudPrefs
  home: string | null
}

/** One run of styled text; segments and rows are lists of these. */
type Part = { t: string; color?: string; bg?: string; bold?: boolean; dim?: boolean; strike?: boolean }

const width = (parts: Part[]) => parts.reduce((n, p) => n + p.t.length, 0)

function spans(ui: UI, parts: Part[], wrap?: 'truncate-end' | 'truncate-start'): RenderElement {
  const { Text } = ui
  return (
    <Text wrap={wrap ?? 'truncate-end'}>
      {parts.map(p => (
        <Text color={p.color} backgroundColor={p.bg} bold={p.bold} dimColor={p.dim} strikethrough={p.strike}>
          {p.t}
        </Text>
      ))}
    </Text>
  )
}

function bar(pct: number, cells: number, ink: string): Part[] {
  const { full, partial, empty } = barParts(pct, cells)
  const parts: Part[] = [{ t: full, color: ink }]
  if (partial) parts.push({ t: partial, color: ink, bg: INK.track })
  if (empty) parts.push({ t: empty, bg: INK.track })
  return parts
}

const pctParts = (pct: number, l: Level): Part[] => [{ t: `${Math.round(pct)}%`, bold: true, color: levelInk(l) }]

const limitLabel = (kind: string) => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'spend' : kind)

const resetIn = (iso: string | null, now: number) => (iso ? fmtSpan(Date.parse(iso) - now) : null)

const nowOf = (live: HudLive) => live.now || Date.now()

/** The context reading: the last response's figure, or before the first reply
 * the local /context estimate, marked `~` so it never passes for a measurement. */
function ctxReading(d: HudData): { pct: number; tokens: number; window: number; approx: boolean } | null {
  const u = d.usage
  if (u.ctxPercent !== null && u.ctxTokens !== null) return { pct: u.ctxPercent, tokens: u.ctxTokens, window: u.ctxWindow, approx: false }
  const b = d.breakdown
  if (b && b.max > 0) return { pct: (b.total / b.max) * 100, tokens: b.total, window: b.max, approx: true }
  return null
}

// ─── Band ────────────────────────────────────────────────────────────────────

type Seg = { pri: number; side: 'left' | 'right'; order: number; parts: Part[] }

export function bandMode(prefs: HudPrefs, columns: number): 'slim' | 'full' | 'compact' | 'minimal' | 'off' {
  if (prefs.band !== 'auto') return prefs.band
  return columns >= 70 ? 'slim' : 'minimal'
}

export function band(ui: UI, d: HudData, columns: number): RenderElement | null {
  const mode = bandMode(d.prefs, columns)
  if (mode === 'off') return null
  const { Box, Text } = ui
  const now = nowOf(d.live)
  const segs: Seg[] = []
  // slim is one filled row: bars as wide as full when there is room
  const wide = mode === 'full' || (mode === 'slim' && columns >= 110)
  const ctxBar = wide ? 10 : mode === 'compact' || mode === 'slim' ? 6 : 0

  // context: kept to the very last as the band narrows
  const ctx = ctxReading(d)
  const ctxL = level(ctx?.pct)
  segs.push({
    pri: 1,
    side: 'left',
    order: 2,
    parts: !ctx
      ? [{ t: 'ctx ', dim: true }, { t: '—', dim: true }]
      : [
          { t: 'ctx ', dim: true },
          ...(ctxBar ? [...bar(ctx.pct, ctxBar, levelInk(ctxL) ?? INK.running), { t: ' ' }] : []),
          ...(ctx.approx ? [{ t: '~', dim: true }] : []),
          ...pctParts(ctx.pct, ctxL),
        ],
  })

  for (const lim of d.usage.limits) {
    const l = level(lim.percentUsed)
    const isFive = lim.kind === 'five_hour'
    const reset = resetIn(lim.resetsAt, now)
    const showReset = mode !== 'minimal' && reset !== null && (isFive || l !== 'ok')
    segs.push({
      pri: isFive ? 2 : 6,
      side: 'left',
      order: isFive ? 3 : 4,
      parts: [
        { t: `${limitLabel(lim.kind)} `, dim: true },
        ...(isFive && wide ? [...bar(lim.percentUsed, 6, levelInk(l) ?? INK.running), { t: ' ' }] : []),
        ...pctParts(lim.percentUsed, l),
        ...(showReset ? [{ t: ` ${GLYPH.reset}${reset}`, dim: true }] : []),
      ],
    })
  }

  if (d.live.isWorking && d.live.turnStartedAt !== null) {
    segs.push({
      pri: 3,
      side: 'right',
      order: 9,
      parts: [
        { t: `${GLYPH.running} `, color: INK.running },
        { t: fmtClock(now - d.live.turnStartedAt), bold: true },
        ...(mode !== 'minimal' && d.live.toolsThisTurn > 0
          ? [{ t: ` ${GLYPH.sep} ${d.live.toolsThisTurn} tool${d.live.toolsThisTurn === 1 ? '' : 's'}`, dim: true }]
          : []),
      ],
    })
  }

  if (d.git?.branch) {
    const g = d.git
    const dirty = g.staged + g.unstaged + g.untracked
    segs.push({
      pri: 4,
      side: 'right',
      order: 8,
      parts: [
        { t: `${GLYPH.branch} `, dim: true },
        { t: g.branch ?? '' },
        ...(g.ahead ? [{ t: ` ${GLYPH.ahead}${g.ahead}`, dim: true }] : []),
        ...(g.behind ? [{ t: ` ${GLYPH.behind}${g.behind}`, color: INK.warn }] : []),
        ...(dirty ? [{ t: ` ${GLYPH.dirty}${dirty}`, dim: true }] : []),
      ],
    })
  }

  if (d.usage.usd !== null) segs.push({ pri: 5, side: 'left', order: 5, parts: [{ t: fmtUsd(d.usage.usd) }] })

  if (d.usage.model) {
    segs.push({
      pri: 7,
      side: 'left',
      order: 1,
      parts: [{ t: `${GLYPH.model} `, color: INK.accent }, { t: fmtModel(d.usage.model), bold: true }],
    })
  }

  // agents at work (a workflow's too), by the model each one actually runs on
  const running = [
    ...d.agents.filter(a => a.endedAt === null).map(a => a.spawn?.model ?? null),
    ...d.flows.flatMap(f => f.agents.filter(a => a.endedAt === null).map(a => a.model)),
  ]
  if (running.length) {
    const tally = tierTally(running.filter((m): m is string => m !== null))
    segs.push({
      pri: 5.5,
      side: 'right',
      order: 7,
      parts: [
        { t: `${GLYPH.sub} `, color: INK.running },
        { t: `${running.length} agent${running.length === 1 ? '' : 's'}` },
        ...(mode !== 'minimal' && tally ? [{ t: ` ${tally}`, dim: true }] : []),
      ],
    })
  }

  const gap = 3
  const room = columns - (mode === 'minimal' ? 0 : mode === 'slim' ? 2 : 4)
  const fits = (kept: Seg[]) => {
    const side = (s: 'left' | 'right') => kept.filter(k => k.side === s)
    const sum = (list: Seg[]) => (list.length ? list.reduce((n, k) => n + width(k.parts), 0) + gap * (list.length - 1) : 0)
    const l = side('left')
    const r = side('right')
    return sum(l) + sum(r) + (l.length && r.length ? gap : 0) <= room
  }
  let kept = [...segs].sort((a, z) => a.pri - z.pri)
  while (kept.length > 1 && !fits(kept)) kept = kept.slice(0, -1)

  const group = (side: 'left' | 'right') => {
    const list = kept.filter(k => k.side === side).sort((a, z) => a.order - z.order)
    const out: RenderElement[] = []
    list.forEach((k, i) => {
      if (i > 0) out.push(<Text dimColor>{mode === 'minimal' ? ` ${GLYPH.sep} ` : ' '.repeat(gap)}</Text>)
      out.push(spans(ui, k.parts))
    })
    return out
  }

  const keyline = keylineFor(worst(ctxL, ...d.usage.limits.map(l => level(l.percentUsed))))

  if (mode === 'slim') {
    return (
      <Box flexDirection="row" justifyContent="space-between" backgroundColor={INK.card} paddingX={1}>
        <Box flexDirection="row">{group('left')}</Box>
        <Box flexDirection="row">{group('right')}</Box>
      </Box>
    )
  }
  if (mode === 'minimal') {
    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">{group('left')}</Box>
        <Box flexDirection="row">{group('right')}</Box>
      </Box>
    )
  }
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      borderStyle="round"
      borderColor={keyline}
      backgroundColor={INK.card}
      paddingX={1}
    >
      <Box flexDirection="row">{group('left')}</Box>
      <Box flexDirection="row">{group('right')}</Box>
    </Box>
  )
}

/** The prompt hint's tail when the band is off: the two numbers worth keeping. */
export function hintTail(d: HudData): string | undefined {
  const parts: string[] = []
  const ctx = ctxReading(d)
  if (ctx) parts.push(`ctx ${ctx.approx ? '~' : ''}${Math.round(ctx.pct)}%`)
  const five = d.usage.limits.find(l => l.kind === 'five_hour')
  if (five) parts.push(`5h ${Math.round(five.percentUsed)}%`)
  return parts.length ? parts.join(` ${GLYPH.sep} `) : undefined
}

// ─── Pane ────────────────────────────────────────────────────────────────────

function row(ui: UI, left: RenderElement, right?: RenderElement | null): RenderElement {
  const { Box } = ui
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexGrow={1} flexShrink={1}>
        {left}
      </Box>
      {right ? (
        <Box flexShrink={0} marginLeft={1}>
          {right}
        </Box>
      ) : null}
    </Box>
  )
}

/** A rounded card drawn frame and all, so its title and meta sit on the top
 * border (`╭─ Title ───── meta ─╮`) and no row is spent on a header. Every body
 * element is one row (pane rows truncate), which is what makes the sides exact. */
function card(ui: UI, width: number, title: string, meta: string | null, keyline: string, body: RenderElement[]): RenderElement {
  const { Box, Text } = ui
  const inner = Math.max(8, width - 2)
  let head = ` ${title} `
  let tail = meta ? ` ${meta} ` : ''
  if (4 + head.length + tail.length > width) tail = ''
  if (4 + head.length > width) head = head.slice(0, Math.max(0, width - 5)) + '…'
  const run = Math.max(0, width - 4 - head.length - tail.length)
  const frame = (t: string) => (
    <Text color={keyline} backgroundColor={INK.card}>
      {t}
    </Text>
  )
  return (
    <Box flexDirection="column" width={width}>
      <Text>
        {frame('╭─')}
        <Text bold backgroundColor={INK.card}>
          {head}
        </Text>
        {frame('─'.repeat(run))}
        {tail ? (
          <Text dimColor backgroundColor={INK.card}>
            {tail}
          </Text>
        ) : null}
        {frame('─╮')}
      </Text>
      {body.map(r => (
        <Box flexDirection="row">
          {frame('│')}
          <Box width={inner} paddingX={1} backgroundColor={INK.card}>
            {r}
          </Box>
          {frame('│')}
        </Box>
      ))}
      {frame(`╰${'─'.repeat(inner)}╯`)}
    </Box>
  )
}

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

function sessionCard(ui: UI, d: HudData, width: number): RenderElement {
  const now = nowOf(d.live)
  const g = d.git
  const meta = d.usage.startedAt
    ? `${fmtSpan(now - d.usage.startedAt)} ${GLYPH.sep} ${d.usage.turns} turn${d.usage.turns === 1 ? '' : 's'}`
    : null
  const body: RenderElement[] = []
  body.push(
    row(
      ui,
      spans(ui, [{ t: g ? base(g.root) : 'no repository', bold: !!g, dim: !g }]),
      g?.branch
        ? spans(ui, [
            { t: `${GLYPH.branch} `, dim: true },
            { t: g.branch },
            { t: ` ${GLYPH.ahead}${g.ahead} ${GLYPH.behind}${g.behind}`, dim: true },
          ])
        : null,
    ),
  )
  if (d.usage.model) {
    body.push(row(ui, spans(ui, [{ t: fmtModel(d.usage.model) }]), spans(ui, [{ t: `${d.calls.length} tool calls`, dim: true }])))
  }
  if (g) {
    const changed = g.unstaged + g.untracked
    body.push(
      row(
        ui,
        spans(ui, changed || g.staged ? [{ t: `${changed} changed`, color: changed ? INK.warn : undefined }] : [{ t: 'clean', color: INK.ok }]),
        g.staged ? spans(ui, [{ t: `${g.staged} staged`, dim: true }]) : null,
      ),
    )
  }
  return card(ui, width, 'Session', meta, INK.keyline, body)
}

function contextCard(ui: UI, d: HudData, inner: number): RenderElement {
  const ctx = ctxReading(d)
  const l = level(ctx?.pct)
  const meta = ctx ? `${ctx.approx ? '~' : ''}${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}` : null
  const body: RenderElement[] = []
  if (!ctx) {
    body.push(spans(ui, [{ t: 'measured after the first reply', dim: true }]))
  } else {
    body.push(
      row(
        ui,
        spans(ui, bar(ctx.pct, Math.max(6, inner - 7), levelInk(l) ?? INK.running)),
        spans(ui, [...(ctx.approx ? [{ t: '~', dim: true }] : []), ...pctParts(ctx.pct, l)]),
      ),
    )
    if (ctx.approx) body.push(spans(ui, [{ t: 'estimated until the first reply', dim: true }]))
  }
  const b = d.breakdown
  if (b && b.top.length) {
    const parts: Part[] = []
    b.top.forEach((c, i) => {
      if (i > 0) parts.push({ t: '  ' })
      parts.push({ t: `${c.name} `, dim: true }, { t: fmtTokens(c.tokens) })
    })
    body.push(spans(ui, parts))
  }
  if (b) {
    body.push(
      row(
        ui,
        spans(ui, [{ t: 'autocompact', dim: true }]),
        spans(ui, [{ t: b.autoCompactAt && b.max ? `at ${Math.round((b.autoCompactAt / b.max) * 100)}%` : 'off', dim: true }]),
      ),
    )
  }
  return card(ui, inner + 4, 'Context', meta, keylineFor(l), body)
}

function usageCard(ui: UI, d: HudData, inner: number): RenderElement | null {
  const u = d.usage
  if (!u.limits.length && u.usd === null) return null
  const now = nowOf(d.live)
  const cells = inner >= 34 ? 10 : 6
  const body: RenderElement[] = u.limits.map(lim => {
    const l = level(lim.percentUsed)
    const reset = resetIn(lim.resetsAt, now)
    return row(
      ui,
      spans(ui, [
        { t: `${limitLabel(lim.kind).padEnd(3)}`, dim: true },
        ...bar(lim.percentUsed, cells, levelInk(l) ?? INK.running),
        { t: ' ' },
        ...pctParts(lim.percentUsed, l),
      ]),
      reset ? spans(ui, [{ t: `${GLYPH.reset} ${reset}`, dim: true }]) : null,
    )
  })
  if (u.usd !== null) {
    body.push(row(ui, spans(ui, [{ t: 'session cost', dim: true }]), spans(ui, [{ t: fmtUsd(u.usd), bold: true }])))
  }
  return card(ui, inner + 4, 'Usage', null, keylineFor(worst(...u.limits.map(x => level(x.percentUsed)))), body)
}

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch'])

type Grouped = { call: HudCall; count: number }

/** Folds a run of the same read-only tool, all succeeded, into one row (`×3`). */
function group(calls: HudCall[]): Grouped[] {
  const out: Grouped[] = []
  for (const c of [...calls].reverse()) {
    const last = out[out.length - 1]
    if (last && last.call.tool === c.tool && READ_ONLY.has(c.tool) && last.call.status === 'ok' && c.status === 'ok') {
      last.count += 1
    } else {
      out.push({ call: c, count: 1 })
    }
  }
  return out
}

function activityCard(ui: UI, d: HudData, rows: number, width: number): RenderElement | null {
  if (!d.calls.length) return null
  const now = nowOf(d.live)
  const body = group(d.calls)
    .slice(0, rows)
    .map(({ call, count }) => {
      const s = STATUS_GLYPH[call.status]
      const label = call.label + (count > 1 ? ` ×${count}` : '')
      const time =
        call.status === 'running'
          ? spans(ui, [{ t: fmtClock(now - call.startedAt), color: INK.running }])
          : call.endedAt !== null && call.endedAt - call.startedAt >= 1000
            ? spans(ui, [{ t: fmtSpan(call.endedAt - call.startedAt), dim: true }])
            : null
      return row(
        ui,
        spans(ui, [
          { t: `${s.glyph} `, color: s.ink },
          ...(call.isSubagent ? [{ t: `${GLYPH.sub} `, dim: true }] : []),
          { t: toolName(call.tool).padEnd(5), bold: true },
          { t: label ? ` ${label}` : '' },
        ]),
        time,
      )
    })
  const meta = d.live.isWorking ? `${d.live.toolsThisTurn} this turn` : `${d.calls.length} calls`
  return card(ui, width, 'Activity', meta, d.live.isWorking ? INK.running : INK.keyline, body)
}

function tasksCard(ui: UI, d: HudData, rows: number, width: number): RenderElement | null {
  if (!d.tasks.length) return null
  const done = d.tasks.filter(t => t.status === 'completed').length
  const open = d.tasks.filter(t => t.status !== 'completed')
  const shown = [...d.tasks.filter(t => t.status === 'completed').slice(-Math.max(0, rows - open.length)), ...open].slice(0, rows)
  const body = shown.map(t =>
    spans(ui, [
      t.status === 'completed'
        ? { t: `${GLYPH.ok} `, color: INK.ok }
        : t.status === 'in_progress'
          ? { t: `${GLYPH.running} `, color: INK.running }
          : { t: `${GLYPH.pending} `, dim: true },
      { t: t.text, dim: t.status === 'completed', strike: t.status === 'completed', bold: t.status === 'in_progress' },
    ]),
  )
  return card(ui, width, 'Tasks', `${done} / ${d.tasks.length}`, INK.keyline, body)
}

// A finished run stays on show this long, then the card steps aside.
const FLOW_LINGER_MS = 15 * 60_000

/** The latest workflow run: its agents, running first, by the model each runs on. */
function workflowCard(ui: UI, d: HudData, rows: number, width: number): RenderElement | null {
  const run = d.flows.at(-1)
  if (!run?.agents.length) return null
  const now = nowOf(d.live)
  const active = run.agents.filter(a => a.endedAt === null)
  const ended = run.agents.filter(a => a.endedAt !== null)
  const lastEnd = Math.max(...ended.map(a => a.endedAt ?? 0))
  if (!active.length && now - lastEnd > FLOW_LINGER_MS) return null
  const shown = [...active, ...ended.slice(-Math.max(0, rows - active.length))].slice(0, rows)
  const body = [
    spans(ui, [{ t: run.name ?? run.runId, dim: true }]),
    ...shown.map(a =>
      row(
        ui,
        spans(ui, [
          a.endedAt === null
            ? { t: `${GLYPH.running} `, color: INK.running }
            : a.failed
              ? { t: `${GLYPH.error} `, color: INK.bad }
              : { t: `${GLYPH.ok} `, color: INK.ok },
          { t: a.type, bold: true },
          { t: ` ${modelFamily(a.model)}`, dim: true },
          { t: ` ${a.description}`, dim: a.endedAt !== null },
        ]),
        a.endedAt === null
          ? spans(ui, [{ t: fmtClock(now - a.startedAt), color: INK.running }])
          : spans(ui, [{ t: fmtSpan(a.endedAt - a.startedAt), dim: true }]),
      ),
    ),
    ...(run.agents.length > shown.length ? [spans(ui, [{ t: `+${run.agents.length - shown.length} more`, dim: true }])] : []),
  ]
  return card(ui, width, 'Workflow', `${ended.length} / ${run.agents.length}`, active.length ? INK.running : INK.keyline, body)
}

/** The project's `tasks/todo.md`: its last open items, under their headings. */
function todoCard(ui: UI, d: HudData, width: number): RenderElement | null {
  const t = d.todo
  if (!t?.items.length) return null
  const body: RenderElement[] = []
  let section: string | null = null
  for (const item of t.items) {
    if (item.section !== section) {
      section = item.section
      if (section) body.push(spans(ui, [{ t: section, dim: true }]))
    }
    body.push(spans(ui, [{ t: `${GLYPH.pending} `, dim: true }, { t: item.text }]))
  }
  return card(ui, width, 'Todo', `${t.open} open`, INK.keyline, body)
}

const AGENT_GLYPH: Record<string, Part> = {
  running: { t: `${GLYPH.running} `, color: INK.running },
  pending: { t: `${GLYPH.pending} `, color: INK.running },
  waiting: { t: `${GLYPH.pending} `, color: INK.warn },
  idle: { t: `${GLYPH.pending} `, dim: true },
  completed: { t: `${GLYPH.ok} `, color: INK.ok },
  failed: { t: `${GLYPH.error} `, color: INK.bad },
  killed: { t: `${GLYPH.denied} `, color: INK.warn },
}

function agentsCard(ui: UI, d: HudData, width: number): RenderElement | null {
  const active = d.agents.filter(a => a.endedAt === null)
  const ended = d.agents.filter(a => a.endedAt !== null).slice(-3)
  if (!active.length && !ended.length) return null
  const now = nowOf(d.live)
  const body = [...active, ...ended].map(a =>
    row(
      ui,
      spans(ui, [
        AGENT_GLYPH[a.status] ?? { t: `${GLYPH.pending} `, dim: true },
        { t: a.type, bold: true },
        // what it runs on, and whether in a worktree of its own
        ...(a.spawn ? [{ t: ` ${modelFamily(a.spawn.model)}`, dim: true }] : []),
        ...(a.spawn?.worktree ? [{ t: ` ${GLYPH.branch}`, dim: true }] : []),
        { t: ` ${a.description}`, dim: a.endedAt !== null },
      ]),
      a.endedAt === null
        ? spans(ui, [{ t: fmtClock(now - a.firstSeen), color: INK.running }])
        : spans(ui, [{ t: fmtSpan(a.endedAt - a.firstSeen), dim: true }]),
    ),
  )
  return card(ui, width, 'Agents', active.length ? `${active.length} running` : `${ended.length} done`, active.length ? INK.running : INK.keyline, body)
}

const FILE_MARK: Record<string, Part> = {
  M: { t: 'M ', color: INK.warn },
  A: { t: 'A ', color: INK.ok },
  '?': { t: 'A ', color: INK.ok },
  D: { t: 'D ', color: INK.bad },
  R: { t: 'R ', color: INK.warn },
}

function filesCard(ui: UI, d: HudData, rows: number, width: number): RenderElement | null {
  if (!d.files.length) return null
  const g = d.git
  const body = [...d.files]
    .reverse()
    .slice(0, rows)
    .map(path => {
      const rel = relPath(path, g?.root ?? null, d.home)
      const mark = FILE_MARK[g?.status[rel] ?? ''] ?? { t: `${GLYPH.sep} `, dim: true }
      const n = g?.numstat[rel]
      return row(
        ui,
        spans(ui, [mark, { t: rel }], 'truncate-start'),
        n && (n[0] || n[1])
          ? spans(ui, [
              ...(n[0] ? [{ t: `+${n[0]}`, color: INK.added }] : []),
              ...(n[0] && n[1] ? [{ t: ' ' }] : []),
              ...(n[1] ? [{ t: `−${n[1]}`, color: INK.removed }] : []),
            ])
          : null,
      )
    })
  return card(ui, width, 'Files', String(d.files.length), INK.keyline, body)
}

export function pane(ui: UI, d: HudData, columns: number): RenderElement {
  const { Box } = ui
  const inner = Math.max(12, columns - 4)
  const cards = [
    sessionCard(ui, d, columns),
    contextCard(ui, d, inner),
    usageCard(ui, d, inner),
    activityCard(ui, d, 8, columns),
    tasksCard(ui, d, 8, columns),
    todoCard(ui, d, columns),
    agentsCard(ui, d, columns),
    workflowCard(ui, d, 8, columns),
    filesCard(ui, d, 6, columns),
  ].filter((c): c is RenderElement => c !== null)
  return <Box flexDirection="column">{cards}</Box>
}

// ─── Bubble ──────────────────────────────────────────────────────────────────

export function bubble(ui: UI, text: string): RenderElement {
  const { Box, Text } = ui
  return (
    <Box borderStyle="round" borderColor={INK.keyline} backgroundColor={INK.bubble} paddingX={1}>
      <Text>{text}</Text>
    </Box>
  )
}

// ─── Notion-style reply ──────────────────────────────────────────────────────
// Claude's reply as a Notion page: no markdown punctuation left on screen,
// hanging indents, • ◦ ▪ bullets, ☐ ☑ to-dos, a grey bar for quotes, filled
// callouts for GitHub alerts and emoji-led quotes, inline code as a pill.
// Code fences and tables go to the engine's own Code and Markdown elements,
// which highlight and align better than a re-draw would.

const CODE_MAX = 10_000

function inlineRuns(ui: DocUI, inl: Inline[], base: { dim?: boolean; bold?: boolean; color?: string } = {}): RenderElement[] {
  const { Text } = ui
  return inl.map(r => (
    <Text
      bold={r.bold || base.bold}
      italic={r.italic}
      strikethrough={r.strike}
      underline={r.href !== undefined}
      dimColor={base.dim}
      color={r.code ? INK.code : r.href !== undefined ? INK.link : base.color}
      backgroundColor={r.code ? INK.codeBg : undefined}
    >
      {r.code ? ` ${r.t} ` : r.t}
    </Text>
  ))
}

function textLine(ui: DocUI, inl: Inline[], base: { dim?: boolean; bold?: boolean; color?: string } = {}): RenderElement {
  const { Text } = ui
  return <Text wrap="wrap">{inlineRuns(ui, inl, base)}</Text>
}

function drawBlock(ui: DocUI, b: Block, prose: number, full: number): RenderElement {
  const { Box, Text, Code, Markdown } = ui
  switch (b.k) {
    case 'heading':
      return (
        <Box width={prose}>
          {textLine(ui, b.inl, { bold: true, color: b.level >= 3 ? INK.quoteBar : undefined })}
        </Box>
      )
    case 'para':
      return <Box flexDirection="column" width={prose}>{b.lines.map(l => textLine(ui, l))}</Box>
    case 'item': {
      const marker = b.task === 'done' ? '☑' : b.task === 'open' ? '☐' : b.marker
      const gutter = Math.max(2, marker.length + 1)
      return (
        <Box flexDirection="row" marginLeft={b.depth * 2} width={Math.max(10, prose - b.depth * 2)}>
          <Box width={gutter} flexShrink={0}>
            <Text color={b.task === 'done' ? INK.done : undefined} dimColor={b.task === 'open'}>
              {marker}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            {b.task === 'done'
              ? textLine(ui, b.inl.map(r => ({ ...r, strike: true })), { dim: true })
              : textLine(ui, b.inl)}
          </Box>
        </Box>
      )
    }
    case 'quote':
      return (
        <Box flexDirection="column" width={prose}>
          {b.lines.flatMap(l =>
            wrapRuns(l, prose - 2).map(row => (
              <Box flexDirection="row">
                <Box width={2} flexShrink={0}>
                  <Text color={INK.quoteBar}>▎</Text>
                </Box>
                <Text>{inlineRuns(ui, row)}</Text>
              </Box>
            )),
          )}
        </Box>
      )
    case 'callout':
      return (
        <Box flexDirection="row" width={prose} backgroundColor={INK.calloutBg} paddingX={1}>
          <Box width={3} flexShrink={0}>
            <Text>{b.icon}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            {b.title ? <Text bold>{b.title}</Text> : null}
            {b.lines.map(l => textLine(ui, l))}
          </Box>
        </Box>
      )
    case 'code': {
      const source = b.source || ' '
      const indent = Math.min(8, b.indent)
      return (
        <Box flexDirection="column" marginLeft={indent} width={Math.max(20, full - indent)} backgroundColor={INK.calloutBg} paddingX={1}>
          {b.lang ? <Text dimColor>{b.lang}</Text> : null}
          <Code source={source} language={b.lang || undefined} />
        </Box>
      )
    }
    case 'table':
      return <Markdown text={b.md} />
    case 'rule':
      return <Text color={INK.rule}>{'─'.repeat(Math.max(4, prose))}</Text>
  }
}

/** Space between blocks, Notion-tight: a heading gets air above and none
 * below, a list hugs the text that introduces it, the rest gets one row. */
function gapBefore(b: Block, prev: Block | undefined): number {
  if (!prev) return 0
  if (b.k === 'heading') return 1
  if (prev.k === 'heading') return 0
  if (b.k === 'item' && (prev.k === 'item' || prev.k === 'para')) return 0
  return 1
}

/** The whole text block of a reply, or null to leave it to the engine. */
export function notionReply(ui: DocUI, md: string, columns: number, isFirst: boolean, proseCap: number): RenderElement | null {
  const blocks = parseBlocks(md)
  if (blocks.length === 0) return null
  // The engine's Code and Markdown elements take at most 10,000 characters;
  // rather than cut a long block, the engine draws the whole reply as usual.
  if (blocks.some(b => (b.k === 'code' ? b.source.length : b.k === 'table' ? b.md.length : 0) > CODE_MAX)) return null
  const { Box, Text } = ui
  const full = Math.max(20, columns - 2)
  const prose = Math.max(20, Math.min(full, proseCap > 0 ? proseCap : full))
  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color={INK.accent}>{isFirst ? '●' : ' '}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {blocks.map((b, i) => (
          <Box flexDirection="column" marginTop={gapBefore(b, blocks[i - 1])}>
            {drawBlock(ui, b, prose, full)}
          </Box>
        ))}
      </Box>
    </Box>
  )
}
