# claude-code-hud

A heads-up display for the Claude Code terminal that makes it read more like an app:

- a **band above the prompt** with the numbers worth a glance: model, context, rate limits with reset countdowns, session cost, git branch and the running turn
- an **inspector pane** docked beside the transcript, made of rounded cards: Session, Context, Usage, Activity, Tasks, Agents and Files (a card with nothing to say stays hidden)
- optional **Notion-style replies**: bullets, to-dos, quote bars, callouts and inline-code pills instead of raw markdown punctuation
- two **Notion themes** (dark and light) for Claude Code itself

It is a Claude Code *mod*: a plugin of function hooks that runs inside Claude Code and hot-reloads when you edit it.

```
╭──────────────────────────────────────────────────────────────────────────────────╮
│ ● Opus 5.5 1M   ctx ▋      10%   5h ██▎    22% ↻1h29m   7d 12%   $0.75   ⎇ main ±5 │
╰──────────────────────────────────────────────────────────────────────────────────╯
```

```
╭─ Session ──────────────────────╮     ╭─ Activity ──────── 6 this turn ─╮
│ my-app          ⎇ main ↑1 ↓0   │     │ ◐ Bash  npm test           0:42 │
│ Opus 5.5 1M     12 tool calls  │     │ ✓ Edit  state.ts                │
│ 3 changed            1 staged  │     │ ✓ Read  tokens.css ×3           │
╰────────────────────────────────╯     │ ✗ Bash  git push             3s │
╭─ Context ────────── 312k / 1M ─╮     ╰─────────────────────────────────╯
│ █████████▍░░░░░░░░░░░░░    31% │     ╭─ Tasks ────────────────── 1 / 3 ─╮
│ msgs 210k  tools 61k  mem 18k  │     │ ✓ Read the spec                 │
│ autocompact             at 97% │     │ ◐ Writing the plan              │
╰────────────────────────────────╯     │ ○ Verify                        │
                                       ╰─────────────────────────────────╯
```

(Illustrative layout. In the terminal each card title sits on its first row, and colours follow your Claude Code theme.)

## Requirements

- Claude Code **2.1.289 or later**. The function-hooks plugin API is early access and can change between releases; this mod was built and tested on 2.1.289.
- Any terminal. The docked pane, hover and clicks need the fullscreen renderer (`"tui": "fullscreen"` in settings). Without it the pane opens inline above the prompt.

## Install

Clone it anywhere. `~/.claude/mods/hud` is a good home:

```sh
git clone https://github.com/contactdharsan-blip/claude-code-hud ~/.claude/mods/hud
```

**Try it for one session:**

```sh
claude --plugin-dir ~/.claude/mods/hud
```

**Load it in every session.** Add the folder to the `env` block of `~/.claude/settings.json`, then start a new session:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/.claude/mods/hud"
  }
}
```

If you already list plugin folders there, separate them with `:` (macOS, Linux) or `;` (Windows).

Check it loaded with `/hud status`.

## Commands

| Command | What it does |
|---|---|
| `/hud` | Open or close the inspector pane |
| `/hud band auto\|full\|compact\|minimal\|off` | Band size. `auto` picks by width and drops the least important numbers first; context is kept last |
| `/hud auto on\|off` | Open the pane by itself at startup (it seats from 144 columns; `/hud` opens it at any width) |
| `/hud notion on\|off` | Draw Claude's replies Notion-style (off by default) |
| `/hud bubble on\|off` | Put your own prompts in a rounded bubble (off by default) |
| `/hud status` | Show the current settings |

Preferences persist across sessions. When the band is off, the two most useful numbers (context and the five-hour limit) move to the end of the hint line under the prompt.

## The Notion look (optional)

Four independent pieces. Use any of them.

1. **Replies.** `/hud notion on`. Headings lose their `#`, lists get `•` `◦` `▪` with hanging indents, `- [ ]` and `- [x]` become `☐` and `☑` (done items struck through), quotes get a grey bar, GitHub alerts (`> [!TIP]`) and emoji-led quotes become filled callouts, and inline code becomes a pill. Code blocks and tables are left to Claude Code's own renderer, which highlights and aligns them better.
2. **Theme.** Copy a theme and select it:
   ```sh
   mkdir -p ~/.claude/themes && cp ~/.claude/mods/hud/extras/themes/notion-*.json ~/.claude/themes/
   ```
   ```json
   { "theme": "custom:notion-dark" }
   ```
   or `custom:notion-light`. Both override only colours (Notion's palette) on top of the built-in dark and light themes.
3. **Prose width.** `"maxProseWidth": 80` in settings wraps prose to a readable column, like a Notion page. The Notion-style replies use the same width.
4. **Font.** Notion's own "Mono" page style uses [iA Writer Mono](https://github.com/iaolo/iA-Fonts) (SIL Open Font License). Set it in your terminal with a line height around 1.3.

A terminal draws text in one size, so headings stand out by weight, colour and spacing rather than size.

## What it reads, and what it costs

- **No network and no model calls.** Context, rate limits and cost come from the session's own figures. The context breakdown uses Claude Code's local estimate, which sends no requests.
- **Git, read-only:** `rev-parse`, `status --porcelain=v2` and `diff --numstat HEAD`, always with `--no-optional-locks`, so it never takes the index lock from under a git command Claude is running. It runs at startup, at the end of each turn, and shortly after an edit or shell command. Never on an idle timer.
- **Headless runs (`claude -p`, scripts, CI)** load the mod but it stays passive until something draws, so they pay only a few pass-through hooks.
- **Timers:** one, ticking every second while a turn or an agent runs (for elapsed times) and every 30 seconds otherwise (for reset countdowns).

## Develop

The mod hot-reloads in any interactive session that loaded it, when you save a file.

```sh
claude plugin validate ~/.claude/mods/hud   # what it hooks and calls, and anything the engine would refuse
claude plugin test ~/.claude/mods/hud       # the tests in tests/, on the terminal and desktop surfaces
```

Layout: `hooks/register.tsx` wires events and holds the collectors and state (the engine's static checks require `$` and state atoms to stay in that one file). `hooks/view.tsx` draws, `hooks/format.ts` and `hooks/notion.ts` are pure formatting and parsing, `hooks/theme.ts` holds every colour (Claude Code theme keys only, so light and dark both work), and `types/index.d.ts` is the state contract.

## Uninstall

Remove the `CLAUDE_CODE_PLUGIN_DIRS` entry (and the theme line, if you set one), then delete the folder.

## License

MIT
