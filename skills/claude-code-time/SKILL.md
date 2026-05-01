---
name: claude-code-time
description: Inspect Claude Code worktime — how long the user spent in each project, by day or as totals. Use when the user asks about their Claude Code work hours, time tracking, daily/weekly/monthly worktime, or per-project time spent. Triggers include phrasing like "how much time did I spend", "how long did I work today", "this week's worktime", "time tracking", "hours on this project". NOT for token usage, cost, or billing — this is wall-clock time only.
---

# claude-code-time

`claude-code-time` is a CLI that reads session transcripts from `~/.claude/projects/` and reports how much time the user spent in each project, broken down by day and as totals. Time is computed by clustering activity events (user prompts plus assistant turns and tool results) within an idle threshold (default 10m) and adding a tail per cluster (default 1m). Using assistant turns as activity signal means long autonomous tasks aren't misclassified as idle time.

## When to use

Use when the user asks anything about how much time they spent using Claude Code: today, this week, last month, on a specific project, etc. Always prefer this over guessing or asking the user to count manually.

Do NOT use for:
- Token usage, API costs, or billing — `claude-code-time` measures wall-clock time only.
- Real-time monitoring — `claude-code-time` reads a static history file.

## How to invoke

Always use `--json` so you can parse the output. The `claude-code-time` binary should be on PATH after `npm i -g claude-code-time`; if it isn't, fall back to `npx claude-code-time`.

```bash
claude-code-time --json [flags]
```

JSON shape — array of rows, one per (date, project):

```json
[
  { "date": "2026-05-01", "project": "/Users/foo/Dev/bar", "prompts": 26, "seconds": 1405.76 }
]
```

`seconds` is wall-clock time attributed to that project on that date. `project` is the absolute session-start directory.

## Common flags

Range (pick at most one):
- `--today` / `--yesterday`
- `--this-week` / `--last-week` (week starts Monday)
- `--this-month` / `--last-month`
- `--days <n>` — last N days including today (default 14)
- `--since <YYYY-MM-DD> --until <YYYY-MM-DD>` — explicit range

Filtering / shaping:
- `--here` — filter to the current working directory's project (matches the deepest session start dir that is an ancestor of cwd). Use this when the user asks about "this project" / "this repo" / "the project I'm in".
- `--project <substring>` — filter by substring of project path
- `--total` — skip the daily breakdown, return project totals only
- `--top <n>` — keep only top N projects in totals
- `--idle <dur>` — idle threshold (default `10m`; accepts `600`, `10m`, `1h`)
- `--tail <dur>` — tail seconds added per prompt (default `1m`)
- `--tz <tz>` — IANA timezone (defaults to `$TZ` then system timezone)

## Workflow

1. Pick the narrowest range flag that matches the user's question (`--today`, `--this-week`, `--days 30`, etc.). Don't dump 14 days when they asked about today.
2. Run `claude-code-time --json <flags>` and parse the array.
3. Aggregate / sort as needed:
   - Total seconds across rows for a grand total.
   - Group by `project` for per-project totals.
   - Group by `date` for daily totals.
4. Format times for the user: `Xh Ym` for ≥1 hour, `Ym` otherwise. Round to the minute.
5. Report concisely. A single number ("2h32m today") is usually better than a table unless the user asked for a breakdown.

## Examples

User: "How much did I work today?"
→ `claude-code-time --today --json` → sum `seconds` → "2h32m today (148 prompts)."

User: "How long did I spend on this project last week?"
→ `claude-code-time --last-week --here --json` → sum → "6h12m on this project last week."

User: "Top projects this month"
→ `claude-code-time --this-month --total --top 5 --json` → already aggregated by project, sort by `seconds` desc → list top 5.

User: "Daily breakdown for the last 30 days"
→ `claude-code-time --days 30 --json` → group by `date` → daily list.

## Notes

- If the JSON array is empty, the user simply has no Claude Code activity in that range. Say so plainly; don't speculate.
- `prompts` is a useful sanity check (very high `seconds` with very low `prompts` usually means a long idle window the algorithm couldn't split — flag it if it looks off).
- Session transcripts live under `~/.claude/projects/`. Override with `--projects-dir` only if the user explicitly points elsewhere.
