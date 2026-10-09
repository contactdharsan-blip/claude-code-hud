import type { AgentInfo, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { barParts, callLabel, fmtModel, fmtSpan, fmtTokens, modelFamily, parseNumstat, parsePorcelain, parseTodo, tierTally, workflowName } from '../hooks/format'
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

const TODO_V1 = [
  '# Old goal',
  '- [x] shipped',
  '- [ ] **left** over from `before`',
  '```',
  '- [ ] an example, not a task',
  '```',
  '## Brief via SMTP',
  '- [x] plan it',
  '- [ ] Store the [app password](https://example.com) in the Keychain',
  '- [ ] Worktree, tests, verifier',
].join('\n')

/** A promise the test releases: holds a tool call open the way a real launch
 * does, so what the call starts happens inside it. */
function gate() {
  let open = () => {}
  const shut = new Promise<void>(r => (open = r))
  return { shut, open }
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
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku')
    expect(modelFamily('claude-opus-5-5[1m]')).toBe('opus')
    expect(modelFamily('sonnet')).toBe('sonnet')
    expect(tierTally(['claude-opus-5', 'claude-haiku-4-5-20251001', 'haiku', 'claude-fable-5'])).toBe('haiku 2 · opus 1 · fable 1')
  })

  test('a bar fills its width exactly, with an eighth-block edge', () => {
    for (const pct of [0, 1, 31, 50, 99.9, 100]) {
      const { full, partial, empty } = barParts(pct, 10)
      expect(full.length + partial.length + empty.length).toBe(10)
    }
    expect(barParts(31, 10)).toEqual({ full: '███', partial: '▏', empty: '      ' })
  })

  test('a todo file gives its counts and its last open items under their headings; fences are not tasks', () => {
    const t = parseTodo(TODO_V1, 2)
    expect([t.open, t.done]).toEqual([3, 2])
    expect(t.items).toEqual([
      { section: 'Brief via SMTP', text: 'Store the app password in the Keychain' },
      { section: 'Brief via SMTP', text: 'Worktree, tests, verifier' },
    ])
    expect(parseTodo(TODO_V1, 9).items[0]).toEqual({ section: 'Old goal', text: 'left over from before' })
    expect(parseTodo('no checklist here', 5)).toEqual({ open: 0, done: 0, items: [] })
  })

  test("a workflow's name comes from a saved name or the script's meta", () => {
    expect(workflowName({ name: 'nightly' })).toBe('nightly')
    expect(workflowName({ script: "export const meta = {\n  name: 'review-changes',\n  description: 'x' }" })).toBe('review-changes')
    expect(workflowName({ script: 'agent("go")' })).toBeNull()
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
function session(on: On, opts: { usage?: Partial<typeof USAGE>; agents?: AgentInfo[]; todo?: () => string | undefined } = {}) {
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
  on('agent.list', () => ({ value: opts.agents ?? [] }))
  on('fs.read', ($, e) => {
    const text = e.path === '/repo/tasks/todo.md' ? opts.todo?.() : undefined
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
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
      // auto is the slim band: one filled row, no border rows
      const root = (await wide.drawn()) as { props?: Record<string, unknown> }
      expect(root.props?.borderStyle).toBeUndefined()
      expect(root.props?.backgroundColor).toBe('composerSidebarBackground')
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
        expect(await ui.find({ text: ` ${title} ` })).toBeDefined()
      }
      // titles ride the top border
      expect(await ui.find({ text: '╭─' })).toBeDefined()
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

  test('an agent shows the model its spawn resolved to, and how it runs', async ($, on) => {
    session(on, { agents: [{ id: 'ag1', type: 'scout', description: 'find the config', status: 'running' }] })
    // the call asks for opus; what starts (after any routing hook) is haiku
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'ag1' }))
    const held = gate()
    const reached = gate()
    on('tool.call', async ($, e) => {
      if (e.tool_use_id === 'tu1') {
        reached.open()
        await held.shut
      }
      return { result: {} } as never
    })
    await $.command.run(run('hud', 'status'))
    // the Agent call asks for a worktree; its spawn happens inside the call and
    // carries the same tool_use_id
    const call = $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: 'find the config', prompt: 'p', subagent_type: 'scout', isolation: 'worktree' } as never)
    await reached.shut
    const started = await $.agent.spawn({
      tool_use_id: 'tu1',
      prompt: 'p',
      description: 'find the config',
      subagentType: 'scout',
      model: 'opus',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5[1m]',
      background: true,
      fork: false,
    })
    held.open()
    await call
    expect(started.agentId).toBe('ag1')
    for (const surface of SURFACES) {
      const pane = await $.ui.mount({ plugin: 'hud', surface, ...PANE })
      expect(await pane.find({ text: ' haiku' })).toBeDefined()
      expect(await pane.find({ text: ' opus' })).toBeUndefined()
      expect(await pane.find({ text: ' ⎇' })).toBeDefined()
      await pane.unmount()
      const band = await $.ui.mount({ plugin: 'hud', surface, ...BAND(160) })
      expect(await band.find({ text: '1 agent' })).toBeDefined()
      expect(await band.find({ text: ' haiku 1' })).toBeDefined()
      await band.unmount()
    }
  })

  test("the repository's tasks/todo.md fills the Todo card, and a write to it redraws", async ($, on) => {
    let todo = TODO_V1
    session(on, { todo: () => todo })
    on('tool.call', () => ({ result: {} }) as never)
    await $.command.run(run('hud', 'status'))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'hud', surface, ...PANE })
      expect(await ui.find({ text: ' Todo ' })).toBeDefined()
      expect(await ui.find({ text: ' 3 open ' })).toBeDefined()
      expect(await ui.find({ text: 'Brief via SMTP' })).toBeDefined()
      expect(await ui.find({ text: 'Worktree, tests, verifier' })).toBeDefined()
      expect(await ui.find({ text: 'an example, not a task' })).toBeUndefined()
      await ui.unmount()
    }
    todo = `${TODO_V1}\n- [ ] Rebuild the sidecar`
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/repo/tasks/todo.md', old_string: 'a', new_string: 'b' } as never)
    const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: ' 4 open ' })).toBeDefined()
    expect(await ui.find({ text: 'Rebuild the sidecar' })).toBeDefined()
    await ui.unmount()
  })

  test("a workflow run's agents fill the Workflow card and the band, and close as their loops complete", async ($, on) => {
    session(on)
    let n = 0
    on('agent.spawn', () => ({ model: n++ === 0 ? 'claude-haiku-4-5-20251001' : 'claude-opus-5', agentId: `wa${n}` }))
    on('tool.call', () => ({ result: {} }) as never)
    await $.command.run(run('hud', 'status'))
    await $.turn.start({ text: 'review it', turnId: 'main' })
    const script = "export const meta = { name: 'review-changes', description: 'Review the diff' }\nawait agent('look')"
    await $.tool.call({ tool: 'Workflow', tool_use_id: 'wf1', script } as never)
    const spawn = (description: string, subagentType: string, agentIndex: number) =>
      $.agent.spawn({
        tool_use_id: 'wf1',
        prompt: 'p',
        description,
        subagentType,
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'claude-opus-5-5[1m]',
        background: true,
        fork: false,
        workflow: { runId: 'wf_run1', agentIndex },
      })
    await spawn('find callers', 'scout', 1)
    await spawn('check the fix', 'verifier', 2)
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'x1', agentId: 'wa1', reason: 'end_turn' } as never)
    for (const surface of SURFACES) {
      const pane = await $.ui.mount({ plugin: 'hud', surface, ...PANE })
      expect(await pane.find({ text: ' Workflow ' })).toBeDefined()
      expect(await pane.find({ text: ' 1 / 2 ' })).toBeDefined()
      expect(await pane.find({ text: 'review-changes' })).toBeDefined()
      expect(await pane.find({ text: ' opus' })).toBeDefined()
      expect(await pane.find({ text: ' check the fix' })).toBeDefined()
      await pane.unmount()
      const band = await $.ui.mount({ plugin: 'hud', surface, ...BAND(160) })
      expect(await band.find({ text: '1 agent' })).toBeDefined()
      expect(await band.find({ text: ' opus 1' })).toBeDefined()
      await band.unmount()
    }
    // a main-loop turn's completion is no workflow agent's
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'main', reason: 'end_turn' } as never)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'x2', agentId: 'wa2', reason: 'end_turn' } as never)
    const pane = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...PANE })
    expect(await pane.find({ text: ' 2 / 2 ' })).toBeDefined()
    expect(await pane.find({ text: '✗ ' })).toBeDefined()
    await pane.unmount()
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
