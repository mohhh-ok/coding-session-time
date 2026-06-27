import { readFileSync, existsSync, readdirSync, statSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import pkg from "../package.json";

export type Event = { ts: number; project: string; isUserPrompt: boolean };
export type Row = { date: string; project: string; prompts: number; seconds: number };

// Per-file parse result, keyed by absolute path in FileCache. `events` is the full
// unfiltered output of the parser for the file; since/until filtering happens at
// query time so the cache is independent of the requested range.
export type SessionFileData = {
  mtimeMs: number;
  project: string | null;
  events: { ts: number; isUserPrompt: boolean }[];
};
export type FileCache = Map<string, SessionFileData>;

// Bump when parser semantics change, so old on-disk caches are discarded.
const CACHE_VERSION = 1;

const DEFAULT_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const DEFAULT_CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
type Source = "claude" | "codex" | "all";

export function defaultCachePath(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "coding-session-time", "cache.json");
}

export function loadFileCache(path: string): FileCache {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return new Map();
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!obj || typeof obj !== "object") return new Map();
  const o = obj as { version?: number; files?: Record<string, SessionFileData> };
  if (o.version !== CACHE_VERSION || !o.files || typeof o.files !== "object") return new Map();
  return new Map(Object.entries(o.files));
}

export function saveFileCache(path: string, cache: FileCache): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(cache) }));
}

/**
 * Build a commander option collector for repeatable directory flags.
 *
 * Commander gives each `--flag` option a single default value; for repeatable
 * options we want the default to apply only when the user passes nothing. The
 * first time the user supplies the flag we discard the default and start from
 * the user's value(s); subsequent invocations append. Each value may also be
 * comma-separated, so `--projects-dir A,B --projects-dir C` yields `[A, B, C]`.
 */
export function makeDirCollector(): (value: string, previous: string[]) => string[] {
  let customized = false;
  return (value: string, previous: string[]): string[] => {
    const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
    if (!customized) {
      customized = true;
      return parts;
    }
    return [...previous, ...parts];
  };
}

export function parseDuration(input: string, fallbackUnit: "s" | "m" = "s"): number {
  const m = input.trim().match(/^(\d+(?:\.\d+)?)([smh]?)$/i);
  if (!m) throw new Error(`invalid duration: ${input}`);
  const n = Number(m[1]);
  const unit = (m[2] || fallbackUnit).toLowerCase();
  return unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n;
}

function isRealUserPrompt(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as { type?: string } | undefined;
    return !!first && first.type !== "tool_result";
  }
  return false;
}

// Pure parser: extracts every event the project format produces from a single
// jsonl file. No since/until filtering — that is applied at the caller after the
// cache lookup, so cached output is range-independent.
function parseProjectJsonl(filePath: string, mtimeMs: number): SessionFileData {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { mtimeMs, project: null, events: [] };
  }
  const events: { ts: number; isUserPrompt: boolean }[] = [];
  let project: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let r: {
      type?: string;
      cwd?: string;
      timestamp?: string;
      isSidechain?: boolean;
      message?: { content?: unknown };
    };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (project === null && typeof r.cwd === "string") project = r.cwd;
    if (r.type !== "user" && r.type !== "assistant") continue;
    if (typeof r.timestamp !== "string") continue;
    const ts = Date.parse(r.timestamp) / 1000;
    if (!Number.isFinite(ts)) continue;
    // Subagent transcripts replay the parent's instruction as a `user` line
    // (isSidechain: true); count it as activity but not as a human prompt.
    const isUserPrompt = r.type === "user" && r.isSidechain !== true && isRealUserPrompt(r.message?.content);
    events.push({ ts, isUserPrompt });
  }
  return { mtimeMs, project, events };
}

