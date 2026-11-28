import {
  allClientAddresses,
  normalizeAdditionalEmails,
} from "../utils/clientEmails";
import { clientLabel } from "../utils/clientLabel";

describe("clientLabel", () => {
  it("shows the company, not the contact person", () => {
    expect(clientLabel({ name: "Amos Serem", company: "Isadora Ltd" })).toBe("Isadora Ltd");
  });
  it("falls back to the contact name when there is no company", () => {
    expect(clientLabel({ name: "Amos Serem", company: "  " })).toBe("Amos Serem");
  });
});

describe("normalizeAdditionalEmails", () => {
  it("trims, lowercases, labels and drops blanks and duplicates", () => {
    const r = normalizeAdditionalEmails(
      [
        { label: " HR ", email: " Hr@Acme.com " },
        { label: "", email: "ceo@acme.com" },
        { label: "Dup", email: "hr@acme.com" },
        { label: "Main dup", email: "main@acme.com" },
        { label: "blank row", email: "" },
      ],
      "Main@acme.com",
    );
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual([
      { label: "HR", email: "hr@acme.com" },
      { label: "Other", email: "ceo@acme.com" },
    ]);
  });
  it("rejects an invalid address", () => {
    expect(normalizeAdditionalEmails([{ label: "x", email: "nope" }]).error).toMatch(/not a valid/);
  });
  it("accepts a JSON string (multipart)", () => {
    expect(
      normalizeAdditionalEmails('[{"label":"HR","email":"a@b.co"}]').value,
    ).toHaveLength(1);
  });
});

describe("allClientAddresses", () => {
  it("lists the main address first, then the extras", () => {
    expect(
      allClientAddresses({
        email: "CEO@acme.com",
        emailLabel: "CEO",
        additionalEmails: [{ label: "HR", email: "hr@acme.com" }],
      }),
    ).toEqual([
      { label: "CEO", email: "ceo@acme.com", primary: true },
      { label: "HR", email: "hr@acme.com", primary: false },
    ]);
  });
  it("works with no main address", () => {
    expect(allClientAddresses({ additionalEmails: [{ label: "HR", email: "hr@acme.com" }] })).toHaveLength(1);
  });
});