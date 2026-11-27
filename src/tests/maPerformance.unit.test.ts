import { attributeDelay } from "../services/maPerformanceService";
import { assertAllowedFile, looksLikePdf } from "../services/reportAttachmentService";
import { deadlineFor } from "../utils/maDeadlines";

const t = (iso: string) => new Date(`${iso}+03:00`);
const DL = deadlineFor("2026-10"); // 15 Nov 23:59:59.999 EAT

describe("attributeDelay — who held the report after the deadline", () => {
  it("charges the accountants for time before they submit", () => {
    const d = attributeDelay(DL, t("2026-11-20T00:00:00"), []);
    expect(d.accountant).toBeCloseTo(4, 0);
    expect(d.supervisor).toBe(0);
    expect(d.delivery).toBe(0);
  });

  it("splits accountant / supervisor / delivery time", () => {
    // Submitted 16th 00:00 (accountant late ~0), review 16→18, approved, sent 21st.
    const d = attributeDelay(DL, t("2026-11-21T00:00:00"), [
      { at: t("2026-11-16T00:00:00"), to: "supervisor" },
      { at: t("2026-11-18T00:00:00"), to: "delivery" },
      { at: t("2026-11-21T00:00:00"), to: "done" },
    ]);
    expect(d.accountant).toBeCloseTo(0, 1);
    expect(d.supervisor).toBeCloseTo(2, 1);
    expect(d.delivery).toBeCloseTo(3, 1);
  });

  it("does NOT blame accountants for a slow supervisor review", () => {
    // Submitted on time (13th); supervisor sits on it until the 20th.
    const d = attributeDelay(DL, t("2026-11-20T00:00:00"), [
      { at: t("2026-11-13T00:00:00"), to: "supervisor" },
    ]);
    expect(d.accountant).toBe(0);
    expect(d.supervisor).toBeCloseTo(4, 0);
  });

  it("returns for corrections hand the clock back to the accountants", () => {
    const d = attributeDelay(DL, t("2026-11-22T00:00:00"), [
      { at: t("2026-11-14T00:00:00"), to: "supervisor" },
      { at: t("2026-11-17T00:00:00"), to: "accountant" }, // returned
      { at: t("2026-11-19T00:00:00"), to: "supervisor" }, // resubmitted
    ]);
    expect(d.supervisor).toBeCloseTo(1 + 3, 0); // 16th→17th + 19th→22nd
    expect(d.accountant).toBeCloseTo(2, 1); // 17th→19th
  });

  it("is zero for work finished before the deadline", () => {
    const d = attributeDelay(DL, t("2026-11-14T00:00:00"), [
      { at: t("2026-11-12T00:00:00"), to: "supervisor" },
      { at: t("2026-11-14T00:00:00"), to: "done" },
    ]);
    expect(d).toEqual({ accountant: 0, supervisor: 0, delivery: 0 });
  });
});

describe("PDF-only attachment rules", () => {
  it("accepts a real PDF name + MIME type", () => {
    expect(() =>
      assertAllowedFile("final", { filename: "Report.PDF", mimeType: "application/pdf" }),
    ).not.toThrow();
  });
  it.each([
    ["Report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["Book.xlsx", "application/vnd.ms-excel"],
    ["pic.png", "image/png"],
    ["malware.exe", "application/octet-stream"],
    ["sneaky.pdf.exe", "application/pdf"],
  ])("rejects %s", (filename, mimeType) => {
    expect(() => assertAllowedFile("final", { filename, mimeType })).toThrow(/PDF/i);
  });
  it("rejects a .pdf name with a non-PDF MIME type", () => {
    expect(() =>
      assertAllowedFile("final", { filename: "a.pdf", mimeType: "text/plain" }),
    ).toThrow(/PDF/i);
  });
  it("sniffs real PDF structure", () => {
    const good = Buffer.from("%PDF-1.7\n....");
    expect(looksLikePdf(good, Buffer.from("trailer\n%%EOF\n"))).toBe(true);
    expect(looksLikePdf(Buffer.from("PK\u0003\u0004 zip"), Buffer.from("%%EOF"))).toBe(false); // renamed docx/zip
    expect(looksLikePdf(good, Buffer.from("truncated, no marker"))).toBe(false);
  });
});
