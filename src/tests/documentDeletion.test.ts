import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { DocumentModel } from "../models/Document";
import { ClientModel } from "../models/Client";
import { AppSettingModel } from "../models/AppSetting";
import { User } from "../models/User";

beforeAll(async () => {
  await startTestDb();
}, 120_000);
afterAll(async () => {
  await stopTestDb();
});
afterEach(async () => {
  await DocumentModel.deleteMany({});
  await ClientModel.deleteMany({});
  await AppSettingModel.deleteMany({});
});

type Person = Awaited<ReturnType<typeof createUserWithToken>>;
const auth = (p: Person) => ({ Authorization: `Bearer ${p.token}` });

const techSupervisor = async (): Promise<Person> => {
  const p = await createUserWithToken("supervisor");
  await User.updateOne({ _id: p.user._id }, { department: "ICT" });
  return p;
};

const mkDoc = (owner: Person, title: string, clientId?: unknown) =>
  DocumentModel.create({
    title,
    documentType: "working",
    fileType: "pdf",
    fileName: `${title}.pdf`,
    fileKey: `k/${title}`,
    fileUrl: `https://example.test/${title}`,
    fileSize: 1,
    modifiedBy: owner.user._id,
    ownerId: owner.user._id,
    ...(clientId ? { clientId } : {}),
  });

const setSwitch = (who: Person, on: boolean) =>
  request(app)
    .put("/api/settings/document-deletion")
    .set(auth(who))
    .send({ userDeleteEnabled: on });

const trash = (who: Person, id: unknown) =>
  request(app).delete(`/api/documents/${id}`).set(auth(who));

const isTrashed = async (id: unknown) =>
  (await DocumentModel.findById(id))?.isDeleted === true;

