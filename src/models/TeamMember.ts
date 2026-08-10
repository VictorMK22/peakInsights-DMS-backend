import mongoose, { Document, Schema } from "mongoose";

export interface ITeamMember extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  title?: string; // free-text role label, e.g. "DevOps Engineer" — this
  // app has no formal job-title field on User, and adding one there
  // would affect every workspace, not just ICT's roster display.
  addedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const TeamMemberSchema = new Schema<ITeamMember>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    title: { type: String, trim: true },
    addedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

export const TeamMember = mongoose.model<ITeamMember>(
  "TeamMember",
  TeamMemberSchema,
);
