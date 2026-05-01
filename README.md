# claude-code-time

Time analytics for Claude Code — see how much time you spent in each project.

`claude-code-time` reads the session transcripts under `~/.claude/projects/` (which Claude Code writes automatically) and reports **working time** by project (the directory the session was opened in) and by day.

This is **not** a token-usage or cost tracker — for that, see [`ccusage`](https://www.npmjs.com/package/ccusage).

## Install / Usage

```bash
npx claude-code-time
```

or

```bash
npm i -g claude-code-time
claude-code-time
```

## Examples

```bash
claude-code-time                            # last 14 days, daily breakdown + project totals
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
| `--projects-dir <path>` | Path to the `~/.claude/projects` directory |

## Skill for Claude Code

This repo ships a [Claude Code skill](https://skills.sh/) that teaches an agent when and how to invoke `claude-code-time` to answer worktime questions. Install it with [`npx skills`](https://www.npmjs.com/package/skills):

```bash
npx skills add mohhh-ok/claude-code-time         # project scope
npx skills add mohhh-ok/claude-code-time -g      # global (user scope)
```

The skill assumes `claude-code-time` is on PATH (`npm i -g claude-code-time`) and falls back to `npx claude-code-time` otherwise.

## Acknowledgements

Inspired by [ccusage](https://github.com/ryoppippi/ccusage).

## License

MIT
