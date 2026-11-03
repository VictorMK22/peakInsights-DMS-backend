import { parseOpeningBalance } from "../utils/openingBalance";

describe("parseOpeningBalance", () => {
  it.each([undefined, null, "", "   "])("rejects missing value %p", (v) => {
    expect(parseOpeningBalance(v).ok).toBe(false);
  });

  it.each([
    "abc",
    "1,500",
    "1e3",
    "0x10",
    "12.",
    ".5",
    {},
    [],
    true,
    NaN,
    Infinity,
  ])("rejects non-numeric %p", (v) => {
    expect(parseOpeningBalance(v).ok).toBe(false);
  });

  it("accepts zero explicitly (number and string)", () => {
    expect(parseOpeningBalance(0)).toEqual({ ok: true, value: 0 });
    expect(parseOpeningBalance("0")).toEqual({ ok: true, value: 0 });
  });

  it("normalises negative zero", () => {
    const r = parseOpeningBalance(-0);
    expect(r.ok && Object.is(r.value, 0)).toBe(true);
  });

  it("accepts positive, negative (credit) and numeric strings", () => {
    expect(parseOpeningBalance("1500.50")).toEqual({ ok: true, value: 1500.5 });
    expect(parseOpeningBalance(-200)).toEqual({ ok: true, value: -200 });
    expect(parseOpeningBalance(" 42 ")).toEqual({ ok: true, value: 42 });
  });

  it("rejects absurdly large amounts", () => {
    expect(parseOpeningBalance(1e13).ok).toBe(false);
  });
});
