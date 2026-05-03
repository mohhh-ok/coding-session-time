# coding-session-time

Time analytics for local coding-agent sessions.

`coding-session-time` reads session transcripts from Claude Code under `~/.claude/projects/` and from Codex under `~/.codex/sessions/`, then reports **working time** by project (the directory the session was opened in) and by day.

It is published on npm as `claude-code-time`; the CLI command is also `claude-code-time`. It does not track normal desktop or web chat history.

This is **not** a token-usage or cost tracker — for that, see [`ccusage`](https://www.npmjs.com/package/ccusage).

## Use it from Claude Code or Codex (recommended)

This repo ships a skill so an agent can answer worktime questions for you (e.g. "how much did I work today?", "top projects this month"). Install it with [`npx skills`](https://www.npmjs.com/package/skills):

```bash
npx skills add mohhh-ok/coding-session-time         # project scope
npx skills add mohhh-ok/coding-session-time -g      # global (user scope)
```

The skill calls the `claude-code-time` CLI under the hood, so install it too (`npm i -g claude-code-time@latest`) — or it will fall back to `npx claude-code-time@latest`.

### Example prompts

Once the skill is installed, you can ask Claude Code things like:

```
How much did I work today?
How long did I spend on this project last week?
Top 5 projects this month by time spent.
Give me a daily breakdown for the last 30 days.
How many hours did I put into myrepo in April?
Compare this week vs last week.
Was yesterday a heavy Claude Code day?
```

The skill picks the right `claude-code-time` flags (`--today`, `--this-week`, `--here`, `--project`, `--total`, etc.) based on your question and reports back a concise answer.

## Install / Usage (CLI directly)

```bash
npx claude-code-time@latest
```

or

```bash
npm i -g claude-code-time@latest
claude-code-time
```

## Examples

```bash
claude-code-time                            # Claude Code, last 14 days, daily breakdown + project totals
claude-code-time --source claude            # Claude Code sessions only
claude-code-time --source codex             # Codex sessions
claude-code-time --source all               # Claude Code + Codex sessions
claude-code-time --days 7
claude-code-time --today
claude-code-time --yesterday
claude-code-time --this-week
claude-code-time --last-week
claude-code-time --this-month
claude-code-time --since 2026-04-01 --until 2026-04-30
claude-code-time --here                     # filter to the current project (or its ancestor session)
claude-code-time --project myrepo           # filter by substring of the project path
claude-code-time --idle 5m                  # treat 5+ min gaps as idle (focus-time mode)
claude-code-time --total --top 5            # skip daily breakdown, show top 5 projects
claude-code-time --json                     # JSON output
```

## How working time is computed

`claude-code-time` treats every user prompt, assistant turn, and tool result as an **activity event**. Within a single project on a single day, it sums the gaps between consecutive activity events. Any gap longer than `--idle` (default `10m`) is treated as "away" and replaced by a fixed tail of `--tail` (default `1m`). A tail is also added after the last event of the day.

Because assistant turns count as activity, long autonomous tasks (where you've sent one prompt and Claude is working for 20 minutes) are counted as work time rather than misclassified as idle.

The `prompts` column still counts only user-typed prompts, not assistant or tool messages.

Caveats:

- Interval-based, so the time spent thinking *before* the first event and working *after* the last event is not counted (tends to under-report).
- If you walk away while Claude is running a long task, that time will still be counted as long as the assistant is generating events (tends to over-report). Lower `--idle` to push back against this; raise `--idle` to forgive shorter breaks.

## Options

| Option | Description |
| --- | --- |
| `--days <n>` | Last N days (default: 14) |
| `--since <YYYY-MM-DD>` | Range start |
| `--until <YYYY-MM-DD>` | Range end |
| `--today` / `--yesterday` | Shortcut |
| `--this-week` / `--last-week` | Shortcut (week starts Monday) |
| `--this-month` / `--last-month` | Shortcut |
| `--project <pattern>` | Filter by substring of the project path |
| `--here` | Filter to the current working directory's project (matches the deepest session start dir that is an ancestor of cwd) |
| `--idle <dur>` | Idle threshold (`600`, `10m`, `1h`) |
| `--tail <dur>` | Tail seconds added per cluster |
| `--total` | Skip daily breakdown, project totals only |
| `--top <n>` | Show only top N projects in totals |
| `--json` | JSON output |
| `--tz <tz>` | Timezone (defaults to `$TZ`, then the system timezone) |
| `--source <source>` | History source: `claude`, `codex`, or `all` (default: `claude`) |
| `--codex` | Shortcut for `--source codex` |
| `--projects-dir <path>` | Path to the `~/.claude/projects` directory |
| `--codex-sessions-dir <path>` | Path to the `~/.codex/sessions` directory |

## Acknowledgements

Inspired by [ccusage](https://github.com/ryoppippi/ccusage).

## License

MIT
