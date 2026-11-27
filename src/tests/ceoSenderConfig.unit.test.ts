export {}; // module scope (avoids clashing with other test helpers)
// How the CEO's sending identity is authorised under different server configs.
// emailService reads MAIL_FROM_DOMAIN once at load, so each case loads a fresh copy.
const ENV_KEYS = ["MAIL_FROM_DOMAIN", "MAIL_FROM_ADDRESS", "CEO_SENDER_EMAIL"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => ENV_KEYS.forEach((k) => (saved[k] = process.env[k])));
afterAll(() => ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

const load = (env: Record<string, string | undefined>) => {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  Object.entries(env).forEach(([k, v]) => v !== undefined && (process.env[k] = v));
  let mod: typeof import("../services/emailService");
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require("../services/emailService");
  });
  return mod!;
};

describe("CEO sender authorisation", () => {
  it("works with only MAIL_FROM_ADDRESS set — and leaves every other flow alone", () => {
    const m = load({ MAIL_FROM_ADDRESS: "peakinsights@peak-insights.com" }); // MAIL_FROM_DOMAIN deliberately unset
    expect(m.assertCeoCanSendAs("nkyebei@peak-insights.com")).toBe("nkyebei@peak-insights.com");
    // …while canSendAs (used by invites etc.) is unchanged: still "no", so those keep using the shared address.
    expect(m.canSendAs("nkyebei@peak-insights.com")).toBe(false);
  });

  it("works with MAIL_FROM_DOMAIN as before", () => {
    const m = load({ MAIL_FROM_DOMAIN: "peak-insights.com" });
    expect(m.assertCeoCanSendAs("Nkyebei@Peak-Insights.com")).toBe("nkyebei@peak-insights.com");
  });

  it("refuses an address on some other domain — never falls back", () => {
    const m = load({ MAIL_FROM_ADDRESS: "peakinsights@peak-insights.com" });
    expect(() => m.assertCeoCanSendAs("ceo@gmail.com")).toThrow(/not authorised/);
    expect(() => m.assertCeoCanSendAs("ceo@gmail.com")).toThrow(/CEO_SENDER_EMAIL/); // tells the admin what to set
  });

  it("an explicit CEO_SENDER_EMAIL authorises the CEO's official address", () => {
    const m = load({ MAIL_FROM_ADDRESS: "peakinsights@peak-insights.com", CEO_SENDER_EMAIL: "ceo@official.co.ke" });
    expect(m.assertCeoCanSendAs("ceo@official.co.ke", { explicit: true })).toBe("ceo@official.co.ke");
  });

  it("refuses when nothing is configured at all", () => {
    const m = load({});
    expect(() => m.assertCeoCanSendAs("nkyebei@peak-insights.com")).toThrow(/none is configured/);
    expect(() => m.assertCeoCanSendAs(undefined)).toThrow(/not set up/);
  });
});