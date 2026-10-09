// HUD: an app-like heads-up display for Claude Code's terminal.
//
//   band   a rounded strip above the prompt: model, context, rate limits,
//          cost, branch and the running turn, narrowed by priority to fit
//   pane   a docked inspector of rounded cards: Session, Context, Usage,
//          Activity, Tasks, Agents, Files (a card with nothing to say hides)
//   /hud   toggles the pane; `/hud band|auto|bubble|notion ...` set preferences
//   notion (opt-in) draws Claude's replies as a Notion page: bullets, to-dos,
//          quote bars, filled callouts, inline-code pills, a prose column
//
// The mod stays passive until a surface draws, so headless `claude -p` runs
// (scripts, pipelines, CI) pay nothing but a few pass-through hooks.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { HudAgent, HudBandMode, HudCall, HudCallStatus, HudFlowAgent, HudLive, HudPrefs, HudSpawn, HudTask, HudUsage } from '../types'
import { callLabel, categoryName, fmtTokens, parseNumstat, parsePorcelain, parseTodo, workflowName } from './format'
import { band, bubble, hintTail, notionReply, pane, type HudData } from './view'

type $ = EngineInterface

const MAX_CALLS = 60
const MAX_SPAWNS = 60
const MAX_FLOWS = 3
const MAX_FLOW_AGENTS = 40
// The plan file the global workflow keeps, relative to the repository root.
const TODO_FILE = 'tasks/todo.md'
const TODO_ROWS = 6
const WRITES = new Set(['Edit', 'Write', 'NotebookEdit'])
const GIT_TOUCHING = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash'])
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'])
const BAND_MODES: HudBandMode[] = ['auto', 'slim', 'full', 'compact', 'minimal', 'off']

/** Swallows a collector's failure: the HUD degrades, the session never does. */
const quietly = (work: Promise<unknown>) => {
  void work.catch(() => undefined)
}

// ─── State ────────────────────────────────────────────────────────────────────
// Every value the HUD draws from, as `$.state` atoms: they survive a hot reload,
// module variables do not. Declared here, not imported, because the engine lists
// what a module reads and writes by scanning for atoms that are consts of its file.

const PANE = 'hud'

const DEFAULT_PREFS: HudPrefs = { band: 'auto', paneAuto: true, bubble: false, notion: false }

const EMPTY_USAGE: HudUsage = {
  model: '',
  turns: 0,
  startedAt: 0,
  ctxTokens: null,
  ctxWindow: 0,
  ctxPercent: null,
  limits: [],
  usd: null,
}

const IDLE: HudLive = { isWorking: false, turnId: null, turnStartedAt: null, toolsThisTurn: 0, now: 0 }

const usageAtom = atom({ plugin: 'hud', key: 'usage' } as const, EMPTY_USAGE)
const breakdownAtom = atom({ plugin: 'hud', key: 'breakdown' } as const, null)
const gitAtom = atom({ plugin: 'hud', key: 'git' } as const, null)
const callsAtom = atom({ plugin: 'hud', key: 'calls' } as const, [])
const tasksAtom = atom({ plugin: 'hud', key: 'tasks' } as const, [])
const agentsAtom = atom({ plugin: 'hud', key: 'agents' } as const, [])
const spawnsAtom = atom({ plugin: 'hud', key: 'spawns' } as const, {})
const flowsAtom = atom({ plugin: 'hud', key: 'flows' } as const, [])
const filesAtom = atom({ plugin: 'hud', key: 'files' } as const, [])
const todoAtom = atom({ plugin: 'hud', key: 'todo' } as const, null)
const liveAtom = atom({ plugin: 'hud', key: 'live' } as const, IDLE)
const prefsAtom = atom({ plugin: 'hud', key: 'prefs' } as const, DEFAULT_PREFS)
const paneOpenedAtom = atom({ plugin: 'hud', key: 'paneOpened' } as const, false)

