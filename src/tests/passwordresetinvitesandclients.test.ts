import "./testEnv";
import request from "supertest";
import jwt from "jsonwebtoken";
import crypto from "crypto";

// Capture outgoing email instead of calling Resend.
jest.mock("../services/emailService", () => ({
  ...jest.requireActual("../services/emailService"),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendPasswordChangedEmail: jest.fn().mockResolvedValue(undefined),
  sendAccountCreatedByCEOEmail: jest.fn().mockResolvedValue(true),
}));

import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { User } from "../models/User";
import { ClientModel } from "../models/Client";
import {
  sendPasswordResetEmail,
  sendAccountCreatedByCEOEmail,
} from "../services/emailService";

const resetMail = sendPasswordResetEmail as jest.Mock;
const inviteMail = sendAccountCreatedByCEOEmail as jest.Mock;

beforeAll(async () => {
  await startTestDb();
}, 120_000);
afterAll(async () => {
  await stopTestDb();
});
beforeEach(() => jest.clearAllMocks());

// NOTE: /forgot-password is rate limited to 5 requests / 15 min / IP and
// the limiter is in-memory for the whole file, so keep forgot calls ≤ 5.
describe("password reset by email", () => {
  it("answers identically for unknown emails and sends nothing", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "nobody@test.com" });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if that email exists/i);
    expect(resetMail).not.toHaveBeenCalled();
  });

  it("rejects non-string emails (NoSQL injection attempt)", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: { $ne: null } });
    expect(res.status).toBe(400);
    expect(resetMail).not.toHaveBeenCalled();
  });

  it("full flow: email → reset → new password works, old sessions die, link is single-use", async () => {
    const { user } = await createUserWithToken("accountant", {
      email: "flow@test.com",
    });
    // A session issued a minute before the reset
    const oldToken = jwt.sign(
      {
        userId: user._id.toString(),
        role: user.role,
        email: user.email,
        iat: Math.floor(Date.now() / 1000) - 60,
      },
      process.env.JWT_SECRET as string,
    );

    const fp = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "Flow@Test.com " }); // case/whitespace tolerated
    expect(fp.status).toBe(200);
    expect(fp.body.dev_resetUrl).toBeUndefined(); // never leaked outside development
    expect(resetMail).toHaveBeenCalledTimes(1);
    const [to, , token] = resetMail.mock.calls[0];
    expect(to).toBe("flow@test.com");
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Only a hash is stored
    const stored = await User.findById(user._id).select("+passwordResetToken");
    expect(stored?.passwordResetToken).toBe(
      crypto.createHash("sha256").update(token).digest("hex"),
    );

    // Repeat request inside the cooldown does not send another email
    await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "flow@test.com" });
    expect(resetMail).toHaveBeenCalledTimes(1);

    // Weak password is a 400 and does NOT burn the token
    const weak = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: "flow@test.com", token, newPassword: "short" });
    expect(weak.status).toBe(400);

    const ok = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: "flow@test.com", token, newPassword: "BrandNewPass1!" });
    expect(ok.status).toBe(200);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "flow@test.com", password: "BrandNewPass1!" });
    expect(login.status).toBe(200);

    // Session from before the reset is rejected; the fresh one works
    const stale = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${oldToken}`);
    expect(stale.status).toBe(401);
    const fresh = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${login.body.data.token}`);
    expect(fresh.status).toBe(200);

    // Single use
    const again = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: "flow@test.com", token, newPassword: "AnotherPass1!" });
    expect(again.status).toBe(400);
  });

  it("rejects an expired token", async () => {
    const { user } = await createUserWithToken("tech", {
      email: "expired@test.com",
    });
    const token = crypto.randomBytes(32).toString("hex");
    await User.updateOne(
      { _id: user._id },
      {
        passwordResetToken: crypto
          .createHash("sha256")
          .update(token)
          .digest("hex"),
        passwordResetExpires: new Date(Date.now() - 1000),
      },
    );
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({
        email: "expired@test.com",
        token,
        newPassword: "BrandNewPass1!",
      });
    expect(res.status).toBe(400);
  });

  it("does not email deactivated accounts", async () => {
    const { user } = await createUserWithToken("tech", {
      email: "off@test.com",
    });
    await User.updateOne({ _id: user._id }, { isActive: false });
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "off@test.com" });
    expect(res.status).toBe(200);
    expect(resetMail).not.toHaveBeenCalled();
  });
});

