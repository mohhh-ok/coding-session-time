# cctime

Time analytics for Claude Code — see how much time you spent in each project.

`cctime` reads `~/.claude/history.jsonl` (the prompt log Claude Code writes automatically) and reports **working time** by project (the directory the session was opened in) and by day.

This is **not** a token-usage or cost tracker — for that, see [`ccusage`](https://www.npmjs.com/package/ccusage).

## Install / Usage

```bash
npx cctime
```

or

```bash
npm i -g cctime
cctime
```

## Examples

```bash
cctime                            # last 14 days, daily breakdown + project totals
cctime --days 7
cctime --today
cctime --yesterday
cctime --this-week
cctime --last-week
cctime --this-month
cctime --since 2026-04-01 --until 2026-04-30
cctime --project billionclips     # filter by substring of the project path
cctime --idle 5m                  # treat 5+ min gaps as idle (focus-time mode)
cctime --total --top 5            # skip daily breakdown, show top 5 projects
cctime --json                     # JSON output
```

## How working time is computed

Within a single project on a single day, `cctime` sums the gaps between consecutive prompts. Any gap longer than `--idle` (default `10m`) is treated as "away" and replaced by a fixed tail of `--tail` (default `1m`). A tail is also added for the last prompt of the day.

Caveats:

- Interval-based, so the time spent thinking *before* the first prompt and working *after* the last prompt is not counted (tends to under-report).
- Time spent waiting for long tool calls is counted (tends to over-report).
- Lower `--idle` → focus-time bias. Higher `--idle` → presence-time bias.

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
| `--idle <dur>` | Idle threshold (`600`, `10m`, `1h`) |
| `--tail <dur>` | Tail seconds added per prompt |
| `--total` | Skip daily breakdown, project totals only |
| `--top <n>` | Show only top N projects in totals |
| `--json` | JSON output |
| `--tz <tz>` | Timezone (default: `Asia/Tokyo`) |
| `--path <path>` | Path to `history.jsonl` |

## Acknowledgements

Inspired by [ccusage](https://github.com/ryoppippi/ccusage).

## License

MIT
