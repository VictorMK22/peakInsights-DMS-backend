import "./testEnv";
import crypto from "crypto";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { ClientModel } from "../models/Client";
import { ClientWhatsappMessageModel } from "../models/ClientWhatsappMessage";

const APP_SECRET = process.env.META_APP_SECRET as string;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN as string;

/** Signs a payload exactly the way Meta does, so tests exercise the
 *  real HMAC check rather than bypassing it. */
const sign = (rawBody: string) =>
  "sha256=" +
  crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");

/** supertest's .send(obj) serializes for us, but we need the *exact*
 *  same bytes to compute a matching signature — so serialize once
 *  ourselves and send that string with an explicit content-type. */
const postSigned = (body: object, signature = sign(JSON.stringify(body))) =>
  request(app)
    .post("/webhooks/whatsapp")
    .set("Content-Type", "application/json")
    .set("x-hub-signature-256", signature)
    .send(JSON.stringify(body));

beforeAll(async () => {
  await startTestDb();
}, 120_000);

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await ClientWhatsappMessageModel.deleteMany({});
  await ClientModel.deleteMany({});
});

describe("GET /webhooks/whatsapp — Meta verification handshake", () => {
  it("echoes hub.challenge and returns 200 for a valid verify token", async () => {
    const res = await request(app).get("/webhooks/whatsapp").query({
      "hub.mode": "subscribe",
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "1234567890",
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe("1234567890");
  });

  it("returns 403 for an invalid verify token", async () => {
    const res = await request(app).get("/webhooks/whatsapp").query({
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong-token",
      "hub.challenge": "1234567890",
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 when hub.mode isn't subscribe", async () => {
    const res = await request(app).get("/webhooks/whatsapp").query({
      "hub.mode": "unsubscribe",
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "1234567890",
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /webhooks/whatsapp — signature verification", () => {
  it("rejects a payload with no signature header", async () => {
    const res = await request(app)
      .post("/webhooks/whatsapp")
      .send({ entry: [] });
    expect(res.status).toBe(401);
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const body = { entry: [] };
    const badSignature =
      "sha256=" +
      crypto
        .createHmac("sha256", "not-the-real-secret")
        .update(JSON.stringify(body))
        .digest("hex");
    const res = await postSigned(body, badSignature);
    expect(res.status).toBe(401);
  });

  it("accepts a correctly-signed payload", async () => {
    const res = await postSigned({ entry: [] });
    expect(res.status).toBe(200);
  });
});

describe("POST /webhooks/whatsapp — incoming messages", () => {
  const buildEntry = (messages: any[] = [], statuses: any[] = []) => ({
    entry: [
      {
        id: "waba-id",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              messages,
              statuses,
            },
          },
        ],
      },
    ],
  });

  it("stores an inbound text message against the matching client", async () => {
    const { user } = await createUserWithToken("ceo");
    const client = await ClientModel.create({
      name: "Jane Client",
      phone: "+254712345678",
      createdBy: user._id,
    });

    const payload = buildEntry([
      {
        id: "wamid.TEXT1",
        from: "254712345678",
        timestamp: `${Math.floor(Date.now() / 1000)}`,
        type: "text",
        text: { body: "Hello there" },
      },
    ]);

    const res = await postSigned(payload);
    expect(res.status).toBe(200);

    // Processing happens after the 200 ack — give the event loop a tick.
    await new Promise((r) => setTimeout(r, 50));

    const stored = await ClientWhatsappMessageModel.findOne({
      waMessageId: "wamid.TEXT1",
    });
    expect(stored).not.toBeNull();
    expect(stored!.clientId.toString()).toBe(client._id.toString());
    expect(stored!.body).toBe("Hello there");
    expect(stored!.messageType).toBe("text");
    expect(stored!.direction).toBe("inbound");
  });

  it("normalizes a location message into structured metadata", async () => {
    const { user } = await createUserWithToken("ceo");
    await ClientModel.create({
      name: "Loc Client",
      phone: "+254700000001",
      createdBy: user._id,
    });

    const payload = buildEntry([
      {
        id: "wamid.LOC1",
        from: "254700000001",
        timestamp: `${Math.floor(Date.now() / 1000)}`,
        type: "location",
        location: { latitude: -1.2921, longitude: 36.8219, name: "Nairobi HQ" },
      },
    ]);

    await postSigned(payload);
    await new Promise((r) => setTimeout(r, 50));

    const stored = await ClientWhatsappMessageModel.findOne({
      waMessageId: "wamid.LOC1",
    });
    expect(stored).not.toBeNull();
    expect(stored!.messageType).toBe("location");
    expect(stored!.metadata?.latitude).toBe(-1.2921);
  });

  it("does not create a duplicate record for a redelivered webhook", async () => {
    const { user } = await createUserWithToken("ceo");
    await ClientModel.create({
      name: "Dup Client",
      phone: "+254700000002",
      createdBy: user._id,
    });

    const payload = buildEntry([
      {
        id: "wamid.DUP1",
        from: "254700000002",
        timestamp: `${Math.floor(Date.now() / 1000)}`,
        type: "text",
        text: { body: "Retry me" },
      },
    ]);

    await postSigned(payload);
    await new Promise((r) => setTimeout(r, 50));
    // Meta redelivers on anything other than a fast 200 — simulate that.
    await postSigned(payload);
    await new Promise((r) => setTimeout(r, 50));

    const count = await ClientWhatsappMessageModel.countDocuments({
      waMessageId: "wamid.DUP1",
    });
    expect(count).toBe(1);
  });

  it("drops messages from numbers that don't match any client, without erroring", async () => {
    const payload = buildEntry([
      {
        id: "wamid.UNKNOWN1",
        from: "254799999999",
        timestamp: `${Math.floor(Date.now() / 1000)}`,
        type: "text",
        text: { body: "Who is this" },
      },
    ]);

    const res = await postSigned(payload);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    const stored = await ClientWhatsappMessageModel.findOne({
      waMessageId: "wamid.UNKNOWN1",
    });
    expect(stored).toBeNull();
  });

  it("updates delivery status on a status webhook", async () => {
    const { user } = await createUserWithToken("ceo");
    const client = await ClientModel.create({
      name: "Status Client",
      phone: "+254700000003",
      createdBy: user._id,
    });
    await ClientWhatsappMessageModel.create({
      clientId: client._id,
      direction: "outbound",
      body: "Hi",
      waMessageId: "wamid.OUT1",
      waStatus: "sent",
      timestamp: new Date(),
    });

    const payload = buildEntry(
      [],
      [
        {
          id: "wamid.OUT1",
          status: "delivered",
          timestamp: `${Math.floor(Date.now() / 1000)}`,
        },
      ],
    );

    await postSigned(payload);
    await new Promise((r) => setTimeout(r, 50));

    const updated = await ClientWhatsappMessageModel.findOne({
      waMessageId: "wamid.OUT1",
    });
    expect(updated!.waStatus).toBe("delivered");
  });
});
