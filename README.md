# coding-session-time

Time analytics for local coding-agent sessions.

`coding-session-time` reads session transcripts from Claude Code under `~/.claude/projects/` and from Codex under `~/.codex/sessions/`, then reports **working time** by project (the directory the session was opened in) and by day.

The supported way to use it is the **skill** (below). It was also published on npm as `claude-code-time`, but that package is now **deprecated and unmaintained** — use the skill instead. It does not track normal desktop or web chat history.

This is **not** a token-usage or cost tracker — for that, see [`ccusage`](https://www.npmjs.com/package/ccusage).

## Use it from Claude Code or Codex (recommended)

This repo ships a skill so an agent can answer worktime questions for you (e.g. "how much did I work today?", "top projects this month"). Install it with [`npx skills`](https://www.npmjs.com/package/skills):

```bash
npx skills add mohhh-ok/coding-session-time         # project scope
npx skills add mohhh-ok/coding-session-time -g      # global (user scope)
```

The skill is **self-contained**: it ships a prebuilt `claude-code-time` bundle (`bin/coding-session-time.js`) pinned to the skill's version and runs it with `node`. It does not download anything at runtime, so there is no `npx @latest` step that could pull unreviewed code. You do not need to install the CLI separately.

You do not need the npm package — it is deprecated (see below).

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

> [!WARNING]
> The npm package `claude-code-time` is **deprecated and unmaintained**. Use the [skill](#use-it-from-claude-code-or-codex-recommended) above, which ships its own pinned copy of the CLI. Installing from npm with `npx ...@latest` auto-executes whatever is currently latest on the registry, which is exactly the supply-chain risk this project moved away from.

If you still want the CLI in your terminal, build it from source rather than installing from npm:

```bash
git clone https://github.com/mohhh-ok/coding-session-time
cd coding-session-time
bun install && bun run build
node dist/index.js            # then pass any flags from the Examples below
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
claude-code-time --no-group-worktrees       # keep git worktree sessions as separate projects
claude-code-time --idle 5m                  # treat 5+ min gaps as idle (focus-time mode)
claude-code-time --total --top 5            # skip daily breakdown, show top 5 projects
claude-code-time --json                     # JSON output
```

## How working time is computed

`claude-code-time` treats every user prompt, assistant turn, and tool result as an **activity event**. Within a single project on a single day, it sums the gaps between consecutive activity events. Any gap longer than `--idle` (default `10m`) is treated as "away" and replaced by a fixed tail of `--tail` (default `1m`). A tail is also added after the last event of the day.

Because assistant turns count as activity, long autonomous tasks (where you've sent one prompt and Claude is working for 20 minutes) are counted as work time rather than misclassified as idle.

The `prompts` column still counts only user-typed prompts, not assistant or tool messages.

### Git worktrees

By default, sessions opened in a git worktree are attributed to the worktree's **main repository**, so all worktrees of the same repo roll up into one project.

- Claude Code worktrees (`<repo>/.claude/worktrees/<name>`) are matched by path, so they fold into `<repo>` **even after the worktree has been removed** from disk.
- Other git worktrees are detected by running `git` against the session's start directory, which requires that directory to still exist on disk (a removed non-Claude worktree stays under its original path).

The main worktree and its subdirectories are left as-is. Pass `--no-group-worktrees` to keep every worktree as its own project.

Merging can lower the grand total slightly versus keeping worktrees separate: events from different worktrees of the same repo on the same day re-cluster together, so overlapping idle/tail padding is counted once instead of once per worktree.

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
| `--no-group-worktrees` | Keep git worktree sessions separate instead of merging them into their main repository (grouping is on by default) |
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