// ─── Collectors ───────────────────────────────────────────────────────────────
// They read the session through `$` and write the atoms. None of them calls a
// model; git runs only when asked (turn end, after an edit), never on an idle
// timer, and with --no-optional-locks so it never takes the index lock from
// under a git command the model is running. They live in this file because `$`
// may only be passed to functions declared here: the engine follows it
// statically, and never across an import.

/** Whether a fresh reading equals what is held: an unchanged value is not written,
 * so its readers do not redraw. */
const same = (held: unknown, value: unknown) => JSON.stringify(held) === JSON.stringify(value)

async function refreshUsage($: $): Promise<void> {
  const [u, model, turns] = await Promise.all([$.session.usage(), $.session.model(), $.session.turns()])
  const value: HudUsage = {
    model,
    turns,
    startedAt: u.startedAt,
    ctxTokens: u.context.tokens ?? null,
    ctxWindow: u.context.window,
    ctxPercent: u.context.percent ?? null,
    limits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt ?? null })),
    usd: u.cost?.usd ?? null,
  }
  if (!same(await read($, usageAtom), value)) await update($, usageAtom, () => value)
}

/** The /context breakdown, estimated locally (`summary` sends no requests). */
async function refreshBreakdown($: $): Promise<void> {
  const u = await $.session.usage({ breakdown: 'summary', columns: 40 })
  const b = u.context.breakdown
  if (!b) return
  const top = b.categories
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .sort((a, z) => z.tokens - a.tokens)
    .slice(0, 3)
    .map(c => ({ name: categoryName(c.name), tokens: c.tokens }))
  const value = {
    top,
    total: b.totalTokens,
    max: b.rawMaxTokens,
    autoCompactAt: b.isAutoCompactEnabled && b.autoCompactThreshold ? b.autoCompactThreshold : null,
  }
  if (!same(await read($, breakdownAtom), value)) await update($, breakdownAtom, () => value)
}

async function refreshGit($: $): Promise<void> {
  const cwd = await $.session.cwd()
  const git = (...args: string[]) => $.process.run(['git', '--no-optional-locks', ...args], { cwd })
  const top = await git('rev-parse', '--show-toplevel')
  if (top.exitCode !== 0) {
    if ((await read($, gitAtom)) !== null) await update($, gitAtom, () => null)
    return
  }
  const [status, numstat] = await Promise.all([git('status', '--porcelain=v2', '--branch'), git('diff', '--numstat', 'HEAD')])
  const p = parsePorcelain(status.stdout)
  const value = {
    root: top.stdout.trim(),
    ...p,
    numstat: numstat.exitCode === 0 ? parseNumstat(numstat.stdout) : {},
  }
  if (!same(await read($, gitAtom), value)) await update($, gitAtom, () => value)
}

/** The repository's `tasks/todo.md` (the working directory's when there is no
 * repository): read at activation, at the end of each turn, and after a write
 * to it. A missing file hides the card. */
async function refreshTodo($: $): Promise<void> {
  const root = (await read($, gitAtom))?.root ?? (await $.session.cwd())
  const path = `${root}/${TODO_FILE}`
  const text = await $.fs.read(path).catch(() => null)
  const value = typeof text === 'string' ? { path, ...parseTodo(text, TODO_ROWS) } : null
  if (!same(await read($, todoAtom), value)) await update($, todoAtom, () => value)
}

const ACTIVE = new Set(['pending', 'running', 'waiting'])

