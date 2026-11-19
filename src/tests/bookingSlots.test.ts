import {
  computeSlots,
  eatDateKey,
  eatMidnight,
  SlotConfig,
  TimeInterval,
} from "../services/bookingSlots";

// "Now" is Wednesday 18 Nov 2026, 09:00 EAT (06:00 UTC). EAT = UTC+3, so
// 09:00 EAT is written 06:00Z below. Fri 20 Nov, Sat 21, Sun 22, Mon 23.
const NOW = new Date("2026-11-18T06:00:00Z");

const base: SlotConfig = {
  durationMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 30,
  workStartHour: 9,
  workEndHour: 17,
  workDays: [1, 2, 3, 4, 5],
  slotStepMinutes: 30,
};

const iso = (d: Date) => d.toISOString();
const range = (from: string, to: string) => ({ from: new Date(from), to: new Date(to) });
// Fri 20 Nov 00:00 EAT → Tue 24 Nov 00:00 EAT: a Friday, a weekend, a Monday.
const FRI_TO_MON = range("2026-11-19T21:00:00Z", "2026-11-23T21:00:00Z");

const busy = (start: string, end: string): TimeInterval => ({
  start: new Date(start),
  end: new Date(end),
});

describe("computeSlots", () => {
  it("offers only working hours on working days — nothing on the weekend", () => {
    const slots = computeSlots(base, [], NOW, FRI_TO_MON);
    const days = [...new Set(slots.map((s) => eatDateKey(s.start.getTime())))];
    expect(days).toEqual(["2026-11-20", "2026-11-23"]); // Fri and Mon only
    // 09:00–17:00 in 30-min steps = 16 slots per day.
    expect(slots).toHaveLength(32);
    expect(iso(slots[0].start)).toBe("2026-11-20T06:00:00.000Z"); // 09:00 EAT
    expect(iso(slots[15].start)).toBe("2026-11-20T13:30:00.000Z"); // 16:30 EAT
  });

  it("never offers a slot that would run past closing time", () => {
    const slots = computeSlots({ ...base, durationMinutes: 45 }, [], NOW, FRI_TO_MON);
    const friday = slots.filter((s) => eatDateKey(s.start.getTime()) === "2026-11-20");
    // 16:30 + 45min would end 17:15, so the last start is 16:00 EAT (13:00Z).
    expect(iso(friday[friday.length - 1].start)).toBe("2026-11-20T13:00:00.000Z");
    friday.forEach((s) => expect(s.end.getTime() - s.start.getTime()).toBe(45 * 60_000));
  });

  it("removes slots overlapping busy time", () => {
    // Busy Fri 10:00–11:00 EAT.
    const slots = computeSlots(base, [busy("2026-11-20T07:00:00Z", "2026-11-20T08:00:00Z")], NOW, FRI_TO_MON);
    const starts = slots.map((s) => iso(s.start));
    expect(starts).not.toContain("2026-11-20T07:00:00.000Z"); // 10:00
    expect(starts).not.toContain("2026-11-20T07:30:00.000Z"); // 10:30
    expect(starts).toContain("2026-11-20T06:30:00.000Z"); // 09:30 ends exactly at 10:00 — fine
    expect(starts).toContain("2026-11-20T08:00:00.000Z"); // 11:00 starts exactly as busy ends — fine
  });

  it("keeps a buffer around busy time on both sides", () => {
    const cfg = { ...base, bufferMinutes: 15 };
    const slots = computeSlots(cfg, [busy("2026-11-20T07:00:00Z", "2026-11-20T08:00:00Z")], NOW, FRI_TO_MON);
    const starts = slots.map((s) => iso(s.start));
    expect(starts).not.toContain("2026-11-20T06:30:00.000Z"); // 09:30 ends 10:00, inside the 15-min lead-in
    expect(starts).not.toContain("2026-11-20T08:00:00.000Z"); // 11:00 starts inside the 15-min tail
    expect(starts).toContain("2026-11-20T06:00:00.000Z"); // 09:00 ends 09:30, clear of the 09:45 buffer
    expect(starts).toContain("2026-11-20T08:30:00.000Z"); // 11:30 is clear of the 11:15 buffer
  });

  it("respects minimum notice", () => {
    // 24h notice from Wed 09:00 → nothing before Thu 09:00 EAT.
    const slots = computeSlots({ ...base, minNoticeHours: 24 }, [], NOW);
    expect(iso(slots[0].start)).toBe("2026-11-19T06:00:00.000Z");

    // 2h notice → first slot Wed 11:00 EAT.
    const soon = computeSlots({ ...base, minNoticeHours: 2 }, [], NOW);
    expect(iso(soon[0].start)).toBe("2026-11-18T08:00:00.000Z");
  });

  it("respects how far ahead clients can book", () => {
    const slots = computeSlots({ ...base, maxDaysAhead: 2 }, [], NOW);
    // Window closes Fri 09:00 EAT, so the last offered start is Thu 16:30 EAT.
    expect(iso(slots[slots.length - 1].start)).toBe("2026-11-19T13:30:00.000Z");
  });

  it("includes a slot by its START time when narrowing to a range", () => {
    const slots = computeSlots(base, [], NOW, range("2026-11-19T07:00:00Z", "2026-11-19T08:00:00Z"));
    // Thu 10:00 and 10:30 EAT only; 11:00 EAT is the exclusive end.
    expect(slots.map((s) => iso(s.start))).toEqual([
      "2026-11-19T07:00:00.000Z",
      "2026-11-19T07:30:00.000Z",
    ]);
  });

  it("returns nothing when the range is entirely outside the window", () => {
    expect(computeSlots(base, [], NOW, range("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"))).toEqual([]);
  });

  it("honours custom working days and hours", () => {
    const cfg = { ...base, workDays: [6], workStartHour: 10, workEndHour: 12 }; // Saturdays 10–12
    const slots = computeSlots(cfg, [], NOW, FRI_TO_MON);
    expect(slots.map((s) => iso(s.start))).toEqual([
      "2026-11-21T07:00:00.000Z",
      "2026-11-21T07:30:00.000Z",
      "2026-11-21T08:00:00.000Z",
      "2026-11-21T08:30:00.000Z",
    ]);
  });
});

describe("EAT day helpers", () => {
  it("assigns late-evening UTC times to the next EAT calendar day", () => {
    // 21:30Z on the 19th is 00:30 EAT on the 20th.
    expect(eatDateKey(new Date("2026-11-19T21:30:00Z").getTime())).toBe("2026-11-20");
    expect(eatDateKey(new Date("2026-11-19T20:59:00Z").getTime())).toBe("2026-11-19");
  });

  it("finds midnight EAT", () => {
    expect(new Date(eatMidnight(new Date("2026-11-20T10:00:00Z").getTime())).toISOString()).toBe(
      "2026-11-19T21:00:00.000Z",
    );
  });
});
