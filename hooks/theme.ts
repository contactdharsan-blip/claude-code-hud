// The one place to restyle the HUD. Every colour is a key of Claude Code's own
// theme (read from the 2.1.289 binary), so light, dark and the daltonized
// themes all follow `/theme` with no raw hex here.

import type { HudCallStatus } from '../types'
import type { Level } from './format'

export const INK = {
  keyline: 'promptBorder',
  card: 'composerSidebarBackground',
  bubble: 'userMessageBackground',
  track: 'subtle',
  accent: 'claude',
  running: 'permission',
  ok: 'success',
  warn: 'warning',
  bad: 'error',
  added: 'success',
  removed: 'error',
  // the Notion-style reply
  code: 'claude',
  codeBg: 'userMessageBackground',
  link: 'permission',
  quoteBar: 'inactive',
  calloutBg: 'userMessageBackground',
  rule: 'subtle',
  done: 'permission',
} as const

export function levelInk(l: Level): string | undefined {
  return l === 'bad' ? INK.bad : l === 'warn' ? INK.warn : l === 'ok' ? INK.ok : undefined
}

/** A card's keyline: neutral until its subject needs attention. */
export function keylineFor(l: Level): string {
  return l === 'bad' ? INK.bad : l === 'warn' ? INK.warn : INK.keyline
}

export const GLYPH = {
  running: '◐',
  ok: '✓',
  error: '✗',
  denied: '⊘',
  pending: '○',
  model: '●',
  branch: '⎇',
  reset: '↻',
  ahead: '↑',
  behind: '↓',
  dirty: '±',
  sub: '↳',
  sep: '·',
} as const

export const STATUS_GLYPH: Record<HudCallStatus, { glyph: string; ink: string }> = {
  running: { glyph: GLYPH.running, ink: INK.running },
  ok: { glyph: GLYPH.ok, ink: INK.ok },
  error: { glyph: GLYPH.error, ink: INK.bad },
  denied: { glyph: GLYPH.denied, ink: INK.warn },
}