export function loadEventsFromProjects(
  dir: string,
  opts?: { since?: string; until?: string; tz?: string; cache?: FileCache },
): Event[] {
  const out: Event[] = [];
  let subs: string[];
  try {
    subs = readdirSync(dir);
  } catch {
    return out;
  }
  // Skip files whose mtime is more than 24h before `since`. We use UTC midnight of `since`
  // and subtract a day of slack so any timezone could still pull events into range.
  const sinceCutoffSec =
    opts?.since != null ? Date.parse(opts.since + "T00:00:00Z") / 1000 - 86400 : -Infinity;
  const tz = opts?.tz ?? "UTC";
  const since = opts?.since;
  const until = opts?.until;
  const cache = opts?.cache;

  for (const sub of subs) {
    const subPath = join(dir, sub);
    // Session transcripts sit directly under the project dir; subagent transcripts
    // are nested at <session-id>/subagents/agent-*.jsonl, so walk recursively.
    for (const filePath of listJsonlFilesRecursive(subPath)) {
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      if (st.mtimeMs / 1000 < sinceCutoffSec) continue;

      let data: SessionFileData;
      const cached = cache?.get(filePath);
      if (cached && cached.mtimeMs === st.mtimeMs) {
        data = cached;
      } else {
        data = parseProjectJsonl(filePath, st.mtimeMs);
        cache?.set(filePath, data);
      }
      if (!data.project) continue;
      const project = data.project;
      for (const e of data.events) {
        if (since || until) {
          const d = dateKey(e.ts, tz);
          if (since && d < since) continue;
          if (until && d > until) continue;
        }
        out.push({ ts: e.ts, project, isUserPrompt: e.isUserPrompt });
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function listJsonlFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // for-loop push instead of spread: large arrays would blow the JS engine's
      // apply-arg limit and throw `Maximum call stack size exceeded`.
      for (const f of listJsonlFilesRecursive(p)) out.push(f);
    } else if (entry.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function inRange(ts: number, since: string | undefined, until: string | undefined, tz: string): boolean {
  if (!since && !until) return true;
  const d = dateKey(ts, tz);
  return (!since || d >= since) && (!until || d <= until);
}

function isCodexActivityEvent(r: {
  type?: string;
  payload?: { type?: string; role?: string };
}): { include: boolean; isUserPrompt: boolean } {
  const payloadType = r.payload?.type;
  if (r.type === "event_msg") {
    if (payloadType === "user_message") return { include: true, isUserPrompt: true };
    if (payloadType === "agent_message" || payloadType === "exec_command_end" || payloadType === "task_started") {
      return { include: true, isUserPrompt: false };
    }
    return { include: false, isUserPrompt: false };
  }
  if (r.type !== "response_item") return { include: false, isUserPrompt: false };
  if (payloadType === "message") return { include: r.payload?.role === "assistant", isUserPrompt: false };
  if (payloadType === "reasoning" || payloadType === "function_call" || payloadType === "function_call_output") {
    return { include: true, isUserPrompt: false };
  }
  return { include: false, isUserPrompt: false };
}

function parseCodexJsonl(filePath: string, mtimeMs: number): SessionFileData {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { mtimeMs, project: null, events: [] };
  }
  const events: { ts: number; isUserPrompt: boolean }[] = [];
  let project: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let r: {
      type?: string;
      timestamp?: string;
      payload?: { type?: string; role?: string; cwd?: string };
    };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (project === null && r.type === "session_meta" && typeof r.payload?.cwd === "string") {
      project = r.payload.cwd;
    }
    if (typeof r.timestamp !== "string") continue;
    const ts = Date.parse(r.timestamp) / 1000;
    if (!Number.isFinite(ts)) continue;
    const activity = isCodexActivityEvent(r);
    if (activity.include) events.push({ ts, isUserPrompt: activity.isUserPrompt });
  }
  return { mtimeMs, project, events };
}

export function loadEventsFromCodexSessions(
  dir: string,
  opts?: { since?: string; until?: string; tz?: string; cache?: FileCache },
): Event[] {
  const out: Event[] = [];
  const sinceCutoffSec =
    opts?.since != null ? Date.parse(opts.since + "T00:00:00Z") / 1000 - 86400 : -Infinity;
  const tz = opts?.tz ?? "UTC";
  const since = opts?.since;
  const until = opts?.until;
  const cache = opts?.cache;

  for (const filePath of listJsonlFilesRecursive(dir)) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(filePath);
    } catch {
      continue;
    }
    if (st.mtimeMs / 1000 < sinceCutoffSec) continue;

    let data: SessionFileData;
    const cached = cache?.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      data = cached;
    } else {
      data = parseCodexJsonl(filePath, st.mtimeMs);
      cache?.set(filePath, data);
    }
    if (!data.project) continue;
    const project = data.project;
    for (const e of data.events) {
      if (!inRange(e.ts, since, until, tz)) continue;
      out.push({ ts: e.ts, project, isUserPrompt: e.isUserPrompt });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Claude Code creates worktrees at `<repo>/.claude/worktrees/<name>`.
const CLAUDE_WORKTREE_MARKER = "/.claude/worktrees/";

/**
 * Resolve a session cwd to its canonical project path, merging git worktrees
 * into their main repository root.
 *
 * First match Claude Code's `<repo>/.claude/worktrees/<name>` layout by path,
 * so the worktree folds into `<repo>` even after it has been removed from disk
 * (git can no longer resolve a directory that is gone). Otherwise ask git: a
 * linked worktree has a per-worktree git dir (`.git/worktrees/<name>`) that
 * differs from the shared common dir (`<main>/.git`), so we map it to the
 * directory holding that common dir. Returns the input unchanged when the path
 * is not a worktree, is the main worktree (or a subdirectory of it), or is a
 * non-Claude worktree that no longer exists on disk.
 */
export function resolveWorktreeRoot(path: string): string {
  const marker = path.indexOf(CLAUDE_WORKTREE_MARKER);
  if (marker !== -1) return path.slice(0, marker);

  let out: string;
  try {
    out = execFileSync(
      "git",
      ["-C", path, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return path;
  }
  const [gitDir, commonDir] = out.split("\n").map((s) => s.trim());
  if (!gitDir || !commonDir || gitDir === commonDir) return path;
  return dirname(commonDir);
}

/**
 * Rewrite each event's project to its canonical repository root, so linked
 * worktree sessions are attributed to the main repository. `resolve` is
 * injected for testability; results are cached per unique path to avoid
 * spawning git once per event.
 */
export function groupWorktrees(events: Event[], resolve: (p: string) => string = resolveWorktreeRoot): Event[] {
  const cache = new Map<string, string>();
  for (const e of events) {
    let root = cache.get(e.project);
    if (root === undefined) {
      root = resolve(e.project);
      cache.set(e.project, root);
    }
    e.project = root;
  }
  return events;
}

// `Date.prototype.toLocaleDateString` internally builds a fresh Intl formatter
// on every call. With hundreds of thousands of events that dominates wall-clock.
// Build one formatter per timezone and reuse it; format() runs ~10× faster.
const _dateKeyFmts = new Map<string, Intl.DateTimeFormat>();
function dateKey(ts: number, tz: string): string {
  let fmt = _dateKeyFmts.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    _dateKeyFmts.set(tz, fmt);
  }
  return fmt.format(ts * 1000);
}

export function aggregate(events: Event[], idleSec: number, tailSec: number, tz: string): Row[] {
  const buckets = new Map<string, { date: string; project: string; tss: number[]; promptCount: number }>();
  for (const e of events) {
    const d = dateKey(e.ts, tz);
    const key = `${d}\t${e.project}`;
    let b = buckets.get(key);
    if (!b) {
      b = { date: d, project: e.project, tss: [], promptCount: 0 };
      buckets.set(key, b);
    }
    b.tss.push(e.ts);
    if (e.isUserPrompt) b.promptCount++;
  }
  const rows: Row[] = [];
  for (const b of buckets.values()) {
    b.tss.sort((a, b) => a - b);
    let secs = 0;
    for (let i = 1; i < b.tss.length; i++) {
      const gap = b.tss[i]! - b.tss[i - 1]!;
      secs += gap <= idleSec ? gap : tailSec;
    }
    secs += tailSec; // tail for the last prompt
    rows.push({ date: b.date, project: b.project, prompts: b.promptCount, seconds: secs });
  }
  return rows;
}

function todayInTz(tz: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

function shiftDate(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function weekdayIndex(ymd: string): number {
  // 0 = Mon, 6 = Sun
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // Sun=0
  return (dow + 6) % 7;
}

export function resolveRange(
  opts: {
    since?: string;
    until?: string;
    days?: number;
    today?: boolean;
    yesterday?: boolean;
    thisWeek?: boolean;
    lastWeek?: boolean;
    thisMonth?: boolean;
    lastMonth?: boolean;
  },
  today: string,
): { since: string; until: string } {
  if (opts.today) return { since: today, until: today };
  if (opts.yesterday) {
    const y = shiftDate(today, -1);
    return { since: y, until: y };
  }
  if (opts.thisWeek) {
    const since = shiftDate(today, -weekdayIndex(today));
    return { since, until: today };
  }
  if (opts.lastWeek) {
    const thisMon = shiftDate(today, -weekdayIndex(today));
    return { since: shiftDate(thisMon, -7), until: shiftDate(thisMon, -1) };
  }
  if (opts.thisMonth) {
    const since = today.slice(0, 8) + "01";
    return { since, until: today };
  }
  if (opts.lastMonth) {
    const firstThis = today.slice(0, 8) + "01";
    const lastPrev = shiftDate(firstThis, -1);
    const sincePrev = lastPrev.slice(0, 8) + "01";
    return { since: sincePrev, until: lastPrev };
  }
  if (opts.since || opts.until) {
    return { since: opts.since ?? "0000-01-01", until: opts.until ?? today };
  }
  const days = opts.days ?? 14;
  return { since: shiftDate(today, -(days - 1)), until: today };
}

function fmtDuration(s: number): string {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${String(h).padStart(2)}h${String(m).padStart(2, "0")}m` : `   ${String(m).padStart(2)}m`;
}

function shortenPath(p: string, width = 40): string {
  const home = homedir();
  const name = p.startsWith(home) ? "~" + p.slice(home.length) : p;
  return name.length > width ? "…" + name.slice(-(width - 1)) : name;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function printText(rows: Row[], opts: { total: boolean; top?: number; days: number; rangeLabel: string }) {
  const projTotals = new Map<string, number>();

  if (!opts.total) {
    rows.sort((a, b) => (a.date === b.date ? b.seconds - a.seconds : a.date < b.date ? -1 : 1));
    let curDate: string | null = null;
    let dayTotal = 0;
    for (const r of rows) {
      if (r.date !== curDate) {
        if (curDate !== null) {
          console.log(`  ${"─".repeat(60)}`);
          console.log(`  ${"Total".padEnd(40)} ${fmtDuration(dayTotal).padStart(8)}`);
          console.log("");
        }
        curDate = r.date;
        dayTotal = 0;
        const wd = WEEKDAYS[weekdayIndex(r.date)];
        console.log(pc.bold(`━━ ${r.date} (${wd}) ━━`));
      }
      console.log(
        `  ${shortenPath(r.project).padEnd(40)} ${pc.cyan(fmtDuration(r.seconds).padStart(8))}  ${pc.dim(`(${r.prompts} prompts)`)}`
      );
      dayTotal += r.seconds;
      projTotals.set(r.project, (projTotals.get(r.project) ?? 0) + r.seconds);
    }
    if (curDate !== null) {
      console.log(`  ${"─".repeat(60)}`);
      console.log(`  ${"Total".padEnd(40)} ${fmtDuration(dayTotal).padStart(8)}`);
      console.log("");
    }
  } else {
    for (const r of rows) {
      projTotals.set(r.project, (projTotals.get(r.project) ?? 0) + r.seconds);
    }
  }

  const sorted = [...projTotals.entries()].sort((a, b) => b[1] - a[1]);
  const limited = opts.top ? sorted.slice(0, opts.top) : sorted;
  console.log(pc.bold(`━━━━ ${opts.rangeLabel} — Project totals ━━━━`));
  let grand = 0;
  for (const [proj, secs] of limited) {
    console.log(`  ${shortenPath(proj).padEnd(40)} ${pc.cyan(fmtDuration(secs).padStart(8))}`);
    grand += secs;
  }
  if (opts.top && sorted.length > limited.length) {
    const rest = sorted.slice(limited.length).reduce((a, [, s]) => a + s, 0);
    const label = `+${sorted.length - limited.length} more`.padEnd(40);
    console.log(`  ${pc.dim(label)} ${pc.dim(fmtDuration(rest).padStart(8))}`);
    grand += rest;
  }
  console.log(`  ${"─".repeat(60)}`);
  console.log(`  ${"Grand total".padEnd(40)} ${pc.bold(fmtDuration(grand).padStart(8))}`);
}

function main() {
  const program = new Command();
  program
    .name("claude-code-time")
    .description("Time analytics for local coding-agent sessions.")
    .version(pkg.version)
    .option("--days <n>", "last N days", (v) => Number(v), 14)
    .option("--since <YYYY-MM-DD>", "range start")
    .option("--until <YYYY-MM-DD>", "range end")
    .option("--today", "today only")
    .option("--yesterday", "yesterday only")
    .option("--this-week", "this week (Monday to today)")
    .option("--last-week", "last week")
    .option("--this-month", "this month")
    .option("--last-month", "last month")
    .option("--project <pattern>", "filter by substring of project path")
    .option("--here", "filter to the current working directory's project")
    .option("--no-group-worktrees", "keep git worktree sessions separate instead of merging them into their main repository")
    .option("--idle <dur>", "idle threshold (e.g. 600, 10m, 1h)", "10m")
    .option("--tail <dur>", "tail seconds added per prompt (e.g. 60, 1m)", "1m")
    .option("--total", "skip daily breakdown, project totals only")
    .option("--top <n>", "show only top N projects in totals", (v) => Number(v))
    .option("--json", "JSON output")
    .option("--tz <tz>", "timezone (e.g. Asia/Tokyo)", process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
    .option("--source <source>", "history source: claude, codex, or all", "claude")
    .option("--codex", "shortcut for --source codex")
    .option("--no-cache", "skip the on-disk parse cache (no read, no write)")
    .option(
      "--projects-dir <path>",
      "path to a ~/.claude/projects-style directory (repeatable; comma-separated also accepted)",
      makeDirCollector(),
      [DEFAULT_PROJECTS_DIR],
    )
    .option(
      "--codex-sessions-dir <path>",
      "path to a ~/.codex/sessions-style directory (repeatable; comma-separated also accepted)",
      makeDirCollector(),
      [DEFAULT_CODEX_SESSIONS_DIR],
    )
    .parse(process.argv);

  const o = program.opts<{
    days: number;
    since?: string;
    until?: string;
    today?: boolean;
    yesterday?: boolean;
    thisWeek?: boolean;
    lastWeek?: boolean;
    thisMonth?: boolean;
    lastMonth?: boolean;
    project?: string;
    here?: boolean;
    groupWorktrees: boolean;
    idle: string;
    tail: string;
    total?: boolean;
    top?: number;
    json?: boolean;
    tz: string;
    source: string;
    codex?: boolean;
    cache: boolean;
    projectsDir: string[];
    codexSessionsDir: string[];
  }>();

  const source = (o.codex ? "codex" : o.source) as Source;
  if (source !== "claude" && source !== "codex" && source !== "all") {
    console.error(pc.red(`Invalid --source: ${o.source}`));
    process.exit(1);
  }
  const requiredDirs = [
    ...(source === "claude" || source === "all" ? o.projectsDir : []),
    ...(source === "codex" || source === "all" ? o.codexSessionsDir : []),
  ];
  for (const dir of requiredDirs) {
    if (!existsSync(dir)) {
      console.error(pc.red(`Not found: ${dir}`));
      process.exit(1);
    }
  }

  const idleSec = parseDuration(o.idle, "s");
  const tailSec = parseDuration(o.tail, "s");

  const { since, until } = resolveRange(o, todayInTz(o.tz));
  const cachePath = defaultCachePath();
  const cache: FileCache = o.cache ? loadFileCache(cachePath) : new Map();
  let events: Event[] = [];
  if (source === "claude" || source === "all") {
    for (const dir of o.projectsDir) {
      // for-loop push instead of spread: large arrays would blow the JS engine's
      // apply-arg limit and throw `Maximum call stack size exceeded`.
      for (const e of loadEventsFromProjects(dir, { since, until, tz: o.tz, cache })) events.push(e);
    }
  }
  if (source === "codex" || source === "all") {
    for (const dir of o.codexSessionsDir) {
      for (const e of loadEventsFromCodexSessions(dir, { since, until, tz: o.tz, cache })) events.push(e);
    }
  }
  if (o.cache) {
    try {
      saveFileCache(cachePath, cache);
    } catch {
      // Cache is a perf optimization; never let a save failure abort the run.
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  if (o.groupWorktrees) groupWorktrees(events);
  if (o.project) {
    const needle = o.project;
    events = events.filter((e) => e.project.includes(needle));
  }
  if (o.here) {
    const cwd = o.groupWorktrees ? resolveWorktreeRoot(process.cwd()) : process.cwd();
    let best: string | null = null;
    for (const e of events) {
      if (e.project === cwd || cwd.startsWith(e.project + "/")) {
        if (!best || e.project.length > best.length) best = e.project;
      }
    }
    events = best ? events.filter((e) => e.project === best) : [];
  }

  const rows = aggregate(events, idleSec, tailSec, o.tz);

  if (o.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }

  const rangeLabel = since === until ? since : `${since} – ${until}`;
  printText(rows, { total: !!o.total, top: o.top, days: o.days, rangeLabel });
}

function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isDirectInvocation()) main();