describe("who can flip the switch", () => {
  it("the CEO and a Tech supervisor can; everyone else gets 403", async () => {
    const ceo = await createUserWithToken("ceo");
    const tech = await techSupervisor();
    const otherSup = await createUserWithToken("supervisor"); // no department
    const rep = await createUserWithToken("sales_person");

    expect((await setSwitch(ceo, true)).status).toBe(200);
    expect((await setSwitch(tech, false)).status).toBe(200);
    expect((await setSwitch(otherSup, true)).status).toBe(403);
    expect((await setSwitch(rep, true)).status).toBe(403);
  });

  it("rejects a non-boolean value", async () => {
    const ceo = await createUserWithToken("ceo");
    const res = await request(app)
      .put("/api/settings/document-deletion")
      .set(auth(ceo))
      .send({ userDeleteEnabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("defaults to OFF, and GET tells the UI whether the caller can toggle", async () => {
    const ceo = await createUserWithToken("ceo");
    const rep = await createUserWithToken("sales_person");
    const asCeo = await request(app).get("/api/settings/document-deletion").set(auth(ceo));
    const asRep = await request(app).get("/api/settings/document-deletion").set(auth(rep));
    expect(asCeo.body.data).toMatchObject({ userDeleteEnabled: false, canToggle: true });
    expect(asRep.body.data).toMatchObject({ userDeleteEnabled: false, canToggle: false });
  });
});

describe("regular users", () => {
  it("cannot delete anything while the switch is OFF", async () => {
    const rep = await createUserWithToken("sales_person");
    const d = await mkDoc(rep, "mine");
    const res = await trash(rep, d._id);
    expect(res.status).toBe(403);
    expect(await isTrashed(d._id)).toBe(false);
  });

  it("switch ON: can delete their own documents", async () => {
    const ceo = await createUserWithToken("ceo");
    const rep = await createUserWithToken("sales_person");
    await setSwitch(ceo, true);
    const d = await mkDoc(rep, "mine");
    expect((await trash(rep, d._id)).status).toBe(200);
    expect(await isTrashed(d._id)).toBe(true);
  });

  it("switch ON: can delete a client's document when assigned to that client", async () => {
    const ceo = await createUserWithToken("ceo");
    const accountant = await createUserWithToken("accountant");
    const rep = await createUserWithToken("sales_person");
    await setSwitch(ceo, true);
    const client = await ClientModel.create({
      name: "Acme",
      createdBy: ceo.user._id,
      assignedTo: [accountant.user._id],
    });
    const d = await mkDoc(rep, "uploaded-by-sales", client._id);
    expect((await trash(accountant, d._id)).status).toBe(200);
    expect(await isTrashed(d._id)).toBe(true);
  });

  it("switch ON: still cannot delete another user's document on a client they are NOT assigned to", async () => {
    const ceo = await createUserWithToken("ceo");
    const accountant = await createUserWithToken("accountant");
    const rep = await createUserWithToken("sales_person");
    await setSwitch(ceo, true);
    const client = await ClientModel.create({
      name: "Acme",
      createdBy: ceo.user._id,
      assignedTo: [rep.user._id],
    });
    const d = await mkDoc(rep, "theirs", client._id);
    expect((await trash(accountant, d._id)).status).toBe(403);
    expect(await isTrashed(d._id)).toBe(false);
  });

  it("switch ON: a 'tech' role user is not treated as assigned to every client", async () => {
    const ceo = await createUserWithToken("ceo");
    const tech = await createUserWithToken("tech");
    const rep = await createUserWithToken("sales_person");
    await setSwitch(ceo, true);
    const client = await ClientModel.create({
      name: "Acme",
      createdBy: ceo.user._id,
      assignedTo: [rep.user._id],
    });
    const d = await mkDoc(rep, "theirs", client._id);
    expect((await trash(tech, d._id)).status).toBe(403);
  });

  it("switch ON: accountants can trash but not permanently delete", async () => {
    const ceo = await createUserWithToken("ceo");
    const accountant = await createUserWithToken("accountant");
    await setSwitch(ceo, true);
    const d = await mkDoc(accountant, "mine");
    expect((await trash(accountant, d._id)).status).toBe(200);
    const perm = await request(app)
      .delete(`/api/documents/${d._id}/permanent`)
      .set(auth(accountant));
    expect(perm.status).toBe(403);
    expect(await DocumentModel.findById(d._id)).not.toBeNull();
  });

  it("bulk delete honours the switch per document", async () => {
    const ceo = await createUserWithToken("ceo");
    const rep = await createUserWithToken("sales_person");
    const other = await createUserWithToken("sales_person");
    const mine = await mkDoc(rep, "mine");
    const foreign = await mkDoc(other, "foreign");

    const off = await request(app)
      .post("/api/documents/bulk-delete")
      .set(auth(rep))
      .send({ ids: [mine._id] });
    expect(off.body.data.deletedIds).toEqual([]);

    await setSwitch(ceo, true);
    const on = await request(app)
      .post("/api/documents/bulk-delete")
      .set(auth(rep))
      .send({ ids: [mine._id, foreign._id] });
    expect(on.body.data.deletedIds).toEqual([String(mine._id)]);
    expect(on.body.data.failed).toEqual([{ id: String(foreign._id), reason: "forbidden" }]);
  });
});

describe("the CEO and the Tech supervisor are unaffected by the switch", () => {
  it.each([false, true])("CEO can delete anyone's document (switch %s)", async (on) => {
    const ceo = await createUserWithToken("ceo");
    const rep = await createUserWithToken("sales_person");
    await setSwitch(ceo, on);
    const d = await mkDoc(rep, "theirs");
    expect((await trash(ceo, d._id)).status).toBe(200);
    expect(await isTrashed(d._id)).toBe(true);
  });

  it.each([false, true])("Tech supervisor can delete their own document (switch %s)", async (on) => {
    const ceo = await createUserWithToken("ceo");
    const tech = await techSupervisor();
    await setSwitch(ceo, on);
    const d = await mkDoc(tech, "mine");
    expect((await trash(tech, d._id)).status).toBe(200);
    expect(await isTrashed(d._id)).toBe(true);
  });

  it.each([false, true])("Tech supervisor cannot delete someone else's document (switch %s)", async (on) => {
    const ceo = await createUserWithToken("ceo");
    const tech = await techSupervisor();
    const rep = await createUserWithToken("sales_person");
    await setSwitch(ceo, on);
    const client = await ClientModel.create({
      name: "Acme",
      createdBy: ceo.user._id,
      assignedTo: [tech.user._id], // even when assigned
    });
    const d = await mkDoc(rep, "theirs", client._id);
    expect((await trash(tech, d._id)).status).toBe(403);
    expect(await isTrashed(d._id)).toBe(false);
  });
});