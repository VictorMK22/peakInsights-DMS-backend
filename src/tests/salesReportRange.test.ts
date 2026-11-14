import {
  lastCompletedWeek,
  eatDateString,
  parseReportDate,
  formatPeriodLabel,
} from "../services/salesReportService";

describe("lastCompletedWeek (Nairobi, Friday–Thursday)", () => {
  it("at the Thursday 23:59 EAT send time returns the week ending that night", () => {
    // Thu 12 Nov 2026 23:59 EAT = 20:59 UTC
    const { from, to } = lastCompletedWeek(new Date("2026-11-12T20:59:00Z"));
    expect(from.toISOString()).toBe("2026-11-05T21:00:00.000Z"); // Fri 6 Nov 00:00 EAT
    expect(to.toISOString()).toBe("2026-11-12T21:00:00.000Z"); // Fri 13 Nov 00:00 EAT
  });

  it("a late start after midnight (Fri 00:30 EAT) still reports the same week", () => {
    const { from, to } = lastCompletedWeek(new Date("2026-11-12T21:30:00Z"));
    expect(from.toISOString()).toBe("2026-11-05T21:00:00.000Z");
    expect(to.toISOString()).toBe("2026-11-12T21:00:00.000Z");
  });

  it("mid-week (Tue) returns the previous finished week", () => {
    // Tue 17 Nov 2026
    const { from, to } = lastCompletedWeek(new Date("2026-11-17T10:00:00Z"));
    expect(to.toISOString()).toBe("2026-11-12T21:00:00.000Z");
    expect(to.getTime() - from.getTime()).toBe(7 * 24 * 3600 * 1000);
  });

  it("always spans exactly 7 days from a Friday to a Friday in Nairobi", () => {
    const { from, to } = lastCompletedWeek(new Date("2026-11-14T12:00:00Z"));
    expect(eatDateString(from)).toBe("2026-11-06");
    expect(eatDateString(to)).toBe("2026-11-13");
  });
});

describe("parseReportDate", () => {
  it("reads plain dates as Nairobi midnight", () => {
    expect(parseReportDate("2026-11-02")!.toISOString()).toBe(
      "2026-11-01T21:00:00.000Z",
    );
  });
  it("rejects junk", () => {
    expect(parseReportDate("nope")).toBeNull();
    expect(parseReportDate(undefined)).toBeNull();
    expect(parseReportDate("")).toBeNull();
  });
});

describe("formatPeriodLabel", () => {
  it("labels a week by its first and last day", () => {
    const label = formatPeriodLabel(
      new Date("2026-11-01T21:00:00Z"),
      new Date("2026-11-08T21:00:00Z"),
    );
    expect(label).toBe("2 Nov – 8 Nov 2026");
  });
});