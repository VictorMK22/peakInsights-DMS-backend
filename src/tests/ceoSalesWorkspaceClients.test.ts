import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { ClientModel } from "../models/Client";
import { User } from "../models/User";
import { SupervisorMapping } from "../models/SupervisorMapping";
import * as emailService from "../services/emailService";
import { releaseClientsOfUser } from "../services/departedStaffService";

beforeAll(async () => {
  await startTestDb();
}, 120_000);
afterAll(async () => {
  await stopTestDb();
});
afterEach(async () => {
  await ClientModel.deleteMany({});
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const post = (token: string, body: object) =>
  request(app).post("/api/clients").set(auth(token)).send(body);
const list = (token: string, qs: string) =>
  request(app).get(`/api/clients?${qs}`).set(auth(token));
const stage = (token: string, id: string, s: string) =>
  request(app).patch(`/api/clients/${id}/stage`).set(auth(token)).send({ stage: s });
const names = (res: request.Response) =>
  res.body.data.clients.map((c: any) => c.name).sort();

describe("prospects vs existing clients", () => {
  it("a sales person's client is a prospect; the CEO's plain add is an existing client", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { token: sales } = await createUserWithToken("sales_person");

    const lead = await post(sales, { name: "Sales Lead" });
    expect(lead.status).toBe(201);
    expect(lead.body.data.client.isSalesLead).toBe(true);
    expect(lead.body.data.client.salesStage).toBe("in_discussion");

    const existing = await post(ceo, { name: "Old Client" });
    expect(existing.status).toBe(201);
    expect(existing.body.data.client.isSalesLead).toBe(false);
    expect(existing.body.data.client.salesStage).toBeUndefined();
  });

  it("the CEO adding with asLead (Sales workspace) creates a prospect assigned to them", async () => {
    const { user, token: ceo } = await createUserWithToken("ceo");
    const res = await post(ceo, { name: "CEO Prospect", asLead: true });
    expect(res.status).toBe(201);
    expect(res.body.data.client.isSalesLead).toBe(true);
    expect(res.body.data.client.salesStage).toBe("in_discussion");
    expect(res.body.data.client.assignedTo.map(String)).toEqual([String(user._id)]);
  });

  it("splits the CEO's list into Prospects and Won/Existing tabs", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { token: sales } = await createUserWithToken("sales_person");
    await post(sales, { name: "Sales Lead" });
    await post(ceo, { name: "CEO Prospect", asLead: true });
    await post(ceo, { name: "Old Client" });

    expect(names(await list(ceo, "tab=prospects"))).toEqual(["CEO Prospect", "Sales Lead"]);
    expect(names(await list(ceo, "tab=won"))).toEqual(["Old Client"]);
  });

  it("a won prospect moves from the Prospects tab to the Won tab", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const made = await post(ceo, { name: "CEO Prospect", asLead: true });
    const id = made.body.data.client._id;
    expect((await stage(ceo, id, "won")).status).toBe(200);

    expect(names(await list(ceo, "tab=prospects"))).toEqual([]);
    expect(names(await list(ceo, "tab=won"))).toEqual(["CEO Prospect"]);
  });

  it("a lost prospect stays under Prospects", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const made = await post(ceo, { name: "Gone Cold", asLead: true });
    await stage(ceo, made.body.data.client._id, "lost");
    expect(names(await list(ceo, "tab=prospects"))).toEqual(["Gone Cold"]);
  });

  it("existing clients cannot be moved through the pipeline", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const made = await post(ceo, { name: "Old Client" });
    const res = await stage(ceo, made.body.data.client._id, "proposal_sent");
    expect(res.status).toBe(400);
    const stored = await ClientModel.findById(made.body.data.client._id).lean();
    expect(stored!.isSalesLead).toBe(false);
  });

  it("mine=true limits the CEO to their own assigned clients", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { token: sales } = await createUserWithToken("sales_person");
    await post(sales, { name: "Sales Lead" });
    await post(ceo, { name: "CEO Prospect", asLead: true });
    expect(names(await list(ceo, "mine=true"))).toEqual(["CEO Prospect"]);
    expect(names(await list(ceo, ""))).toEqual(["CEO Prospect", "Sales Lead"]);
  });

  it("a sales person cannot add a client the CEO already has", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { token: sales } = await createUserWithToken("sales_person");
    await post(ceo, { name: "Acme Ltd", email: "info@acme.co.ke" });
    const res = await post(sales, { name: "Someone Else", email: "INFO@acme.co.ke" });
    expect(res.status).toBe(409);
  });
});

