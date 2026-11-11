import {
  lastCompletedWeek,
  parseReportDate,
  formatPeriodLabel,
} from "../services/salesReportService";

describe("lastCompletedWeek (Nairobi, Monday–Sunday)", () => {
  it("on a Monday morning returns the week that just ended", () => {
    // Mon 9 Nov 2026 08:00 EAT = 05:00 UTC
    const { from, to } = lastCompletedWeek(new Date("2026-11-09T05:00:00Z"));
    expect(from.toISOString()).toBe("2026-11-01T21:00:00.000Z"); // Mon 2 Nov 00:00 EAT
    expect(to.toISOString()).toBe("2026-11-08T21:00:00.000Z"); // Mon 9 Nov 00:00 EAT
  });

  it("mid-week still returns the previous completed week", () => {
    // Wed 11 Nov 2026
    const { from, to } = lastCompletedWeek(new Date("2026-11-11T10:00:00Z"));
    expect(to.toISOString()).toBe("2026-11-08T21:00:00.000Z");
    expect(to.getTime() - from.getTime()).toBe(7 * 24 * 3600 * 1000);
  });

  it("treats Sunday 23:30 UTC as Monday in Nairobi", () => {
    // Sun 8 Nov 23:30 UTC = Mon 9 Nov 02:30 EAT → the week of 2–8 Nov is complete
    const { to } = lastCompletedWeek(new Date("2026-11-08T23:30:00Z"));
    expect(to.toISOString()).toBe("2026-11-08T21:00:00.000Z");
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