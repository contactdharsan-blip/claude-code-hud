import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { barParts, callLabel, fmtModel, fmtSpan, fmtTokens, parseNumstat, parsePorcelain } from '../hooks/format'
import { displayWidth, parseBlocks, parseInline, plain, wrapRuns } from '../hooks/notion'

const SURFACES = ['terminal', 'desktop'] as const

const USAGE = {
  model: 'claude-opus-5-5[1m]',
  turns: 7,
  startedAt: 1_000,
  ctxTokens: 312_000 as number | null,
  ctxWindow: 1_000_000,
  ctxPercent: 31 as number | null,
  limits: [
    { kind: 'five_hour', percentUsed: 42, resetsAt: '2030-01-01T02:10:00Z' },
    { kind: 'seven_day', percentUsed: 88, resetsAt: '2030-01-04T09:00:00Z' },
  ],
  usd: 3.12,
}

const BAND = (bodyColumns: number) => ({
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
})

const PANE = {
  component: 'Pane' as const,
  requestId: 'hud',
  props: {
    title: 'HUD',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
}

describe('format', () => {
  test('tokens, spans and model names read like an app, not a log', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(8_200)).toBe('8.2k')
    expect(fmtTokens(312_000)).toBe('312k')
    expect(fmtTokens(1_000_000)).toBe('1M')
    expect(fmtSpan(42_000)).toBe('42s')
    expect(fmtSpan(130 * 60_000)).toBe('2h10m')
    expect(fmtSpan(76 * 3_600_000)).toBe('3d4h')
    expect(fmtModel('claude-opus-5-5[1m]')).toBe('Opus 5.5 1M')
    expect(fmtModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(fmtModel('claude-fable-5')).toBe('Fable 5')
  })

  test('a bar fills its width exactly, with an eighth-block edge', () => {
    for (const pct of [0, 1, 31, 50, 99.9, 100]) {
      const { full, partial, empty } = barParts(pct, 10)
      expect(full.length + partial.length + empty.length).toBe(10)
    }
    expect(barParts(31, 10)).toEqual({ full: '███', partial: '▏', empty: '      ' })
  })

  test('tool calls get a one-line subject', () => {
    expect(callLabel('Bash', { command: 'uv run pytest -q\necho done' })).toBe('uv run pytest -q')
    expect(callLabel('Edit', { file_path: '/a/b/state.py' })).toBe('state.py')
    expect(callLabel('WebFetch', { url: 'https://example.com/x' })).toBe('example.com')
    expect(callLabel('mcp__obscura__browser_click', {})).toBe('browser_click')
  })

  test('git porcelain v2 and numstat parse to counts and per-path marks', () => {
    const p = parsePorcelain(
      [
        '# branch.oid abc',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +1 -2',
        '1 .M N... 100644 100644 100644 aaa bbb app/state.py',
        '1 A. N... 000000 100644 100644 000 ccc hooks/register.tsx',
        '2 R. N... 100644 100644 100644 ddd eee R100 new name.md\told.md',
        '? notes.txt',
      ].join('\n'),
    )
    expect(p.branch).toBe('main')
    expect([p.ahead, p.behind, p.staged, p.unstaged, p.untracked]).toEqual([1, 2, 2, 1, 1])
    expect(p.status).toEqual({ 'app/state.py': 'M', 'hooks/register.tsx': 'A', 'new name.md': 'R', 'notes.txt': '?' })
    expect(parseNumstat('12\t3\tapp/state.py\n-\t-\timg.png\n')).toEqual({
      'app/state.py': [12, 3],
      'img.png': [0, 0],
    })
  })
})

/** Answers, from beneath the plugin, what a real session would: its usage,
 * model, surfaces, cwd, git and agents. The mod's own collectors then fill its
 * state exactly as in a session. */