describe("allocating won clients", () => {
  const won = async (ceo: string) => {
    const made = await post(ceo, { name: "Won Co", asLead: true });
    const id = made.body.data.client._id;
    await stage(ceo, id, "won");
    return id as string;
  };
  const allocate = (token: string, id: string, accountantId: string) =>
    request(app)
      .post(`/api/clients/${id}/allocate-accountant`)
      .set(auth(token))
      .send({ accountantId });

  it("a won client waits on the CEO's allocation list", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    await won(ceo);
    const res = await request(app).get("/api/clients/awaiting-allocation").set(auth(ceo));
    expect(res.body.data.clients.map((c: any) => c.name)).toEqual(["Won Co"]);
  });

  it("the CEO can allocate a won client to themself", async () => {
    const { user, token: ceo } = await createUserWithToken("ceo");
    const id = await won(ceo);
    const res = await allocate(ceo, id, String(user._id));
    expect(res.status).toBe(200);
    expect(String(res.body.data.client.allocatedAccountant._id)).toBe(String(user._id));

    const pending = await request(app).get("/api/clients/awaiting-allocation").set(auth(ceo));
    expect(pending.body.data.clients).toEqual([]);
  });

  it("the CEO can allocate to an accountant", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { user: acct } = await createUserWithToken("accountant");
    const id = await won(ceo);
    const res = await allocate(ceo, id, String(acct._id));
    expect(res.status).toBe(200);
  });

  describe("several accountants on one won client", () => {
    const allocateMany = (token: string, id: string, accountantIds: string[]) =>
      request(app)
        .post(`/api/clients/${id}/allocate-accountant`)
        .set(auth(token))
        .send({ accountantIds });
    // A client a sales person won — they stay on it while accountants serve.
    const wonBySales = async (sales: string) => {
      const made = await post(sales, { name: "Sales Win" });
      const id = made.body.data.client._id as string;
      await stage(sales, id, "won");
      return id;
    };

    it("allocates two accountants like an existing client: both assigned, first is primary, sales person kept", async () => {
      const { token: ceo } = await createUserWithToken("ceo");
      const { user: salesUser, token: sales } = await createUserWithToken("sales_person");
      const { user: a } = await createUserWithToken("accountant");
      const { user: b } = await createUserWithToken("accountant");
      const id = await wonBySales(sales);

      const res = await allocateMany(ceo, id, [String(a._id), String(b._id)]);
      expect(res.status).toBe(200);

      const stored = await ClientModel.findById(id).lean();
      expect(stored!.assignedTo.map(String).sort()).toEqual(
        [String(salesUser._id), String(a._id), String(b._id)].sort(),
      );
      expect(String(stored!.allocatedAccountant)).toBe(String(a._id));

      const pending = await request(app).get("/api/clients/awaiting-allocation").set(auth(ceo));
      expect(pending.body.data.clients).toEqual([]);
    });

    it("a re-allocation replaces the team, keeps the primary if still on it, and keeps the sales person", async () => {
      const { token: ceo } = await createUserWithToken("ceo");
      const { user: salesUser, token: sales } = await createUserWithToken("sales_person");
      const { user: a } = await createUserWithToken("accountant");
      const { user: b } = await createUserWithToken("accountant");
      const { user: c } = await createUserWithToken("accountant");
      const id = await wonBySales(sales);
      await allocateMany(ceo, id, [String(a._id), String(b._id)]);

      const res = await allocateMany(ceo, id, [String(b._id), String(c._id)]);
      expect(res.status).toBe(200);
      const stored = await ClientModel.findById(id).lean();
      expect(stored!.assignedTo.map(String).sort()).toEqual(
        [String(salesUser._id), String(b._id), String(c._id)].sort(),
      );
      // a (the old primary) is gone, so the first of the new list takes over
      expect(String(stored!.allocatedAccountant)).toBe(String(b._id));

      await allocateMany(ceo, id, [String(c._id), String(b._id)]);
      // b is still on the team and already primary — it does not jump to c
      expect(String((await ClientModel.findById(id).lean())!.allocatedAccountant)).toBe(String(b._id));
    });

    it("notifies and emails only the newly added accountants", async () => {
      const sent = jest
        .spyOn(emailService, "sendClientAssignedEmail")
        .mockResolvedValue(undefined);
      try {
        const { token: ceo } = await createUserWithToken("ceo");
        const { token: sales } = await createUserWithToken("sales_person");
        const { user: a } = await createUserWithToken("accountant");
        const { user: b } = await createUserWithToken("accountant");
        const id = await wonBySales(sales);

        await allocateMany(ceo, id, [String(a._id)]);
        expect(sent).toHaveBeenCalledTimes(1);
        sent.mockClear();
        await allocateMany(ceo, id, [String(a._id), String(b._id)]);
        expect(sent).toHaveBeenCalledTimes(1);
        expect(sent.mock.calls[0][0].assigneeTo).toBe(b.email);
      } finally {
        sent.mockRestore();
      }
    });

    it("rejects an empty list, and a list with anyone who cannot serve a client", async () => {
      const { token: ceo } = await createUserWithToken("ceo");
      const { token: sales, user: rep } = await createUserWithToken("sales_person");
      const { user: a } = await createUserWithToken("accountant");
      const id = await wonBySales(sales);

      expect((await allocateMany(ceo, id, [])).status).toBe(400);
      expect((await allocateMany(ceo, id, [String(a._id), String(rep._id)])).status).toBe(400);
      expect((await allocateMany(ceo, id, ["not-an-id"])).status).toBe(400);
      expect((await ClientModel.findById(id).lean())!.allocatedAccountant).toBeUndefined();
    });

    it("the older single accountantId form adds an accountant and replaces the previous primary", async () => {
      const { token: ceo } = await createUserWithToken("ceo");
      const { token: sales } = await createUserWithToken("sales_person");
      const { user: a } = await createUserWithToken("accountant");
      const { user: b } = await createUserWithToken("accountant");
      const id = await wonBySales(sales);
      await allocate(ceo, id, String(a._id));
      await allocate(ceo, id, String(b._id));
      const stored = await ClientModel.findById(id).lean();
      expect(stored!.assignedTo.map(String)).not.toContain(String(a._id));
      expect(stored!.assignedTo.map(String)).toContain(String(b._id));
      expect(String(stored!.allocatedAccountant)).toBe(String(b._id));
    });

    it("when the primary accountant leaves, another accountant takes over instead of the client going back to 'awaiting'", async () => {
      const { token: ceo } = await createUserWithToken("ceo");
      const { token: sales } = await createUserWithToken("sales_person");
      const { user: a } = await createUserWithToken("accountant");
      const { user: b } = await createUserWithToken("accountant");
      const id = await wonBySales(sales);
      await allocateMany(ceo, id, [String(a._id), String(b._id)]);

      const result = await releaseClientsOfUser(String(a._id));
      expect(result.needReallocation).toBe(0);
      const stored = await ClientModel.findById(id).lean();
      expect(stored!.assignedTo.map(String)).not.toContain(String(a._id));
      expect(String(stored!.allocatedAccountant)).toBe(String(b._id));
      expect(stored!.needsReallocation).toBeFalsy();

      // the last accountant leaving does send it back to the CEO's queue
      const last = await releaseClientsOfUser(String(b._id));
      expect(last.needReallocation).toBe(1);
      const after = await ClientModel.findById(id).lean();
      expect(after!.allocatedAccountant).toBeUndefined();
      expect(after!.needsReallocation).toBe(true);
    });

    it("assigning accountants to a won client the ordinary way sets the primary accountant too", async () => {
      const { token: ceo } = await createUserWithToken("ceo");
      const { token: sales } = await createUserWithToken("sales_person");
      const { user: a } = await createUserWithToken("accountant");
      const { user: b } = await createUserWithToken("accountant");
      const id = await wonBySales(sales);
      const assign = (userIds: string[]) =>
        request(app).post(`/api/clients/${id}/assign`).set(auth(ceo)).send({ userIds });

      expect((await assign([String(a._id), String(b._id)])).status).toBe(200);
      expect(String((await ClientModel.findById(id).lean())!.allocatedAccountant)).toBe(String(a._id));

      // the primary is removed → another accountant still serving takes over
      expect((await assign([String(b._id)])).status).toBe(200);
      expect(String((await ClientModel.findById(id).lean())!.allocatedAccountant)).toBe(String(b._id));
    });
  });

  it("rejects allocating to someone who is not an accountant or the CEO", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { user: rep } = await createUserWithToken("sales_person");
    const id = await won(ceo);
    expect((await allocate(ceo, id, String(rep._id))).status).toBe(400);
  });

  it("rejects the CEO naming a different CEO account as 'themself'", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const other = await User.create({
      name: "Other CEO", email: "otherceo@test.com", password: "Password123!",
      role: "ceo", accountStatus: "active", isActive: true,
    });
    const id = await won(ceo);
    expect((await allocate(ceo, id, String(other._id))).status).toBe(400);
  });

  it("still refuses to allocate a client that has not been won", async () => {
    const { user, token: ceo } = await createUserWithToken("ceo");
    const made = await post(ceo, { name: "Still Talking", asLead: true });
    expect((await allocate(ceo, made.body.data.client._id, String(user._id))).status).toBe(400);
  });
});

