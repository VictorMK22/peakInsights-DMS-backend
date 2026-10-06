import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { User } from "../models/User";
import { SupervisorMapping } from "../models/SupervisorMapping";

beforeAll(async () => {
  await startTestDb();
}, 120_000);

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await SupervisorMapping.deleteMany({});
});

const mapTo = async (
  supervisorId: unknown,
  subordinateId: unknown,
  assignedBy: unknown,
) =>
  SupervisorMapping.create({
    supervisorId,
    subordinateId,
    departmentName: "Test",
    assignedBy,
    status: "active",
  });

describe("GET /api/users/me/workspaces", () => {
  it("returns the workspace(s) the supervisor's team uses", async () => {
    const { user: ceo } = await createUserWithToken("ceo");
    const { user: sup, token } = await createUserWithToken("supervisor");
    const { user: a1 } = await createUserWithToken("accountant");
    const { user: a2 } = await createUserWithToken("accountant");
    await mapTo(sup._id, a1._id, ceo._id);
    await mapTo(sup._id, a2._id, ceo._id);

    const res = await request(app)
      .get("/api/users/me/workspaces")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.workspaces).toEqual(["accountant"]);
  });

  it("ignores deactivated team members", async () => {
    const { user: ceo } = await createUserWithToken("ceo");
    const { user: sup, token } = await createUserWithToken("supervisor");
    const { user: sales } = await createUserWithToken("sales_person");
    const { user: gone } = await createUserWithToken("tech");
    await mapTo(sup._id, sales._id, ceo._id);
    await mapTo(sup._id, gone._id, ceo._id);
    await User.findByIdAndUpdate(gone._id, { isActive: false });

    const res = await request(app)
      .get("/api/users/me/workspaces")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.data.workspaces).toEqual(["sales"]);
  });

  it("returns [] for non-supervisors", async () => {
    for (const role of ["ceo", "accountant", "sales_person", "tech"] as const) {
      const { token } = await createUserWithToken(role);
      const res = await request(app)
        .get("/api/users/me/workspaces")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.workspaces).toEqual([]);
    }
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/users/me/workspaces");
    expect(res.status).toBe(401);
  });
});

describe("ICT access (requireIctAccess)", () => {
  it("allows a supervisor whose department is Tech", async () => {
    const { user, token } = await createUserWithToken("supervisor");
    await User.findByIdAndUpdate(user._id, { department: "ICT" });

    const res = await request(app)
      .get("/api/projects")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("still blocks supervisors in other departments", async () => {
    const { user, token } = await createUserWithToken("supervisor");
    await User.findByIdAndUpdate(user._id, { department: "Finance" });

    const res = await request(app)
      .get("/api/projects")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it("still allows CEO and tech, and blocks accountants", async () => {
    const ceo = await createUserWithToken("ceo");
    const tech = await createUserWithToken("tech");
    const acct = await createUserWithToken("accountant");
    const get = (t: string) =>
      request(app).get("/api/projects").set("Authorization", `Bearer ${t}`);

    expect((await get(ceo.token)).status).toBe(200);
    expect((await get(tech.token)).status).toBe(200);
    expect((await get(acct.token)).status).toBe(403);
  });

  it("keeps the demo-data seeder closed to supervisors", async () => {
    const { user, token } = await createUserWithToken("supervisor");
    await User.findByIdAndUpdate(user._id, { department: "ICT" });

    const res = await request(app)
      .post("/api/ict-seed")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

describe("GET /api/analytics/accountant-workspace", () => {
  it("is now open to supervisors, scoped to their own (empty) book", async () => {
    const { token } = await createUserWithToken("supervisor");
    const res = await request(app)
      .get("/api/analytics/accountant-workspace")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.clientCount).toBe(0);
  });

  it("stays closed to sales and tech", async () => {
    for (const role of ["sales_person", "tech"] as const) {
      const { token } = await createUserWithToken(role);
      const res = await request(app)
        .get("/api/analytics/accountant-workspace")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    }
  });
});
