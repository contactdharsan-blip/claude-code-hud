// A small markdown reader for the Notion-style reply: blocks and inline runs,
// pure, so tests read it directly. It reads what Claude writes (headings,
// lists, to-dos, quotes, GitHub alerts, fences, tables, rules) and hands
// anything else back as a paragraph, never dropping text.

export type Inline = { t: string; bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; href?: string }

export type Block =
  | { k: 'heading'; level: number; inl: Inline[] }
  | { k: 'para'; lines: Inline[][] }
  | { k: 'item'; depth: number; marker: string; task: 'open' | 'done' | null; inl: Inline[] }
  | { k: 'quote'; lines: Inline[][] }
  | { k: 'callout'; icon: string; title: string | null; tone: Tone; lines: Inline[][] }
  | { k: 'code'; lang: string; source: string }
  | { k: 'table'; md: string }
  | { k: 'rule' }

export type Tone = 'note' | 'tip' | 'important' | 'warning' | 'caution' | 'plain'

const ALERTS: Record<string, { icon: string; tone: Tone }> = {
  NOTE: { icon: 'ℹ️', tone: 'note' },
  TIP: { icon: '💡', tone: 'tip' },
  IMPORTANT: { icon: '❗', tone: 'important' },
  WARNING: { icon: '⚠️', tone: 'warning' },
  CAUTION: { icon: '🛑', tone: 'caution' },
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const EMOJI_LEAD = /^(\p{Extended_Pictographic}️?)\s+(.*)$/u

const BULLETS = ['•', '◦', '▪']

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') {
      i += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const close = fence[1]!
      const body: string[] = []
      i += 1
      while (i < lines.length && !lines[i]!.trimStart().startsWith(close)) body.push(lines[i++]!)
      i += 1
      out.push({ k: 'code', lang: fence[2] ?? '', source: body.join('\n') })
      continue
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const rows: string[] = []
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) rows.push(lines[i++]!)
      out.push({ k: 'table', md: rows.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ k: 'heading', level: heading[1]!.length, inl: parseInline(heading[2] ?? '') })
      i += 1
      continue
    }

    if (RULE.test(line)) {
      out.push({ k: 'rule' })
      i += 1
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1] ?? '')
      out.push(quoteBlock(body))
      continue
    }

    const item = ITEM.exec(line)
    if (item) {
      const indent = item[1]!.replace(/\t/g, '    ').length
      const ordered = /\d/.test(item[2]!)
      const box = item[3]
      let text = item[4] ?? ''
      i += 1
      // a lazy continuation line belongs to the item above
      while (i < lines.length && lines[i]!.trim() !== '' && /^\s{2,}\S/.test(lines[i]!) && !ITEM.test(lines[i]!)) {
        text += ' ' + lines[i++]!.trim()
      }
      const depth = Math.min(3, Math.floor(indent / 2))
      out.push({
        k: 'item',
        depth,
        marker: ordered ? item[2]!.replace(')', '.') : (BULLETS[depth % BULLETS.length] ?? '•'),
        task: box === undefined ? null : box === ' ' ? 'open' : 'done',
        inl: parseInline(text),
      })
      continue
    }

    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() !== '' && !startsBlock(lines, i)) para.push(lines[i++]!.trim())
    out.push({ k: 'para', lines: para.map(l => parseInline(l)) })
  }
  return out
}

function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i]!
  return (
    FENCE.test(l) ||
    HEADING.test(l) ||
    RULE.test(l) ||
    QUOTE.test(l) ||
    ITEM.test(l) ||
    (TABLE_ROW.test(l) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!))
  )
}

function quoteBlock(body: string[]): Block {
  const first = body[0] ?? ''
  const alert = /^\[!(\w+)\]\s*(.*)$/.exec(first)
  if (alert && ALERTS[alert[1]!.toUpperCase()]) {
    const a = ALERTS[alert[1]!.toUpperCase()]!
    const title = alert[2]?.trim() ? alert[2].trim() : null
    return { k: 'callout', icon: a.icon, tone: a.tone, title, lines: body.slice(1).filter(l => l.trim() !== '').map(l => parseInline(l)) }
  }
  const lead = EMOJI_LEAD.exec(first)
  if (lead) {
    return {
      k: 'callout',
      icon: lead[1]!,
      tone: 'plain',
      title: null,
      lines: [lead[2] ?? '', ...body.slice(1)].filter(l => l.trim() !== '').map(l => parseInline(l)),
    }
  }
  return { k: 'quote', lines: body.filter(l => l.trim() !== '').map(l => parseInline(l)) }
}

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?<![\w*])\*(?![\s*])([^*]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?![\s_])([^_]+?)(?<!\s)_(?![\w_])|(https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?'"])/g

type Style = Omit<Inline, 't'>

/** Inline markdown to styled runs; bold, italic and strike nest, code does not. */
export function parseInline(text: string, style: Style = {}): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ ...style, t: text.slice(last, at) })
    if (m[2] !== undefined) out.push({ ...style, code: true, t: m[2].trim() === '' ? m[2] : m[2].replace(/^ (.*) $/, '$1') })
    else if (m[3] !== undefined || m[4] !== undefined) out.push(...parseInline(m[3] ?? m[4] ?? '', { ...style, bold: true }))
    else if (m[5] !== undefined) out.push(...parseInline(m[5], { ...style, strike: true }))
    else if (m[6] !== undefined) out.push(...parseInline(m[6], { ...style, href: m[7] }))
    else if (m[8] !== undefined || m[9] !== undefined) out.push(...parseInline(m[8] ?? m[9] ?? '', { ...style, italic: true }))
    else if (m[10] !== undefined) out.push({ ...style, t: m[10], href: m[10] })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ ...style, t: text.slice(last) })
  return out.filter(r => r.t !== '')
}

/** The plain text of runs: what a reader would copy. */
export const plain = (inl: Inline[]) => inl.map(r => r.t).join('')

/** Greedy word wrap of styled runs to `width` columns, styles kept per word.
 * Used where each drawn row needs its own gutter glyph (a quote's bar). */
export function wrapRuns(inl: Inline[], width: number): Inline[][] {
  const w = Math.max(4, width)
  const lines: Inline[][] = [[]]
  let col = 0
  const line = () => lines[lines.length - 1]!
  const breakLine = () => {
    const l = line()
    if (l.length && l[l.length - 1]!.t === ' ') l.pop()
    lines.push([])
    col = 0
  }
  for (const r of inl) {
    for (const piece of r.t.split(/(\s+)/)) {
      if (!piece) continue
      if (/^\s+$/.test(piece)) {
        if (col === 0) continue
        if (col + 1 > w) breakLine()
        else {
          line().push({ ...r, t: ' ' })
          col += 1
        }
        continue
      }
      let word = piece
      while (word.length > 0) {
        if (col + word.length <= w) {
          line().push({ ...r, t: word })
          col += word.length
          word = ''
        } else if (col === 0) {
          line().push({ ...r, t: word.slice(0, w) })
          word = word.slice(w)
          breakLine()
        } else {
          breakLine()
        }
      }
    }
  }
  return lines.filter((l, i) => l.length > 0 || i === 0)
}
