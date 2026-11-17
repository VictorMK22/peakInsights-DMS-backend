import "./testEnv";
import {
  withAuthorFallback,
  FORMER_STAFF_LABEL,
} from "../services/departedStaffService";

describe("withAuthorFallback — records whose author's account is gone", () => {
  it("leaves a record with a live author untouched", () => {
    const doc = { authorId: { _id: "u1", name: "Ann", role: "accountant" } };
    expect(withAuthorFallback(doc)).toBe(doc);
  });

  it("uses the saved snapshot when the author no longer resolves", () => {
    const out: any = withAuthorFallback({
      authorId: null,
      formerAuthor: { name: "Jane Doe", role: "accountant" },
    });
    expect(out.authorId).toMatchObject({
      _id: null,
      name: "Jane Doe",
      role: "accountant",
      former: true,
    });
  });

  it("falls back to a generic label when there is no snapshot", () => {
    const out: any = withAuthorFallback({ authorId: null });
    expect(out.authorId.name).toBe(FORMER_STAFF_LABEL);
    expect(out.authorId.former).toBe(true);
  });

  it("leaves an inbound WhatsApp message (no author by design) alone", () => {
    const doc = { authorId: null, direction: "inbound" };
    expect(withAuthorFallback(doc, false)).toBe(doc);
  });

  it("still fills in an outbound WhatsApp message whose sender left", () => {
    const out: any = withAuthorFallback(
      { authorId: null, formerAuthor: { name: "Jane Doe" } },
      false,
    );
    expect(out.authorId.name).toBe("Jane Doe");
  });
});
