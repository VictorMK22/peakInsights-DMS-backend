import "./testEnv";

// ── Mock: no DB. `thread` is the (newest-last) list of emails in a thread. ──
let thread: any[] = [];
jest.mock("../models/EmailLog", () => ({
  EmailLog: {
    findOne: () => ({
      sort: () => ({
        select: () => ({
          lean: async () => (thread.length ? thread[thread.length - 1] : null),
        }),
      }),
    }),
    updateOne: jest.fn(async () => undefined),
  },
}));

import {
  idOf,
  participantIdsOf,
  isThreadParticipant,
  resolveReplyRecipients,
} from "../services/emailThreadService";

// Valid 24-hex ids so the helpers behave like they do with real ObjectIds.
const ANN = "aaaaaaaaaaaaaaaaaaaaaaa1"; // sender
const BOB = "bbbbbbbbbbbbbbbbbbbbbbb2"; // recipient
const CAL = "ccccccccccccccccccccccc3"; // Cc
const DAN = "ddddddddddddddddddddddd4"; // Cc
const EVE = "eeeeeeeeeeeeeeeeeeeeeee5"; // added to Cc later
const OUT = "fffffffffffffffffffffff6"; // not in the thread

const root: any = {
  _id: "root1",
  senderId: ANN,
  receiverId: BOB,
  ccIds: [CAL, DAN],
};

describe("participantIdsOf / isThreadParticipant", () => {
  it("includes sender, recipient and every Cc", () => {
    expect(participantIdsOf(root).sort()).toEqual([ANN, BOB, CAL, DAN].sort());
  });

  it("works with populated documents", () => {
    const populated = {
      senderId: { _id: ANN },
      receiverId: { _id: BOB },
      ccIds: [{ _id: CAL }],
    };
    expect(participantIdsOf(populated).sort()).toEqual([ANN, BOB, CAL].sort());
    expect(idOf({ _id: CAL })).toBe(CAL);
  });

  it("includes people added to the thread later", () => {
    const r = { ...root, threadParticipantIds: [ANN, BOB, EVE] };
    expect(isThreadParticipant(r, EVE)).toBe(true);
  });

  it("lets a Cc'd person in, and keeps outsiders out", () => {
    expect(isThreadParticipant(root, CAL)).toBe(true);
    expect(isThreadParticipant(root, OUT)).toBe(false);
  });
});

describe("resolveReplyRecipients (reply-all)", () => {
  it("a Cc'd person replies To the sender and Cc's everyone else", async () => {
    thread = [{ _id: "root1", senderId: ANN, receiverId: BOB }];
    const r = await resolveReplyRecipients(root, CAL);
    expect(r.toId).toBe(ANN);
    expect(r.ccIds.sort()).toEqual([BOB, DAN].sort());
    expect(r.replyToEmailId).toBe("root1");
  });

  it("the recipient replies To the sender and keeps all the Cc's on", async () => {
    thread = [{ _id: "root1", senderId: ANN, receiverId: BOB }];
    const r = await resolveReplyRecipients(root, BOB);
    expect(r.toId).toBe(ANN);
    expect(r.ccIds.sort()).toEqual([CAL, DAN].sort());
  });

  it("replies to whoever wrote the last email", async () => {
    thread = [
      { _id: "root1", senderId: ANN, receiverId: BOB },
      { _id: "reply1", senderId: CAL, receiverId: ANN },
    ];
    const r = await resolveReplyRecipients(root, BOB);
    expect(r.toId).toBe(CAL);
    expect(r.ccIds.sort()).toEqual([ANN, DAN].sort());
    expect(r.replyToEmailId).toBe("reply1");
  });

  it("if I wrote the last email, I keep talking to who I last wrote to", async () => {
    thread = [
      { _id: "root1", senderId: ANN, receiverId: BOB },
      { _id: "reply1", senderId: BOB, receiverId: ANN },
    ];
    const r = await resolveReplyRecipients(root, BOB);
    expect(r.toId).toBe(ANN);
    expect(r.ccIds).not.toContain(BOB);
    expect(r.ccIds).not.toContain(ANN);
  });

  it("includes people added to the thread later as Cc", async () => {
    thread = [{ _id: "root1", senderId: ANN, receiverId: BOB }];
    const r = await resolveReplyRecipients(
      { ...root, threadParticipantIds: [ANN, BOB, CAL, DAN, EVE] },
      ANN,
    );
    expect(r.toId).toBe(BOB);
    expect(r.ccIds.sort()).toEqual([CAL, DAN, EVE].sort());
  });

  it("a plain one-to-one thread has no Cc", async () => {
    thread = [{ _id: "root2", senderId: ANN, receiverId: BOB }];
    const r = await resolveReplyRecipients(
      { _id: "root2", senderId: ANN, receiverId: BOB },
      BOB,
    );
    expect(r.toId).toBe(ANN);
    expect(r.ccIds).toEqual([]);
  });
});