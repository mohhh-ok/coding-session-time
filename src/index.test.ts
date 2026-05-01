import { describe, expect, test } from "bun:test";
import { aggregate, parseDuration, resolveRange, type Event } from "./index";

const ts = (iso: string): number => Date.parse(iso) / 1000;
const ev = (iso: string, project: string, isUserPrompt = true): Event => ({
  ts: ts(iso),
  project,
  isUserPrompt,
});

describe("parseDuration", () => {
  test("bare number defaults to seconds", () => {
    expect(parseDuration("60")).toBe(60);
  });

  test("bare number with fallbackUnit=m", () => {
    expect(parseDuration("60", "m")).toBe(3600);
  });

  test("seconds suffix", () => {
    expect(parseDuration("30s")).toBe(30);
  });

  test("minutes suffix", () => {
    expect(parseDuration("10m")).toBe(600);
  });

  test("hours suffix", () => {
    expect(parseDuration("1h")).toBe(3600);
  });

  test("fractional values", () => {
    expect(parseDuration("1.5h")).toBe(5400);
  });

  test("trims whitespace", () => {
    expect(parseDuration("  1h  ")).toBe(3600);
  });

  test("explicit unit overrides fallbackUnit", () => {
    expect(parseDuration("30s", "m")).toBe(30);
  });

  test("rejects garbage", () => {
    expect(() => parseDuration("abc")).toThrow();
  });

  test("rejects unknown unit", () => {
    expect(() => parseDuration("10x")).toThrow();
  });
});

describe("aggregate", () => {
  const idle = 600; // 10m
  const tail = 60; // 1m
  const tz = "UTC";

  test("empty input returns empty", () => {
    expect(aggregate([], idle, tail, tz)).toEqual([]);
  });

  test("single event gets just the tail", () => {
    const rows = aggregate([ev("2026-05-01T10:00:00Z", "/p")], idle, tail, tz);
    expect(rows).toEqual([{ date: "2026-05-01", project: "/p", prompts: 1, seconds: tail }]);
  });

  test("two close events fold into one cluster", () => {
    const rows = aggregate([ev("2026-05-01T10:00:00Z", "/p"), ev("2026-05-01T10:00:30Z", "/p")], idle, tail, tz);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seconds).toBe(30 + tail);
    expect(rows[0]!.prompts).toBe(2);
  });

  test("gap larger than idle counts as tail per side", () => {
    const rows = aggregate([ev("2026-05-01T10:00:00Z", "/p"), ev("2026-05-01T11:00:00Z", "/p")], idle, tail, tz);
    expect(rows[0]!.seconds).toBe(tail + tail);
    expect(rows[0]!.prompts).toBe(2);
  });

  test("different projects produce separate rows", () => {
    const rows = aggregate([ev("2026-05-01T10:00:00Z", "/a"), ev("2026-05-01T10:00:00Z", "/b")], idle, tail, tz).sort(
      (a, b) => a.project.localeCompare(b.project),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.project)).toEqual(["/a", "/b"]);
  });

  test("different days produce separate rows", () => {
    const rows = aggregate([ev("2026-05-01T23:00:00Z", "/p"), ev("2026-05-02T01:00:00Z", "/p")], idle, tail, tz).sort(
      (a, b) => a.date.localeCompare(b.date),
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-05-01", "2026-05-02"]);
  });

  test("timezone affects date assignment", () => {
    const rowsUtc = aggregate([ev("2026-05-01T23:00:00Z", "/p")], idle, tail, "UTC");
    const rowsTokyo = aggregate([ev("2026-05-01T23:00:00Z", "/p")], idle, tail, "Asia/Tokyo");
    expect(rowsUtc[0]!.date).toBe("2026-05-01");
    expect(rowsTokyo[0]!.date).toBe("2026-05-02");
  });

  test("mix of close and far gaps within a day", () => {
    const rows = aggregate(
      [
        ev("2026-05-01T10:00:00Z", "/p"),
        ev("2026-05-01T10:01:00Z", "/p"),
        ev("2026-05-01T13:00:00Z", "/p"),
        ev("2026-05-01T13:00:10Z", "/p"),
      ],
      idle,
      tail,
      tz,
    );
    expect(rows[0]!.seconds).toBe(60 + tail + 10 + tail);
    expect(rows[0]!.prompts).toBe(4);
  });

  test("only events flagged as user prompts contribute to the prompt count", () => {
    // Simulates a single user prompt followed by a long autonomous task: the assistant turns
    // and tool results keep the cluster alive but should not inflate the prompt count.
    const events: Event[] = [
      ev("2026-05-01T10:00:00Z", "/p", true), // real user prompt
      ev("2026-05-01T10:00:05Z", "/p", false), // assistant
      ev("2026-05-01T10:00:10Z", "/p", false), // tool result
      ev("2026-05-01T10:15:00Z", "/p", false), // assistant, 15m later — would have been "idle" under user-only data
    ];
    const rows = aggregate(events, idle, tail, tz);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prompts).toBe(1);
    // 5 + 5 + 60 (gap > idle, swapped for tail) + 60 (final tail) = 130
    expect(rows[0]!.seconds).toBe(5 + 5 + tail + tail);
  });

  test("dense assistant activity keeps a long task fully counted", () => {
    // Simulates a 20-minute autonomous task where assistant/tool events fire every ~30s.
    // Under the old user-only data this would collapse to 2 * tail; with assistant events
    // it should reflect the full elapsed time.
    const start = ts("2026-05-01T10:00:00Z");
    const events: Event[] = [{ ts: start, project: "/p", isUserPrompt: true }];
    for (let i = 1; i <= 40; i++) {
      events.push({ ts: start + i * 30, project: "/p", isUserPrompt: false });
    }
    const rows = aggregate(events, idle, tail, tz);
    expect(rows[0]!.seconds).toBe(40 * 30 + tail); // last - first + tail
    expect(rows[0]!.prompts).toBe(1);
  });
});

