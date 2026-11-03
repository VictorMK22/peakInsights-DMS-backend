// Verifies WHO the invite email is sent from. No database needed.
const sent: any[] = [];
jest.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (m: any) => {
        sent.push(m);
        return { data: { id: "1" }, error: null };
      },
    };
  },
}));

const load = () => {
  process.env.RESEND_API_KEY = "k";
  process.env.MAIL_FROM_DOMAIN = "peak-insights.com";
  process.env.FRONTEND_URL = "https://app.example.com";
  let mod!: typeof import("../services/emailService");
  jest.isolateModules(() => {
    mod = require("../services/emailService");
  });
  return mod;
};

beforeEach(() => (sent.length = 0));

describe("account invite sender", () => {
  it("is sent FROM the CEO's own mailbox when it is on the verified domain", async () => {
    const { sendAccountCreatedByCEOEmail } = load();
    const ok = await sendAccountCreatedByCEOEmail(
      "new@x.com",
      "New",
      "Pw12345678",
      "accountant",
      {
        name: "Jane Doe",
        email: "jane@peak-insights.com",
        role: "ceo",
      },
    );
    expect(ok).toBe(true);
    expect(sent[0].from).toBe('"Jane Doe" <jane@peak-insights.com>');
    expect(sent[0].replyTo).toBe("jane@peak-insights.com");
    expect(sent[0].to).toBe("new@x.com");
  });

  it("matches the domain case-insensitively", async () => {
    const { sendAccountCreatedByCEOEmail } = load();
    await sendAccountCreatedByCEOEmail("n@x.com", "N", "Pw12345678", "tech", {
      name: "Jane",
      email: "Jane@Peak-Insights.com",
    });
    expect(sent[0].from).toContain("<Jane@Peak-Insights.com>");
  });

  it("falls back to the shared address (CEO name + Reply-To) for an off-domain mailbox", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { sendAccountCreatedByCEOEmail } = load();
    const ok = await sendAccountCreatedByCEOEmail(
      "n@x.com",
      "N",
      "Pw12345678",
      "tech",
      {
        name: "Jane Doe",
        email: "jane@gmail.com",
      },
    );
    expect(ok).toBe(true);
    expect(sent[0].from).toBe(
      '"Jane Doe via PeakInsights Hub" <peakinsights@peak-insights.com>',
    );
    expect(sent[0].replyTo).toBe("jane@gmail.com");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not let a lookalike domain pass", () => {
    const { canSendAs } = load();
    expect(canSendAs("a@peak-insights.com")).toBe(true);
    expect(canSendAs("a@evil-peak-insights.com")).toBe(false);
    expect(canSendAs("a@peak-insights.com.evil.io")).toBe(false);
    expect(canSendAs("a@sub.peak-insights.com")).toBe(false);
    expect(canSendAs(undefined)).toBe(false);
  });
});
