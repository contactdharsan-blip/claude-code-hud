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

export type HudAgent = {
  id: string
  type: string
  description: string
  status: string
  firstSeen: number
  endedAt: number | null
}

export type HudLive = {
  isWorking: boolean
  turnId: string | null
  turnStartedAt: number | null
  toolsThisTurn: number
  now: number
}

export type HudBandMode = 'auto' | 'full' | 'compact' | 'minimal' | 'off'

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
      files: string[]
      live: HudLive
      prefs: HudPrefs
      paneOpened: boolean
    }
  }
}
