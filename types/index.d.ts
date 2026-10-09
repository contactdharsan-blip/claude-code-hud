// The HUD mod's state contract: every value it keeps in `$.state`.

export type HudLimit = { kind: string; percentUsed: number; resetsAt: string | null }

export type HudUsage = {
  model: string
  turns: number
  startedAt: number
  ctxTokens: number | null
  ctxWindow: number
  ctxPercent: number | null
  limits: HudLimit[]
  usd: number | null
}

export type HudBreakdown = {
  top: { name: string; tokens: number }[]
  total: number
  max: number
  autoCompactAt: number | null
} | null

export type HudGit = {
  root: string
  branch: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  status: Record<string, string>
  numstat: Record<string, [number, number]>
} | null

export type HudCallStatus = 'running' | 'ok' | 'error' | 'denied'

export type HudCall = {
  id: string
  tool: string
  label: string
  startedAt: number
  endedAt: number | null
  status: HudCallStatus
  isSubagent: boolean
}

export type HudTask = { id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }

/** What an agent's spawn said that `$.agent.list()` does not. */
export type HudSpawn = {
  /** The model it runs on, as the spawn resolved it (after any routing hook). */
  model: string
  /** Runs in a git worktree of its own. */
  worktree: boolean
}

export type HudAgent = {
  id: string
  type: string
  description: string
  status: string
  firstSeen: number
  endedAt: number | null
  /** Null when the HUD did not see it start (it began before a reload). */
  spawn: HudSpawn | null
}

/** The open items of the project's `tasks/todo.md`, newest last. */
export type HudTodo = {
  path: string
  open: number
  done: number
  /** The last few open items, each under the heading it sits in. */
  items: { section: string; text: string }[]
} | null

/** One agent of a workflow run, which `$.agent.list()` never shows. */
export type HudFlowAgent = {
  agentId: string
  type: string
  model: string
  description: string
  startedAt: number
  endedAt: number | null
  failed: boolean
}

/** One workflow run, by its `wf_` id, with the agents it started so far. */
export type HudFlow = {
  runId: string
  /** The script's `meta.name`, or a saved workflow's name, when the call gave one. */
  name: string | null
  startedAt: number
  agents: HudFlowAgent[]
}

export type HudLive = {
  isWorking: boolean
  turnId: string | null
  turnStartedAt: number | null
  toolsThisTurn: number
  now: number
}

export type HudBandMode = 'auto' | 'slim' | 'full' | 'compact' | 'minimal' | 'off'

export type HudPrefs = { band: HudBandMode; paneAuto: boolean; bubble: boolean; notion: boolean }

declare module 'claude-code' {
  interface PluginState {
    hud: {
      usage: HudUsage
      breakdown: HudBreakdown
      git: HudGit
      calls: HudCall[]
      tasks: HudTask[]
      agents: HudAgent[]
      spawns: Record<string, HudSpawn>
      flows: HudFlow[]
      files: string[]
      todo: HudTodo
      live: HudLive
      prefs: HudPrefs
      paneOpened: boolean
    }
  }
}