function session(on: On, opts: { usage?: Partial<typeof USAGE> } = {}) {
  const u = { ...USAGE, ...opts.usage }
  mock.store(on)
  mock.env(on, { HOME: '/Users/owner' })
  mock.clock(on, { now: 1_000 })
  on('session.surfaces', () => ({ value: ['terminal'] as const }))
  on('session.model', () => ({ value: u.model }))
  on('session.turns', () => ({ value: u.turns }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', ($, e) => ({
    value: {
      startedAt: u.startedAt,
      context: {
        tokens: u.ctxTokens ?? undefined,
        window: u.ctxWindow,
        percent: u.ctxPercent ?? undefined,
        breakdown: e.breakdown
          ? ({
              categories: [{ name: 'Messages', tokens: 50_000, color: 'text', isDeferred: false, kind: 'used' }],
              totalTokens: 50_000,
              maxTokens: 1_000_000,
              rawMaxTokens: 1_000_000,
              isAutoCompactEnabled: true,
              autoCompactThreshold: 970_000,
            } as never)
          : undefined,
      },
      rateLimits: u.limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
      cost: { usd: u.usd ?? 0 },
    },
  }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', ($, e) => {
    const sub = e.argv.slice(2).join(' ')
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (sub.startsWith('rev-parse')) return out('/repo\n')
    if (sub.startsWith('status')) return out('# branch.head main\n# branch.ab +1 -0\n1 .M N... 100644 100644 100644 a b state.py\n')
    if (sub.startsWith('diff')) return out('12\t3\tstate.py\n')
    return out('', 1)
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }) as never)
}

const run = (command: string, args = '') =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as never

describe('drawing', () => {
  test('the band narrows by priority and keeps context last', async ($, on) => {
    session(on)
    await $.command.run(run('hud', 'status'))
    await $.turn.start({ text: 'go', turnId: 't1' })
    for (const surface of SURFACES) {
      const wide = await $.ui.mount({ plugin: 'hud', surface, ...BAND(160) })
      expect(await wide.find({ text: /Opus 5\.5 1M/ })).toBeDefined()
      expect(await wide.find({ text: /^31%$/ })).toBeDefined()
      expect(await wide.find({ text: /main/ })).toBeDefined()
      await wide.unmount()

      const narrow = await $.ui.mount({ plugin: 'hud', surface, ...BAND(30) })
      expect(await narrow.find({ text: /Opus/ })).toBeUndefined()
      expect(await narrow.find({ text: /^31%$/ })).toBeDefined()
      await narrow.unmount()
    }
  })

  test('the pane draws its cards from real tool calls and hides the empty ones', async ($, on) => {
    session(on)
    on('tool.call', () => ({ result: {} }) as never)
    await $.command.run(run('hud', 'status'))
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Read', tool_use_id: 'a', file_path: '/repo/tokens.css' } as never)
    await $.tool.call({ tool: 'Read', tool_use_id: 'b', file_path: '/repo/state.py' } as never)
    await $.tool.call({ tool: 'Edit', tool_use_id: 'c', file_path: '/repo/state.py', old_string: 'a', new_string: 'b' } as never)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'hud', surface, ...PANE })
      for (const title of ['Session', 'Context', 'Usage', 'Activity', 'Files']) {
        expect(await ui.find({ text: title })).toBeDefined()
      }
      expect(await ui.find({ text: 'Tasks' })).toBeUndefined()
      expect(await ui.find({ text: 'Agents' })).toBeUndefined()
      expect(await ui.find({ text: / state\.py ×2$/ })).toBeDefined()
      expect(await ui.find({ text: '312k / 1M' })).toBeDefined()
      expect(await ui.find({ text: '+12' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('before the first reply, context shows the local estimate marked ~', async ($, on) => {
    session(on, { usage: { ctxTokens: null, ctxPercent: null } })
    await $.command.run(run('hud', 'status'))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'end_turn' } as never)
    const band = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...BAND(160) })
    expect(await band.find({ text: '~' })).toBeDefined()
    expect(await band.find({ text: /^5%$/ })).toBeDefined()
    await band.unmount()
    const pane = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...PANE })
    expect(await pane.find({ text: '~50k / 1M' })).toBeDefined()
    expect(await pane.find({ text: /msgs/ })).toBeDefined()
    await pane.unmount()
  })

  test("the session's todos fill the Tasks card; a subagent's do not replace them", async ($, on) => {
    session(on)
    on('tool.call', ($, e) =>
      String(e.tool) === 'TodoWrite'
        ? ({ result: { oldTodos: [], newTodos: (e as unknown as { todos: unknown[] }).todos } } as never)
        : ({ result: {} } as never),
    )
    await $.command.run(run('hud', 'status'))
    const todos = [
      { content: 'Read lessons', status: 'completed', activeForm: 'Reading lessons' },
      { content: 'Write plan', status: 'in_progress', activeForm: 'Writing plan' },
      { content: 'Verify', status: 'pending', activeForm: 'Verifying' },
    ]
    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 't1', todos } as never)
    await $.tool.call({
      tool: 'TodoWrite',
      tool_use_id: 't2',
      agentId: 'sub1',
      todos: [{ content: 'subagent step', status: 'pending', activeForm: 'x' }],
    } as never)
    const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: '1 / 3' })).toBeDefined()
    expect(await ui.find({ text: 'Writing plan' })).toBeDefined()
    expect(await ui.find({ text: 'subagent step' })).toBeUndefined()
    await ui.unmount()
  })

  test('the main loop finishing always stops the turn clock, even one it lost track of', async ($, on) => {
    session(on)
    await $.command.run(run('hud', 'status'))
    await $.turn.start({ text: 'go', turnId: 't1' })
    // a subagent's completion leaves the main turn running
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', agentId: 'a1', reason: 'end_turn' } as never)
    let ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...BAND(160) })
    expect(await ui.find({ text: '◐ ' })).toBeDefined()
    await ui.unmount()
    // the main loop's completion under an id we never saw (a hot reload mid-turn) still ends it
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'unseen', reason: 'end_turn' } as never)
    ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...BAND(160) })
    expect(await ui.find({ text: '◐ ' })).toBeUndefined()
    await ui.unmount()
  })

  test('/hud band off hands the row back to the engine', async ($, on) => {
    session(on)
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.command.run(run('hud', 'band off'))
    const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...BAND(160) })
    expect(await ui.find({ text: /Opus/ })).toBeUndefined()
    expect(await ui.find({ text: 'engine' })).toBeDefined()
    await ui.unmount()
  })
})

