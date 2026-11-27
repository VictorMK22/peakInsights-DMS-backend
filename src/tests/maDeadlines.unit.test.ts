import {
  deadlineFor,
  deadlineLabel,
  currentReportingPeriod,
  computeDeadlineStatus,
  isReviewAlertActive,
  daysOverdue,
  shiftPeriod,
  periodLabelOf,
  eatDateKey,
} from "../utils/maDeadlines";

// Africa/Nairobi is UTC+3: 23:59:59.999 EAT on the 15th = 20:59:59.999Z.
const eat = (iso: string) => new Date(`${iso}+03:00`);

describe("MA deadline = 15th of the following month (Africa/Nairobi)", () => {
  const cases: [string, string][] = [
    ["2026-01", "15 February 2026"],
    ["2026-02", "15 March 2026"],
    ["2026-03", "15 April 2026"],
    ["2026-04", "15 May 2026"],
    ["2026-05", "15 June 2026"],
    ["2026-06", "15 July 2026"],
    ["2026-07", "15 August 2026"],
    ["2026-08", "15 September 2026"],
    ["2026-09", "15 October 2026"],
    ["2026-10", "15 November 2026"],
    ["2026-11", "15 December 2026"],
    ["2026-12", "15 January 2027"], // rolls into the next year
  ];
  it.each(cases)("%s → %s", (key, label) => {
    expect(deadlineLabel(key)).toBe(label);
  });

  it("is the very end of the 15th in Nairobi", () => {
    expect(deadlineFor("2026-10").toISOString()).toBe("2026-11-15T20:59:59.999Z");
  });

  it("reporting period 'now' is the previous month (EAT)", () => {
    expect(currentReportingPeriod(eat("2026-11-25T10:00:00"))).toBe("2026-10");
    expect(currentReportingPeriod(eat("2026-01-02T00:30:00"))).toBe("2025-12");
    // 23:30 UTC on 31 Oct is already 1 Nov in Nairobi → October is the period.
    expect(currentReportingPeriod(new Date("2026-10-31T22:30:00Z"))).toBe("2026-10");
  });

  it("shifts and labels periods across years", () => {
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
    expect(shiftPeriod("2026-12", 1)).toBe("2027-01");
    expect(periodLabelOf("2026-10")).toBe("October 2026");
  });
});

describe("deadline status (spec §10)", () => {
  const deadline = deadlineFor("2026-10"); // end of 15 Nov
  it("upcoming → due today → overdue", () => {
    expect(computeDeadlineStatus({ deadline }, eat("2026-11-10T09:00:00"))).toBe("upcoming");
    expect(computeDeadlineStatus({ deadline }, eat("2026-11-15T09:00:00"))).toBe("due_today");
    expect(computeDeadlineStatus({ deadline }, eat("2026-11-15T23:59:00"))).toBe("due_today");
    expect(computeDeadlineStatus({ deadline }, eat("2026-11-16T00:01:00"))).toBe("overdue_not_submitted");
  });
  it("overdue pending review vs approved awaiting delivery vs sent", () => {
    const late = eat("2026-11-20T09:00:00");
    expect(computeDeadlineStatus({ deadline, workflowStatus: "pending_review" }, late)).toBe("overdue_pending_review");
    expect(computeDeadlineStatus({ deadline, workflowStatus: "returned" }, late)).toBe("overdue_not_submitted");
    expect(computeDeadlineStatus({ deadline, workflowStatus: "approved" }, late)).toBe("approved_awaiting_delivery_overdue");
    expect(computeDeadlineStatus({ deadline, workflowStatus: "approved" }, eat("2026-11-12T09:00:00"))).toBe("approved_awaiting_delivery");
    expect(computeDeadlineStatus({ deadline, workflowStatus: "delivery_failed" }, late)).toBe("approved_awaiting_delivery_overdue");
    expect(computeDeadlineStatus({ deadline, workflowStatus: "sent", sentAt: late }, late)).toBe("sent");
  });
  it("EAT date boundary: 21:30Z on the 15th is already the 16th in Nairobi", () => {
    const now = new Date("2026-11-15T21:30:00Z");
    expect(eatDateKey(now)).toBe("2026-11-16");
    expect(computeDeadlineStatus({ deadline }, now)).toBe("overdue_not_submitted");
  });
  it("counts whole days overdue", () => {
    expect(daysOverdue(deadline, eat("2026-11-15T12:00:00"))).toBe(0);
    expect(daysOverdue(deadline, eat("2026-11-16T12:00:00"))).toBe(1);
    expect(daysOverdue(deadline, eat("2026-11-25T12:00:00"))).toBe(10);
  });
});

describe("review alert lifecycle: submission does NOT clear it, approval does", () => {
  const deadline = deadlineFor("2026-10");
  const late = eat("2026-11-20T09:00:00");
  it("is off before the deadline", () => {
    expect(isReviewAlertActive({ deadline }, eat("2026-11-14T09:00:00"))).toBe(false);
  });
  it("on when unsubmitted, on while pending review, on when returned", () => {
    expect(isReviewAlertActive({ deadline }, late)).toBe(true);
    expect(isReviewAlertActive({ deadline, workflowStatus: "draft" }, late)).toBe(true);
    expect(isReviewAlertActive({ deadline, workflowStatus: "pending_review" }, late)).toBe(true);
    expect(isReviewAlertActive({ deadline, workflowStatus: "returned" }, late)).toBe(true);
  });
  it("off once approved — even though delivery is still outstanding", () => {
    expect(isReviewAlertActive({ deadline, workflowStatus: "approved" }, late)).toBe(false);
    expect(computeDeadlineStatus({ deadline, workflowStatus: "approved" }, late)).toBe("approved_awaiting_delivery_overdue");
    expect(isReviewAlertActive({ deadline, workflowStatus: "delivery_failed" }, late)).toBe(false);
  });
});
