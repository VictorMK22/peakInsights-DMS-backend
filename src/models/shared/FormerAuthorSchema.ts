import { Schema } from "mongoose";

// Snapshot of WHO wrote a client communication (email, note, call, meeting,
// WhatsApp message), taken when that staff member is deactivated or deleted.
//
// The records themselves belong to the CLIENT, not to the person who happened
// to write them — so they must outlive the account. Once the account is gone
// `authorId` no longer resolves, and this snapshot is what the client's
// timeline shows instead ("Jane Doe · former accountant").
export interface IFormerAuthor {
  name: string;
  email?: string;
  role?: string;
}

export const FormerAuthorSchema = new Schema<IFormerAuthor>(
  {
    name: { type: String, required: true },
    email: { type: String },
    role: { type: String },
  },
  { _id: false },
);