const REPLY = [
  '# Plan for the HUD',
  '',
  'The band sits **above** the prompt, with `ctx` and a [link](https://example.com).',
  '',
  '- Rounded band',
  '  - nested detail',
  '- [x] Pane auto-opens',
  '- [ ] Hover cards',
  '1. first',
  '2. second',
  '',
  '> Quotes get a grey bar on the left, and a long one wraps under its own bar.',
  '',
  '> [!TIP] Worth knowing',
  '> Callouts sit on a mild fill.',
  '',
  '```ts',
  'const x: number = 1',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '---',
].join('\n')

describe('notion', () => {
  test('blocks: headings, lists, to-dos, quotes, alerts, fences, tables, rules', () => {
    const kinds = parseBlocks(REPLY).map(b => (b.k === 'item' ? `item:${b.task ?? b.marker}:${b.depth}` : b.k))
    expect(kinds).toEqual([
      'heading', 'para',
      'item:•:0', 'item:◦:1', 'item:done:0', 'item:open:0', 'item:1.:0', 'item:2.:0',
      'quote', 'callout', 'code', 'table', 'rule',
    ])
    const callout = parseBlocks(REPLY).find(b => b.k === 'callout')
    expect(callout).toMatchObject({ icon: '💡', title: 'Worth knowing', tone: 'tip' })
    const emoji = parseBlocks('> 🚀 Shipped today')[0]
    expect(emoji).toMatchObject({ k: 'callout', icon: '🚀' })
  })

  test('inline: bold, italic, strike, code, links nest and lose their punctuation', () => {
    const runs = parseInline('a **b _c_** ~~d~~ `e` [f](https://x.y) *g* https://z.io/p.')
    expect(plain(runs)).toBe('a b c d e f g https://z.io/p.')
    expect(runs.find(r => r.t === 'c')).toMatchObject({ bold: true, italic: true })
    expect(runs.find(r => r.t === 'e')).toMatchObject({ code: true })
    expect(runs.find(r => r.t === 'f')).toMatchObject({ href: 'https://x.y' })
    expect(runs.find(r => r.t === 'https://z.io/p')).toMatchObject({ href: 'https://z.io/p' })
    expect(plain(parseInline('snake_case_name and 2*3*4'))).toBe('snake_case_name and 2*3*4')
  })

  test('wrapping keeps styles per word and never exceeds the width', () => {
    const rows = wrapRuns(parseInline('one **two three** four five six seven'), 10)
    for (const r of rows) expect(plain(r).length).toBeLessThanOrEqual(10)
    expect(rows.map(plain)).toEqual(['one two', 'three four', 'five six', 'seven'])
    expect(rows[0]!.find(r => r.t === 'two')).toMatchObject({ bold: true })
  })

  test('regressions: inputs that lost text or structure in review', () => {
    // a heading's own `#` is content; only a space-separated run closes it
    const headingText = (md: string) => {
      const b = parseBlocks(md)[0]
      return b?.k === 'heading' ? plain(b.inl) : null
    }
    expect(headingText('## Why C#')).toBe('Why C#')
    expect(headingText('## F# and C# ##')).toBe('F# and C#')
    // a fence inside a tight list item stays a code block, indented under the item
    const tight = parseBlocks(['- Run:', '  ```sh', '  git status', '  git log --oneline', '  ```', '- Then check.'].join('\n'))
    expect(tight.map(b => b.k)).toEqual(['item', 'code', 'item'])
    expect(tight[1]).toMatchObject({ lang: 'sh', source: 'git status\ngit log --oneline', indent: 2 })
    // an unclosed fence (still streaming) is code to the end, not prose
    expect(parseBlocks('- Run:\n  ```sh\n  git status')[1]).toMatchObject({ k: 'code', source: 'git status' })
    // one level of parentheses in a URL
    const wiki = parseInline('see [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) now')
    expect(wiki.find(r => r.t === 'Foo')).toMatchObject({ href: 'https://en.wikipedia.org/wiki/Foo_(bar)' })
    expect(plain(wiki)).toBe('see Foo now')
    expect(parseInline('at https://en.wikipedia.org/wiki/Foo_(bar).').find(r => r.href)?.href).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
    // nesting follows the indents used: 4-space sublists are depth 1, not 2
    const depths = parseBlocks('- a\n    - b\n        - c\n- d').map(b => (b.k === 'item' ? `${b.depth}${b.marker}` : b.k))
    expect(depths).toEqual(['0•', '1◦', '2▪', '0•'])
    // pathological input is shown as typed, quickly
    const t0 = Date.now()
    expect(plain(parseInline('['.repeat(16000) + 'a'))).toBe('['.repeat(16000) + 'a')
    expect(Date.now() - t0).toBeLessThan(200)
  })

  test('wrapping never splits a grapheme and counts wide characters as two columns', () => {
    const party = wrapRuns([{ t: '🎉'.repeat(12) }], 5)
    for (const row of party) {
      expect(plain(row)).not.toMatch(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/u)
      expect(displayWidth(plain(row))).toBeLessThanOrEqual(5)
    }
    expect(party.map(plain).join('')).toBe('🎉'.repeat(12))
    const family = '👨‍👩‍👧‍👦'.repeat(4)
    expect(wrapRuns([{ t: family }], 5).map(plain).join('')).toBe(family)
    for (const row of wrapRuns([{ t: '这是一个很长的中文句子用来测试换行' }], 20)) expect(displayWidth(plain(row))).toBeLessThanOrEqual(20)
  })

  test('/hud notion on draws replies as a page; off hands them back', async ($, on) => {
    session(on)
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    const MSG = { component: 'AssistantMessage' as const, props: { text: REPLY, isFirstOfReply: true }, viewport: { columns: 100, rows: 40 } }

    const off = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...MSG })
    expect(await off.find({ text: 'engine' })).toBeDefined()
    await off.unmount()

    await $.command.run(run('hud', 'notion on'))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'hud', surface, ...MSG })
      expect(await ui.find({ text: 'engine' })).toBeUndefined()
      expect(await ui.find({ text: 'Plan for the HUD' })).toBeDefined()
      expect(await ui.find({ text: /^#/ })).toBeUndefined()
      expect(await ui.find({ text: '•' })).toBeDefined()
      expect(await ui.find({ text: '☑' })).toBeDefined()
      expect(await ui.find({ text: '☐' })).toBeDefined()
      expect(await ui.find({ text: '▎' })).toBeDefined()
      expect(await ui.find({ text: '💡' })).toBeDefined()
      expect(await ui.find({ text: ' ctx ' })).toBeDefined()
      expect(await ui.find({ type: 'Code' })).toBeDefined()
      expect(await ui.find({ type: 'Markdown' })).toBeDefined()
      await ui.unmount()
    }

    // a table too long for the Markdown element: the engine draws the whole reply, nothing is cut
    const big = ['| a | b |', '|---|---|', ...Array.from({ length: 1500 }, (_, k) => `| ${k} | row ${k} |`)].join('\n')
    const long = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...MSG, props: { text: big, isFirstOfReply: false } })
    expect(await long.find({ text: 'engine' })).toBeDefined()
    await long.unmount()
  })
})
