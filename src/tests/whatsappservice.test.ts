import "./testEnv";
import axios from "axios";

// Mocked before importing the service, so every call the service makes
// to axios.post/axios.get hits our mock instead of the real Graph API.
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

import {
  sendWhatsappTextMessage,
  sendTemplateMessage,
  sendImageMessage,
  sendDocumentMessage,
  sendInteractiveMessage,
  markMessageAsRead,
} from "../services/whatsappService";

/** Shapes a rejection the way axios actually throws it for an HTTP
 *  error response, so the service's `err?.response?.status` /
 *  `err?.response?.data?.error?.message` reads match reality. */
const graphError = (status: number, message: string) => {
  const err: any = new Error(message);
  err.response = { status, data: { error: { message } } };
  return err;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("whatsappService — successful sends", () => {
  it("sendWhatsappTextMessage returns the Meta message id on success", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { messages: [{ id: "wamid.SENT1" }] },
    });

    const result = await sendWhatsappTextMessage("+254712345678", "Hello");

    expect(result).toEqual({ ok: true, waMessageId: "wamid.SENT1" });
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockedAxios.post.mock.calls[0];
    expect(url).toContain("/messages");
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "254712345678", // '+' and formatting stripped
      type: "text",
      text: { body: "Hello" },
    });
    expect(config?.headers?.Authorization).toMatch(/^Bearer /);
  });

  it("sendTemplateMessage sends the template name, language, and components", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { messages: [{ id: "wamid.TPL1" }] },
    });

    const result = await sendTemplateMessage(
      "254700000000",
      "invoice_ready",
      "en_US",
      [{ type: "body", parameters: [{ type: "text", text: "INV-001" }] }],
    );

    expect(result).toEqual({ ok: true, waMessageId: "wamid.TPL1" });
    const [, body] = mockedAxios.post.mock.calls[0];
    expect(body).toMatchObject({
      type: "template",
      template: {
        name: "invoice_ready",
        language: { code: "en_US" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "INV-001" }] },
        ],
      },
    });
  });

  it("sendImageMessage attaches a caption when provided", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { messages: [{ id: "wamid.IMG1" }] },
    });

    const result = await sendImageMessage(
      "254700000000",
      { link: "https://example.com/receipt.png" },
      "Your receipt",
    );

    expect(result.ok).toBe(true);
    const [, body] = mockedAxios.post.mock.calls[0];
    expect(body).toMatchObject({
      type: "image",
      image: {
        link: "https://example.com/receipt.png",
        caption: "Your receipt",
      },
    });
  });

  it("sendDocumentMessage passes filename and caption through", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { messages: [{ id: "wamid.DOC1" }] },
    });

    const result = await sendDocumentMessage(
      "254700000000",
      { id: "media-123" },
      { filename: "invoice.pdf", caption: "Invoice attached" },
    );

    expect(result.ok).toBe(true);
    const [, body] = mockedAxios.post.mock.calls[0];
    expect(body).toMatchObject({
      type: "document",
      document: {
        id: "media-123",
        filename: "invoice.pdf",
        caption: "Invoice attached",
      },
    });
  });

  it("sendInteractiveMessage passes the interactive object through unchanged", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { messages: [{ id: "wamid.INT1" }] },
    });

    const interactive = {
      type: "button",
      body: { text: "Confirm payment?" },
      action: {
        buttons: [{ type: "reply", reply: { id: "yes", title: "Yes" } }],
      },
    };
    const result = await sendInteractiveMessage("254700000000", interactive);

    expect(result.ok).toBe(true);
    const [, body] = mockedAxios.post.mock.calls[0];
    expect(body).toMatchObject({ type: "interactive", interactive });
  });

  it("markMessageAsRead sends a read-status update for the given message id", async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { success: true } });

    const result = await markMessageAsRead("wamid.INBOUND1");

    expect(result).toEqual({ ok: true });
    const [, body] = mockedAxios.post.mock.calls[0];
    expect(body).toMatchObject({
      status: "read",
      message_id: "wamid.INBOUND1",
    });
  });
});

describe("whatsappService — invalid recipient", () => {
  it("returns Meta's error message and does not retry a 400 (bad recipient)", async () => {
    mockedAxios.post.mockRejectedValueOnce(
      graphError(400, "Invalid parameter: recipient phone number"),
    );

    const result = await sendWhatsappTextMessage("not-a-phone", "Hi");

    expect(result).toEqual({
      ok: false,
      error: "Invalid parameter: recipient phone number",
    });
    // 4xx (other than 429) is not retriable — exactly one attempt.
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});

describe("whatsappService — Meta authentication failure", () => {
  it("returns the auth error without retrying a 401", async () => {
    mockedAxios.post.mockRejectedValueOnce(
      graphError(401, "Error validating access token"),
    );

    const result = await sendWhatsappTextMessage("254700000000", "Hi");

    expect(result).toEqual({
      ok: false,
      error: "Error validating access token",
    });
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});

describe("whatsappService — API error handling / retries", () => {
  it("retries on a 500 and succeeds on the second attempt", async () => {
    mockedAxios.post
      .mockRejectedValueOnce(graphError(500, "Internal server error"))
      .mockResolvedValueOnce({ data: { messages: [{ id: "wamid.RETRY1" }] } });

    const result = await sendWhatsappTextMessage("254700000000", "Hi");

    expect(result).toEqual({ ok: true, waMessageId: "wamid.RETRY1" });
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("retries on 429 (rate limited) up to the retry limit, then surfaces the error", async () => {
    mockedAxios.post.mockRejectedValue(graphError(429, "Rate limit hit"));

    const result = await sendWhatsappTextMessage("254700000000", "Hi");

    expect(result).toEqual({ ok: false, error: "Rate limit hit" });
    // Default retries = 2 → 3 total attempts (1 initial + 2 retries).
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("retries on a network error with no response (e.g. timeout/DNS failure)", async () => {
    const networkErr: any = new Error("timeout of 15000ms exceeded");
    // No `.response` at all — matches how axios throws on timeouts/network errors.
    mockedAxios.post.mockRejectedValue(networkErr);

    const result = await sendWhatsappTextMessage("254700000000", "Hi");

    expect(result).toEqual({
      ok: false,
      error: "timeout of 15000ms exceeded",
    });
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("does not call Graph API at all when required env vars are missing", async () => {
    const originalToken = process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    jest.resetModules();

    // Re-import with the env var gone so the module re-reads process.env.
    const { sendWhatsappTextMessage: sendWithoutConfig } =
      await import("../services/whatsappService");
    const result = await sendWithoutConfig("254700000000", "Hi");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/i);
    expect(mockedAxios.post).not.toHaveBeenCalled();

    process.env.WHATSAPP_ACCESS_TOKEN = originalToken;
    jest.resetModules();
  });
});