/** Returns whether any agent is still active, so the caller knows to keep polling. */
async function refreshAgents($: $, at: number): Promise<boolean> {
  const [listed, held, spawns, flows] = await Promise.all([$.agent.list(), read($, agentsAtom), read($, spawnsAtom), read($, flowsAtom)])
  const before = new Map(held.map(a => [a.id, a]))
  const next: HudAgent[] = listed.map(a => {
    const was = before.get(a.id)
    const isActive = ACTIVE.has(a.status)
    return {
      id: a.id,
      type: a.type,
      description: a.description,
      status: a.status,
      firstSeen: was?.firstSeen ?? at,
      endedAt: isActive ? null : (was?.endedAt ?? at),
      spawn: spawns[a.id] ?? null,
    }
  })
  if (!same(held, next)) await update($, agentsAtom, () => next)
  // A workflow's agents are not in the list, and keep the clock running too.
  return next.some(a => ACTIVE.has(a.status)) || flows.some(f => f.agents.some(a => a.endedAt === null))
}

type Todo = { content: string; status: HudTask['status']; activeForm: string }

/** Folds a settled task-tool call into the Tasks card. */
async function noteTasks($: $, tool: string, input: Record<string, unknown>, result: unknown): Promise<void> {
  const r = (result ?? {}) as Record<string, unknown>
  if (tool === 'TodoWrite' && Array.isArray(r.newTodos)) {
    const todos = r.newTodos as Todo[]
    const value = todos.map(t => ({
      id: t.content,
      text: t.status === 'in_progress' ? t.activeForm || t.content : t.content,
      status: t.status,
    }))
    await update($, tasksAtom, () => value)
  } else if (tool === 'TaskList' && Array.isArray(r.tasks)) {
    const tasks = r.tasks as { id: string; subject: string; status: HudTask['status'] }[]
    const value = tasks.map(t => ({ id: t.id, text: t.subject, status: t.status }))
    await update($, tasksAtom, () => value)
  } else if (tool === 'TaskCreate' && r.task && typeof r.task === 'object') {
    const t = r.task as { id: string; subject: string }
    await update($, tasksAtom, list => [...list.filter(x => x.id !== t.id), { id: t.id, text: t.subject, status: 'pending' as const }])
  } else if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
    const id = input.taskId
    const status = input.status
    const subject = typeof input.subject === 'string' ? input.subject : undefined
    await update($, tasksAtom, list =>
      status === 'deleted'
        ? list.filter(x => x.id !== id)
        : list.map(x =>
            x.id === id
              ? {
                  ...x,
                  text: subject ?? x.text,
                  status: status === 'pending' || status === 'in_progress' || status === 'completed' ? status : x.status,
                }
              : x,
          ),
    )
  }
}

/** Keeps what a spawn said about its agent, which the agent list never carries:
 * the model it resolved to (after any routing hook beneath), and how it runs. */
async function noteSpawn($: $, agentId: string, spawn: HudSpawn): Promise<void> {
  await update($, spawnsAtom, held => Object.fromEntries([...Object.entries(held).filter(([id]) => id !== agentId), [agentId, spawn]].slice(-MAX_SPAWNS)))
}

/** Adds a workflow agent to its run, opening the run on its first agent. */
async function noteFlowAgent($: $, runId: string, name: string | null, agent: HudFlowAgent): Promise<void> {
  await update($, flowsAtom, runs => {
    const run = runs.find(r => r.runId === runId) ?? { runId, name, startedAt: agent.startedAt, agents: [] }
    const agents = [...run.agents.filter(a => a.agentId !== agent.agentId), agent].slice(-MAX_FLOW_AGENTS)
    return [...runs.filter(r => r.runId !== runId), { ...run, name: run.name ?? name, agents }].slice(-MAX_FLOWS)
  })
}

/** Closes a workflow agent when its loop completes; any other loop is no concern of this. */
async function endFlowAgent($: $, agentId: string, at: number, failed: boolean): Promise<void> {
  const runs = await read($, flowsAtom)
  if (!runs.some(r => r.agents.some(a => a.agentId === agentId && a.endedAt === null))) return
  await update($, flowsAtom, list =>
    list.map(r => ({ ...r, agents: r.agents.map(a => (a.agentId === agentId && a.endedAt === null ? { ...a, endedAt: at, failed } : a)) })),
  )
}