describe("resolveRange", () => {
  // 2026-05-01 is a Friday.
  const today = "2026-05-01";

  test("today", () => {
    expect(resolveRange({ today: true }, today)).toEqual({ since: "2026-05-01", until: "2026-05-01" });
  });

  test("yesterday", () => {
    expect(resolveRange({ yesterday: true }, today)).toEqual({ since: "2026-04-30", until: "2026-04-30" });
  });

  test("thisWeek (Mon to today)", () => {
    expect(resolveRange({ thisWeek: true }, today)).toEqual({ since: "2026-04-27", until: "2026-05-01" });
  });

  test("lastWeek (Mon to Sun)", () => {
    expect(resolveRange({ lastWeek: true }, today)).toEqual({ since: "2026-04-20", until: "2026-04-26" });
  });

  test("thisMonth (1st to today)", () => {
    expect(resolveRange({ thisMonth: true }, today)).toEqual({ since: "2026-05-01", until: "2026-05-01" });
  });

  test("lastMonth (whole previous month)", () => {
    expect(resolveRange({ lastMonth: true }, today)).toEqual({ since: "2026-04-01", until: "2026-04-30" });
  });

  test("explicit since and until", () => {
    expect(resolveRange({ since: "2026-04-15", until: "2026-04-20" }, today)).toEqual({
      since: "2026-04-15",
      until: "2026-04-20",
    });
  });

  test("only since defaults until to today", () => {
    expect(resolveRange({ since: "2026-04-15" }, today)).toEqual({ since: "2026-04-15", until: "2026-05-01" });
  });

  test("only until defaults since to epoch sentinel", () => {
    expect(resolveRange({ until: "2026-04-20" }, today)).toEqual({ since: "0000-01-01", until: "2026-04-20" });
  });

  test("days=7 means last 7 days including today", () => {
    expect(resolveRange({ days: 7 }, today)).toEqual({ since: "2026-04-25", until: "2026-05-01" });
  });

  test("default 14 days when no flags given", () => {
    expect(resolveRange({}, today)).toEqual({ since: "2026-04-18", until: "2026-05-01" });
  });

  test("thisWeek when today is Monday", () => {
    expect(resolveRange({ thisWeek: true }, "2026-04-27")).toEqual({ since: "2026-04-27", until: "2026-04-27" });
  });

  test("thisWeek when today is Sunday", () => {
    expect(resolveRange({ thisWeek: true }, "2026-05-03")).toEqual({ since: "2026-04-27", until: "2026-05-03" });
  });

  test("lastMonth across year boundary", () => {
    expect(resolveRange({ lastMonth: true }, "2026-01-15")).toEqual({ since: "2025-12-01", until: "2025-12-31" });
  });
});