describe("assigning clients", () => {
  const assign = (token: string, id: string, userIds: string[]) =>
    request(app).post(`/api/clients/${id}/assign`).set(auth(token)).send({ userIds });

  it("an existing client can be assigned to accountants and to the CEO, not to anyone else", async () => {
    const { user: ceoUser, token: ceo } = await createUserWithToken("ceo");
    const { user: acct } = await createUserWithToken("accountant");
    const { user: rep } = await createUserWithToken("sales_person");
    const made = await post(ceo, { name: "Old Client" });
    const id = made.body.data.client._id;

    expect((await assign(ceo, id, [String(acct._id)])).status).toBe(200);
    expect((await assign(ceo, id, [String(acct._id), String(ceoUser._id)])).status).toBe(200);
    expect((await assign(ceo, id, [String(rep._id)])).status).toBe(400);
  });

  it("a prospect can be assigned to sales people, not to accountants", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { user: acct } = await createUserWithToken("accountant");
    const { user: rep } = await createUserWithToken("sales_person");
    const made = await post(ceo, { name: "CEO Prospect", asLead: true });
    const id = made.body.data.client._id;

    expect((await assign(ceo, id, [String(rep._id)])).status).toBe(200);
    expect((await assign(ceo, id, [String(acct._id)])).status).toBe(400);
  });

  it("keeps people who are already on the client when others are added", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { token: sales, user: rep } = await createUserWithToken("sales_person");
    const { user: acct } = await createUserWithToken("accountant");
    const lead = await post(sales, { name: "Won By Rep" });
    const id = lead.body.data.client._id;
    await stage(sales, id, "won");
    // the rep who won it stays assigned while an accountant is added
    const res = await assign(ceo, id, [String(rep._id), String(acct._id)]);
    expect(res.status).toBe(200);
  });
});


