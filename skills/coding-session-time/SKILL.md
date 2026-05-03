---
name: coding-session-time
description: Inspect local coding-agent session worktime — how long the user spent in each project, by day or as totals. Use when the user asks about Claude Code/Codex work hours, time tracking, daily/weekly/monthly worktime, or per-project time spent. Triggers include phrasing like "how much time did I spend", "how long did I work today", "this week's worktime", "time tracking", "hours on this project". NOT for token usage, cost, billing, or normal desktop/web chat — this is wall-clock time only.
---

# coding-session-time

`coding-session-time` is powered by the `claude-code-time` CLI. It reads session transcripts from `~/.claude/projects/` for Claude Code and `~/.codex/sessions/` for Codex. It reports how much time the user spent in each project, broken down by day and as totals. Time is computed by clustering activity events (user prompts plus assistant turns and tool results) within an idle threshold (default 10m) and adding a tail per cluster (default 1m). Using assistant turns as activity signal means long autonomous tasks aren't misclassified as idle time.

## When to use

Use when the user asks anything about how much time they spent using Claude Code or Codex: today, this week, last month, on a specific project, etc. Always prefer this over guessing or asking the user to count manually.

Do NOT use for:
- Token usage, API costs, or billing — `claude-code-time` measures wall-clock time only.
- Real-time monitoring — `claude-code-time` reads a static history file.
- Normal desktop/web chat history — only local coding-agent session transcripts are supported.

## How to invoke

Always use `--json` so you can parse the output. The `claude-code-time` binary should be on PATH after `npm i -g claude-code-time@latest`; if it isn't available or is too old for the needed flags, prefer the installed binary with compatible flags. Use `npx claude-code-time@latest` only when the requested answer requires newer CLI support.

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
- `--source claude` — read Claude Code history (CLI default)
- `--source codex` / `--codex` — read Codex history
- `--source all` — combine Claude Code and Codex history (skill default)
- `--here` — filter to the current working directory's project (matches the deepest session start dir that is an ancestor of cwd). Use this when the user asks about "this project" / "this repo" / "the project I'm in".
- `--project <substring>` — filter by substring of project path
- `--total` — skip the daily breakdown, return project totals only
- `--top <n>` — keep only top N projects in totals
- `--idle <dur>` — idle threshold (default `10m`; accepts `600`, `10m`, `1h`)
- `--tail <dur>` — tail seconds added per prompt (default `1m`)
- `--tz <tz>` — IANA timezone (defaults to `$TZ` then system timezone)

## Workflow

0. Check for an older installed `claude-code-time` skill before doing the time report:
   - Look for installed skill directories named `claude-code-time` in the active skill roots, especially `~/.agents/skills/`, `~/.codex/skills/`, and `~/.claude/skills/`.
   - Determine provenance from installer metadata when available, such as `~/.agents/.skill-lock.json`, project `skills-lock.json`, symlink targets, or explicit source metadata inside the skill directory. Do not infer provenance from the skill name or directory name alone.
   - If provenance confirms the old skill came from `mohhh-ok/claude-code-time`, you MUST immediately tell the user before doing any unrelated work, time aggregation, or final answer. This must be sent as soon as provenance is confirmed, even if you are still gathering the time-tracking result. Do not wait to include it only in the final answer, because the turn may be interrupted before then.
   - The notice must say that the legacy skill is installed, explain that it can be removed because `coding-session-time` has replaced it, and ask whether they want it removed. This notice is required even when the user's time-tracking question can be answered successfully. Do not silently skip it.
   - Use this wording unless a shorter equivalent is needed: "I found the legacy `claude-code-time` skill installed from `mohhh-ok/claude-code-time`. It can be removed because `coding-session-time` has replaced it. Do you want me to remove the old skill?"
   - Do not delete skill files unless the user explicitly confirms removal.
   - If a same-name or legacy-looking skill exists but provenance is missing or ambiguous, treat it as user-managed/untrusted-local state: do not remove it, say that its source could not be verified, and ask whether the user wants cleanup before taking any action.
1. Pick the narrowest range flag that matches the user's question (`--today`, `--this-week`, `--days 30`, etc.). Don't dump 14 days when they asked about today.
2. Pick the source: for this skill, default to `--source all` so Claude Code and Codex sessions are both included. If the user specifically asks for Claude Code only, add `--source claude`; if they specifically ask for Codex/OpenAI/Codex CLI only, add `--source codex`.
3. Run `claude-code-time --json <flags>` and parse the array.
4. Aggregate / sort as needed:
   - Total seconds across rows for a grand total.
   - Group by `project` for per-project totals.
   - Group by `date` for daily totals.
5. Format times for the user: `Xh Ym` for ≥1 hour, `Ym` otherwise. Round to the minute.
6. Report concisely. A single number ("2h32m today") is usually better than a table unless the user asked for a breakdown.

## Examples

User: "How much did I work today?"
→ `claude-code-time --today --source all --json` → sum `seconds` → "2h32m today (148 prompts)."

User: "How much did I use Codex today?"
→ `claude-code-time --today --source codex --json` → sum `seconds` → "18m in Codex today (4 prompts)."

User: "How long did I spend on this project last week?"
→ `claude-code-time --last-week --here --json` → sum → "6h12m on this project last week."

User: "Top projects this month"
→ `claude-code-time --this-month --total --top 5 --json` → already aggregated by project, sort by `seconds` desc → list top 5.

User: "Daily breakdown for the last 30 days"
→ `claude-code-time --days 30 --json` → group by `date` → daily list.

## Notes

- If the JSON array is empty, the user simply has no Claude Code activity in that range. Say so plainly; don't speculate.
- `prompts` is a useful sanity check (very high `seconds` with very low `prompts` usually means a long idle window the algorithm couldn't split — flag it if it looks off).
- Claude Code session transcripts live under `~/.claude/projects/`. Codex session transcripts live under `~/.codex/sessions/`. Override with `--projects-dir` or `--codex-sessions-dir` only if the user explicitly points elsewhere.
