import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";

export type Event = { ts: number; project: string };
export type Row = { date: string; project: string; prompts: number; seconds: number };

const DEFAULT_HISTORY = join(homedir(), ".claude", "history.jsonl");

export function parseDuration(input: string, fallbackUnit: "s" | "m" = "s"): number {
  const m = input.trim().match(/^(\d+(?:\.\d+)?)([smh]?)$/i);
  if (!m) throw new Error(`invalid duration: ${input}`);
  const n = Number(m[1]);
  const unit = (m[2] || fallbackUnit).toLowerCase();
  return unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n;
}

function loadEvents(path: string): Event[] {
  const raw = readFileSync(path, "utf8");
  const out: Event[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.timestamp === "number" && typeof r.project === "string") {
        out.push({ ts: r.timestamp / 1000, project: r.project });
      }
    } catch {
      /* skip malformed line */
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function dateKey(ts: number, tz: string): string {
  // YYYY-MM-DD in given timezone
  return new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: tz });
}

export function aggregate(events: Event[], idleSec: number, tailSec: number, tz: string): Row[] {
  const buckets = new Map<string, { date: string; project: string; tss: number[] }>();
  for (const e of events) {
    const d = dateKey(e.ts, tz);
    const key = `${d}\t${e.project}`;
    let b = buckets.get(key);
    if (!b) {
      b = { date: d, project: e.project, tss: [] };
      buckets.set(key, b);
    }
    b.tss.push(e.ts);
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
    rows.push({ date: b.date, project: b.project, prompts: b.tss.length, seconds: secs });
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
    .name("cctime")
    .description("Time analytics for Claude Code — see how much time you spent in each project.")
    .version("0.1.0")
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
    .option("--idle <dur>", "idle threshold (e.g. 600, 10m, 1h)", "10m")
    .option("--tail <dur>", "tail seconds added per prompt (e.g. 60, 1m)", "1m")
    .option("--total", "skip daily breakdown, project totals only")
    .option("--top <n>", "show only top N projects in totals", (v) => Number(v))
    .option("--json", "JSON output")
    .option("--tz <tz>", "timezone (e.g. Asia/Tokyo)", process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
    .option("--path <path>", "path to history.jsonl", DEFAULT_HISTORY)
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
    idle: string;
    tail: string;
    total?: boolean;
    top?: number;
    json?: boolean;
    tz: string;
    path: string;
  }>();

  if (!existsSync(o.path)) {
    console.error(pc.red(`Not found: ${o.path}`));
    process.exit(1);
  }

  const idleSec = parseDuration(o.idle, "s");
  const tailSec = parseDuration(o.tail, "s");

  let events = loadEvents(o.path);
  if (o.project) {
    const needle = o.project;
    events = events.filter((e) => e.project.includes(needle));
  }

  const { since, until } = resolveRange(o, todayInTz(o.tz));
  const rows = aggregate(events, idleSec, tailSec, o.tz).filter((r) => r.date >= since && r.date <= until);

  if (o.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }

  const rangeLabel = since === until ? since : `${since} – ${until}`;
  printText(rows, { total: !!o.total, top: o.top, days: o.days, rangeLabel });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