/** Remembers a file the session wrote, newest last, at most 30. */
async function noteFile($: $, path: string): Promise<void> {
  if (!path) return
  await update($, filesAtom, list => [...list.filter(p => p !== path), path].slice(-30))
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

// Module state: lost on a hot reload by design; session.start rebuilds it.
let active = false
let working = false
let agentsBusy = false
let ticks = 0
let tickMs = 0
let ticker: Timer | null = null
// Agent calls that asked for a worktree, by tool_use_id: `isolation` is on the
// tool's input alone, and the spawn it raises carries the same id.
const worktreeCalls = new Set<string>()
// Workflow calls' names, by tool_use_id: the call returns at once and its agents
// start later, each spawn carrying the call's id. The last few only.
const flowNames = new Map<string, string>()
let gitTimer: Timer | null = null
let home: string | null = null
// The prose column of a Notion-style reply: settings' maxProseWidth, else 80.
let proseCap = 80

function now($: $): Promise<number> {
  return $.clock.now()
}

async function loadPrefs($: $): Promise<HudPrefs> {
  const stored = (await $.store.get('prefs')) as Partial<HudPrefs> | undefined
  const prefs = { ...DEFAULT_PREFS, ...(stored ?? {}) }
  await update($, prefsAtom, () => prefs)
  return prefs
}

async function savePrefs($: $, change: Partial<HudPrefs>): Promise<HudPrefs> {
  const prefs = await update($, prefsAtom, p => ({ ...p, ...change }))
  await $.store.set('prefs', prefs)
  return prefs
}

function gitSoon($: $) {
  gitTimer?.cancel()
  gitTimer = $.clock.after(1500, () => quietly(refreshGit($)))
}

/** One clock, paced by need: every second while a turn or an agent runs
 * (elapsed times, agent polling every 2s), every 30s idle (reset countdowns). */
function retime($: $) {
  const want = working || agentsBusy ? 1000 : 30_000
  if (ticker && tickMs === want) return
  ticker?.cancel()
  tickMs = want
  ticker = $.clock.every(want, () => {
    ticks += 1
    quietly(now($).then(t => update($, liveAtom, l => ({ ...l, now: t }))))
    if (agentsBusy && ticks % 2 === 0) {
      quietly(
        now($)
          .then(t => refreshAgents($, t))
          .then(b => {
            agentsBusy = b
            retime($)
          }),
      )
    }
  })
}

async function activate($: $): Promise<void> {
  if (active) return
  active = true
  try {
    home = (await $.env.get('HOME')) ?? null
    // An unreadable setting is no reason to stay dark: keep the default width.
    const settings = (await $.settings.read().catch(() => ({}))) as { maxProseWidth?: unknown }
    if (typeof settings.maxProseWidth === 'number' && settings.maxProseWidth >= 40) proseCap = settings.maxProseWidth
    const prefs = await loadPrefs($)
    const live = await read($, liveAtom)
    working = live.isWorking
    // Each collector fails alone: a missing or slow git must not cost the rest.
    await Promise.allSettled([
      refreshUsage($),
      refreshGit($)
        .catch(() => undefined)
        .then(() => refreshTodo($)),
      now($)
        .then(t => refreshAgents($, t))
        .then(b => {
          agentsBusy = b
        }),
    ])
    quietly(refreshBreakdown($))
    ticker?.cancel()
    ticker = null
    retime($)
    if (prefs.paneAuto && !(await read($, paneOpenedAtom))) {
      try {
        await $.ui.open({ id: PANE, title: 'HUD' })
        await update($, paneOpenedAtom, () => true)
      } catch {
        // Refused: leave the latch unset; `/hud` still opens it.
      }
    }
  } catch {
    active = false
  }
}

async function data($: $): Promise<HudData> {
  const [usage, breakdown, git, calls, tasks, agents, flows, files, todo, live, prefs] = await Promise.all([
    read($, usageAtom),
    read($, breakdownAtom),
    read($, gitAtom),
    read($, callsAtom),
    read($, tasksAtom),
    read($, agentsAtom),
    read($, flowsAtom),
    read($, filesAtom),
    read($, todoAtom),
    read($, liveAtom),
    read($, prefsAtom),
  ])
  return { usage, breakdown, git, calls, tasks, agents, flows, files, todo, live, prefs, home }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hud',
      description: 'HUD: toggle the inspector pane, or set the band, auto-open and prompt bubble',
      argumentHint: '[band auto|slim|full|compact|minimal|off] [auto|bubble|notion on|off] [status]',
      immediate: true,
    })
    if ((await $.session.surfaces()).length > 0) quietly(activate($))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (active) {
      const t = await now($)
      await update($, liveAtom, l =>
        l.isWorking ? l : { isWorking: true, turnId: e.turnId, turnStartedAt: t, toolsThisTurn: 0, now: t },
      )
      working = true
      retime($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // Not gated on `active`: the main loop's completion (no agentId) always ends
    // the turn, even one whose start a hot reload made us lose track of.
    const t = await now($)
    const live = await read($, liveAtom)
    if (live.isWorking && (e.agentId === undefined || live.turnId === e.turnId)) {
      await update($, liveAtom, l => ({ ...l, isWorking: false, turnId: null, now: t }))
      working = false
    }
    if (active && e.agentId !== undefined) quietly(endFlowAgent($, e.agentId, t, e.isAborted || e.reason === 'refusal'))
    if (active) {
      retime($)
      quietly(refreshUsage($))
      quietly(refreshBreakdown($))
      quietly(refreshGit($))
      quietly(refreshTodo($))
      quietly(
        refreshAgents($, t).then(b => {
          agentsBusy = b
          retime($)
        }),
      )
    }
    return done
  })

  on('tool.call', async ($, e, next) => {
    if (!active) return next(e)
    const input = e as unknown as Record<string, unknown>
    const call: HudCall = {
      id: e.tool_use_id,
      tool: e.tool,
      label: callLabel(e.tool, input),
      startedAt: await now($),
      endedAt: null,
      status: 'running',
      isSubagent: e.agentId !== undefined,
    }
    await update($, callsAtom, list => [...list, call].slice(-MAX_CALLS))
    if (!call.isSubagent) await update($, liveAtom, l => ({ ...l, toolsThisTurn: l.toolsThisTurn + 1 }))
    if (e.tool === 'Agent') {
      if (input.isolation === 'worktree') worktreeCalls.add(e.tool_use_id)
      agentsBusy = true
      retime($)
    }
    if (e.tool === 'Workflow') {
      const name = workflowName(input)
      if (name) {
        flowNames.set(e.tool_use_id, name)
        for (const id of [...flowNames.keys()].slice(0, -10)) flowNames.delete(id)
      }
    }

    // Its spawn, if any, has happened by the time the call returns.
    const ran = await next(e).finally(() => worktreeCalls.delete(e.tool_use_id))

    try {
      const status: HudCallStatus = ran.deny !== undefined ? 'denied' : ran.isError ? 'error' : 'ok'
      const endedAt = await now($)
      await update($, callsAtom, list => list.map(c => (c.id === call.id ? { ...c, status, endedAt } : c)))
      if (status === 'ok') {
        // A subagent's own todo list is not the session's.
        if (TASK_TOOLS.has(e.tool) && !call.isSubagent) await noteTasks($, e.tool, input, ran.result)
        if (WRITES.has(e.tool)) {
          const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
          await noteFile($, path)
          if (path.endsWith(`/${TODO_FILE}`)) quietly(refreshTodo($))
        }
      }
      if (GIT_TOUCHING.has(e.tool)) gitSoon($)
      quietly(refreshUsage($))
    } catch {
      // The tool's result stands whatever the HUD failed to record.
    }
    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const isWorktree = worktreeCalls.delete(e.tool_use_id)
    if (!active || !started.agentId) return started
    const agentId = started.agentId
    try {
      await noteSpawn($, agentId, { model: started.model, worktree: isWorktree })
      if (e.workflow) {
        await noteFlowAgent($, e.workflow.runId, flowNames.get(e.tool_use_id) ?? null, {
          agentId,
          type: e.subagentType,
          model: started.model,
          description: e.description,
          startedAt: await now($),
          endedAt: null,
          failed: false,
        })
      }
      agentsBusy = true
      retime($)
      quietly(
        now($)
          .then(t => refreshAgents($, t))
          .then(b => {
            agentsBusy = b
            retime($)
          }),
      )
    } catch {
      // The agent started whatever the HUD failed to record.
    }
    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if (!active) $.clock.after(0, () => quietly(activate($)))
    const d = await data($)
    if (d.prefs.band === 'off') return next(e)
    const tree = band($.ui.resolve(e), d, e.props.bodyColumns)
    return tree ?? next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    return pane($.ui.resolve(e), await data($), e.props.bodyColumns)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const prefs = await read($, prefsAtom)
    if (prefs.band !== 'off') return next(e)
    const tail = hintTail(await data($))
    return tail ? next({ ...e, props: { ...e.props, tail } }) : next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const prefs = await read($, prefsAtom)
    if (!prefs.notion) return next(e)
    const tree = notionReply($.ui.resolve(e), e.props.text, e.viewport?.columns ?? 80, e.props.isFirstOfReply, proseCap)
    return tree ?? next(e)
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.isExpanded || e.props.origin.kind !== 'composer') return next(e)
    const prefs = await read($, prefsAtom)
    if (!prefs.bubble) return next(e)
    return bubble($.ui.resolve(e), e.props.text)
  })

  on('command.run', { command: 'hud' }, async ($, e) => {
    await activate($)
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const [verb, value] = words

    if (verb === undefined || verb === 'pane') {
      // A pane auto-opened on a narrow terminal is listed but waits undrawn;
      // only one the person can see is closed, anything else is (re)opened,
      // which seats it at any width because the person asked.
      const isVisible = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced && p.isShown)
      if (isVisible) {
        await $.ui.close({ id: PANE })
        return { text: 'HUD pane closed.' }
      }
      await $.ui.open({ id: PANE, title: 'HUD' })
      return { text: 'HUD pane opened.' }
    }
    if (verb === 'band' && BAND_MODES.includes(value as HudBandMode)) {
      await savePrefs($, { band: value as HudBandMode })
      return { text: `HUD band: ${value}.` }
    }
    if ((verb === 'auto' || verb === 'bubble' || verb === 'notion') && (value === 'on' || value === 'off')) {
      const enabled = value === 'on'
      await savePrefs($, verb === 'auto' ? { paneAuto: enabled } : verb === 'bubble' ? { bubble: enabled } : { notion: enabled })
      const what = verb === 'auto' ? 'pane auto-open' : verb === 'bubble' ? 'prompt bubble' : 'Notion-style replies'
      return { text: `HUD ${what}: ${value}.` }
    }
    if (verb === 'status') {
      const d = await data($)
      const ctx = d.usage.ctxTokens !== null ? `${fmtTokens(d.usage.ctxTokens)} of ${fmtTokens(d.usage.ctxWindow)}` : 'not measured yet'
      return {
        text: `HUD band ${d.prefs.band}, pane auto-open ${d.prefs.paneAuto ? 'on' : 'off'}, bubble ${d.prefs.bubble ? 'on' : 'off'}, notion ${d.prefs.notion ? 'on' : 'off'}. Context ${ctx}.`,
      }
    }
    return {
      text: 'Usage: /hud (toggle pane) · /hud band auto|slim|full|compact|minimal|off · /hud auto on|off · /hud bubble on|off · /hud notion on|off · /hud status',
    }
  })
}