describe("accountant supervisors and bulk assignment", () => {
  const assign = (token: string, id: string, userIds: string[]) =>
    request(app).post(`/api/clients/${id}/assign`).set(auth(token)).send({ userIds });
  const bulk = (token: string, clientIds: string[], userIds: string[]) =>
    request(app).post("/api/clients/bulk-assign").set(auth(token)).send({ clientIds, userIds });
  const employees = (token: string) =>
    request(app).get("/api/clients/employees").set(auth(token));

  /** A supervisor whose active team is the given users. */
  const supervisorOf = async (team: string[], department?: string) => {
    const { user } = await createUserWithToken("supervisor");
    if (department) await User.updateOne({ _id: user._id }, { department });
    for (const id of team) {
      await SupervisorMapping.create({
        supervisorId: user._id,
        subordinateId: id,
        departmentName: department ?? "Team",
        assignedBy: user._id,
        status: "active",
      });
    }
    return user;
  };
  const existing = async (ceo: string, name: string) =>
    (await post(ceo, { name })).body.data.client._id as string;

  afterEach(async () => {
    await SupervisorMapping.deleteMany({});
    await User.deleteMany({});
  });

  it("the CEO's assignee list has accountants and accountant supervisors only, not other supervisors", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { user: acct } = await createUserWithToken("accountant");
    const { user: rep } = await createUserWithToken("sales_person");
    const acctSup = await supervisorOf([String(acct._id)]);
    const salesSup = await supervisorOf([String(rep._id)]);
    const financeSup = await supervisorOf([], "Finance"); // no team yet, Finance dept

    const res = await employees(ceo);
    const ids = res.body.data.employees.map((e: any) => e._id);
    expect(ids).toContain(String(acct._id));
    expect(ids).toContain(String(acctSup._id));
    expect(ids).toContain(String(financeSup._id));
    expect(ids).not.toContain(String(salesSup._id));
    const flagged = res.body.data.employees.find((e: any) => e._id === String(acctSup._id));
    expect(flagged.accountantSupervisor).toBe(true);
  });

  it("an existing client can be assigned to an accountant supervisor, but not to another kind of supervisor", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { user: acct } = await createUserWithToken("accountant");
    const { user: rep } = await createUserWithToken("sales_person");
    const acctSup = await supervisorOf([String(acct._id)]);
    const salesSup = await supervisorOf([String(rep._id)]);
    const id = await existing(ceo, "Old Client");

    expect((await assign(ceo, id, [String(acctSup._id)])).status).toBe(200);
    expect((await assign(ceo, id, [String(acctSup._id), String(salesSup._id)])).status).toBe(400);
  });

  it("a won client can be allocated to an accountant supervisor", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { user: acct } = await createUserWithToken("accountant");
    const acctSup = await supervisorOf([String(acct._id)]);
    const made = await post(ceo, { name: "Won Co", asLead: true });
    const id = made.body.data.client._id;
    await stage(ceo, id, "won");
    const res = await request(app)
      .post(`/api/clients/${id}/allocate-accountant`)
      .set(auth(ceo))
      .send({ accountantId: String(acctSup._id) });
    expect(res.status).toBe(200);
  });

  it("assigns several existing clients to an accountant in one request", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { user: acct } = await createUserWithToken("accountant");
    const a = await existing(ceo, "Client A");
    const b = await existing(ceo, "Client B");
    const c = await existing(ceo, "Client C");

    const res = await bulk(ceo, [a, b, c], [String(acct._id)]);
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(3);
    for (const id of [a, b, c]) {
      const stored = await ClientModel.findById(id).lean();
      expect(stored!.assignedTo.map(String)).toContain(String(acct._id));
    }
  });

  it("only adds people: existing assignees stay, and re-running changes nothing", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { user: first } = await createUserWithToken("accountant");
    const { user: second } = await createUserWithToken("accountant");
    const id = await existing(ceo, "Client A");
    await assign(ceo, id, [String(first._id)]);

    const res = await bulk(ceo, [id], [String(second._id)]);
    expect(res.body.data.updated).toBe(1);
    const stored = await ClientModel.findById(id).lean();
    expect(stored!.assignedTo.map(String).sort()).toEqual(
      [String(first._id), String(second._id)].sort(),
    );

    const again = await bulk(ceo, [id], [String(second._id)]);
    expect(again.body.data.updated).toBe(0);
    expect(again.body.data.alreadyAssigned).toBe(1);
    expect((await ClientModel.findById(id).lean())!.assignedTo).toHaveLength(2);
  });

  it("allocates won clients that have no accountant yet, and keeps an existing allocation", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { user: first } = await createUserWithToken("accountant");
    const { user: second } = await createUserWithToken("accountant");
    const wonId = async (name: string) => {
      const made = await post(ceo, { name, asLead: true });
      await stage(ceo, made.body.data.client._id, "won");
      return made.body.data.client._id as string;
    };
    const fresh = await wonId("Fresh Win");
    const taken = await wonId("Already Served");
    await request(app)
      .post(`/api/clients/${taken}/allocate-accountant`)
      .set(auth(ceo))
      .send({ accountantId: String(first._id) });

    const res = await bulk(ceo, [fresh, taken], [String(second._id)]);
    expect(res.status).toBe(200);
    expect(String((await ClientModel.findById(fresh).lean())!.allocatedAccountant)).toBe(String(second._id));
    expect(String((await ClientModel.findById(taken).lean())!.allocatedAccountant)).toBe(String(first._id));

    const pending = await request(app).get("/api/clients/awaiting-allocation").set(auth(ceo));
    expect(pending.body.data.clients).toEqual([]);
  });

  it("lets the CEO include themself and accountant supervisors in a bulk assignment", async () => {
    const { user: ceoUser, token: ceo } = await createUserWithToken("ceo");
    const { user: acct } = await createUserWithToken("accountant");
    const acctSup = await supervisorOf([String(acct._id)]);
    const id = await existing(ceo, "Client A");
    const res = await bulk(ceo, [id], [String(ceoUser._id), String(acctSup._id)]);
    expect(res.status).toBe(200);
  });

  it("refuses prospects, sales people, other supervisors and non-CEO callers", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { token: acctToken, user: acct } = await createUserWithToken("accountant");
    const { user: rep } = await createUserWithToken("sales_person");
    const salesSup = await supervisorOf([String(rep._id)]);
    const id = await existing(ceo, "Client A");
    const prospect = (await post(ceo, { name: "Prospect", asLead: true })).body.data.client._id;

    expect((await bulk(ceo, [id, prospect], [String(acct._id)])).status).toBe(400);
    expect((await bulk(ceo, [id], [String(rep._id)])).status).toBe(400);
    expect((await bulk(ceo, [id], [String(salesSup._id)])).status).toBe(400);
    expect((await bulk(acctToken, [id], [String(acct._id)])).status).toBe(403);
    // nothing was changed by the refused requests
    expect((await ClientModel.findById(id).lean())!.assignedTo).toHaveLength(0);
  });

  it("emails each assignee once: a bulk assignment sends one email listing all their clients", async () => {
    const sent = jest
      .spyOn(emailService, "sendClientAssignedEmail")
      .mockResolvedValue(undefined);
    try {
      const { token: ceo } = await createUserWithToken("ceo");
      const { user: acct } = await createUserWithToken("accountant");
      const a = await existing(ceo, "Client A");
      const b = await existing(ceo, "Client B");
      const c = await existing(ceo, "Client C");

      await bulk(ceo, [a, b, c], [String(acct._id)]);
      expect(sent).toHaveBeenCalledTimes(1);
      const data = sent.mock.calls[0][0];
      expect(data.assigneeTo).toBe(acct.email);
      expect(data.clients.map((x) => x.name).sort()).toEqual(["Client A", "Client B", "Client C"]);

      // re-running adds nobody new, so nobody is emailed again
      sent.mockClear();
      await bulk(ceo, [a, b, c], [String(acct._id)]);
      expect(sent).not.toHaveBeenCalled();
    } finally {
      sent.mockRestore();
    }
  });

  it("emails a newly assigned accountant on single assign and allocate, but not the CEO themself", async () => {
    const sent = jest
      .spyOn(emailService, "sendClientAssignedEmail")
      .mockResolvedValue(undefined);
    try {
      const { user: ceoUser, token: ceo } = await createUserWithToken("ceo");
      const { user: acct } = await createUserWithToken("accountant");
      const id = await existing(ceo, "Client A");

      await assign(ceo, id, [String(ceoUser._id)]);
      expect(sent).not.toHaveBeenCalled();

      await assign(ceo, id, [String(ceoUser._id), String(acct._id)]);
      expect(sent).toHaveBeenCalledTimes(1);
      expect(sent.mock.calls[0][0].assigneeTo).toBe(acct.email);

      sent.mockClear();
      const won = (await post(ceo, { name: "Won Co", asLead: true })).body.data.client._id;
      await stage(ceo, won, "won");
      await request(app)
        .post(`/api/clients/${won}/allocate-accountant`)
        .set(auth(ceo))
        .send({ accountantId: String(acct._id) });
      expect(sent).toHaveBeenCalledTimes(1);
    } finally {
      sent.mockRestore();
    }
  });

  it("names the client by its company (falling back to the contact name) in the email and notification", async () => {
    const sent = jest
      .spyOn(emailService, "sendClientAssignedEmail")
      .mockResolvedValue(undefined);
    try {
      const { token: ceo } = await createUserWithToken("ceo");
      const { user: acct } = await createUserWithToken("accountant");
      const withCompany = (
        await post(ceo, { name: "Asha Kamenge", company: "Kamenge Traders Ltd" })
      ).body.data.client._id as string;
      const noCompany = await existing(ceo, "Solo Person");

      // single assign
      await assign(ceo, withCompany, [String(acct._id)]);
      expect(sent.mock.calls[0][0].clients).toEqual([
        { id: withCompany, name: "Kamenge Traders Ltd" },
      ]);

      // bulk assign: the company is used where there is one, the name where not
      sent.mockClear();
      const { user: acct2 } = await createUserWithToken("accountant");
      await bulk(ceo, [withCompany, noCompany], [String(acct2._id)]);
      expect(sent.mock.calls[0][0].clients.map((c) => c.name).sort()).toEqual([
        "Kamenge Traders Ltd",
        "Solo Person",
      ]);
    } finally {
      sent.mockRestore();
    }
  });

  it("a failing email never fails the assignment", async () => {
    const sent = jest
      .spyOn(emailService, "sendClientAssignedEmail")
      .mockRejectedValue(new Error("mail down"));
    try {
      const { token: ceo } = await createUserWithToken("ceo");
      const { user: acct } = await createUserWithToken("accountant");
      const id = await existing(ceo, "Client A");
      const res = await bulk(ceo, [id], [String(acct._id)]);
      expect(res.status).toBe(200);
      expect((await ClientModel.findById(id).lean())!.assignedTo.map(String)).toContain(String(acct._id));
    } finally {
      sent.mockRestore();
    }
  });

  it("validates the request body", async () => {
    const { token: ceo } = await createUserWithToken("ceo");
    const { user: acct } = await createUserWithToken("accountant");
    const id = await existing(ceo, "Client A");
    expect((await bulk(ceo, [], [String(acct._id)])).status).toBe(400);
    expect((await bulk(ceo, [id], [])).status).toBe(400);
    expect((await bulk(ceo, ["not-an-id"], [String(acct._id)])).status).toBe(400);
  });
});