describe("login details emailed when the CEO adds a user", () => {
  it("sends the invite identifying the CEO as sender and reports emailSent", async () => {
    const { user: ceo, token } = await createUserWithToken("ceo", {
      name: "Jane Doe",
      email: "ceo@test.com",
    });
    const res = await request(app)
      .post("/api/users/accountant")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "New Acc",
        email: "newacc@test.com",
        password: "TempPass123!",
      });
    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(true);
    expect(inviteMail).toHaveBeenCalledWith(
      "newacc@test.com",
      "New Acc",
      "TempPass123!",
      "accountant",
      { name: "Jane Doe", email: ceo.email, role: "ceo" },
    );
  });

  it("still creates the account but reports emailSent:false when delivery fails", async () => {
    inviteMail.mockResolvedValueOnce(false);
    const { token } = await createUserWithToken("ceo");
    const res = await request(app)
      .post("/api/users/sales-person")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Sales S",
        email: "sales-s@test.com",
        password: "TempPass123!",
      });
    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false);
    expect(await User.findOne({ email: "sales-s@test.com" })).not.toBeNull();
  });
});

describe("account creation is CEO-only", () => {
  it.each([
    ["tech", "supervisor"],
    ["tech", "sales-person"],
    ["tech", "accountant"],
    ["tech", "tech"],
    ["supervisor", "supervisor"],
    ["sales_person", "accountant"],
  ] as const)("%s cannot create via /users/%s", async (role, path) => {
    const { token } = await createUserWithToken(role);
    const res = await request(app)
      .post(`/api/users/${path}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "X",
        email: `x-${role}-${path}@test.com`,
        password: "TempPass123!",
      });
    expect(res.status).toBe(403);
    expect(inviteMail).not.toHaveBeenCalled();
    expect(
      await User.findOne({ email: `x-${role}-${path}@test.com` }),
    ).toBeNull();
  });
});

describe("clients no longer carry an opening balance", () => {
  const post = (token: string, body: object) =>
    request(app)
      .post("/api/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Acme", ...body });

  it("creates a client without any opening balance", async () => {
    const { token } = await createUserWithToken("ceo");
    const res = await post(token, {});
    expect(res.status).toBe(201);
    expect(res.body.data.client.openingBalance).toBeUndefined();
    expect(res.body.data.client.openingBalanceDate).toBeUndefined();
  });

  it("ignores an opening balance sent by an older client app", async () => {
    const { token } = await createUserWithToken("ceo");
    const res = await post(token, { openingBalance: "1500.50" });
    expect(res.status).toBe(201);
    const stored = await ClientModel.findById(res.body.data.client._id).lean();
    expect((stored as any).openingBalance).toBeUndefined();
  });

  it("does not let a client update write an opening balance", async () => {
    const { token } = await createUserWithToken("ceo");
    const created = await post(token, {});
    const id = created.body.data.client._id;
    const res = await request(app)
      .put(`/api/clients/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Acme 2", openingBalance: 250 });
    expect(res.status).toBe(200);
    const stored = await ClientModel.findById(id).lean();
    expect(stored?.name).toBe("Acme 2");
    expect((stored as any).openingBalance).toBeUndefined();
  });

  it("no longer exposes an invoices endpoint for clients", async () => {
    const { token } = await createUserWithToken("ceo");
    const created = await post(token, {});
    const id = created.body.data.client._id;
    const res = await request(app)
      .get(`/api/clients/${id}/invoices`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});