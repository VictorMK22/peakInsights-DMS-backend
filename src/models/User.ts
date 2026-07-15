import mongoose, { Document, Schema } from "mongoose";
import bcrypt from "bcryptjs";
import { UserRole } from "../types";

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  password: string;
  role: UserRole;
  department?: string;
  bio?: string;
  phone?: string;
  profilePicture?: string;
  isActive: boolean;
  supervisorId?: mongoose.Types.ObjectId;
  accountStatus: "pending" | "active" | "rejected" | "disabled";
  rejectionReason?: string;
  approvedBy?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  avatar?: string;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true, minlength: 8, select: false },
    role: {
      type: String,
      enum: ["ceo", "supervisor", "user", "sales_person"],
      required: true,
    },
    department: { type: String, trim: true },
    bio: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    phone: {
      type: String,
      trim: true,
    },

    profilePicture: {
      type: String,
    },
    isActive: { type: Boolean, default: false }, // false until CEO approves
    supervisorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    accountStatus: {
      type: String,
      enum: ["pending", "active", "rejected", "disabled"],
      default: "active",
    },
    rejectionReason: { type: String },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

UserSchema.methods["comparePassword"] = async function (
  candidatePassword: string,
): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.password);
};

UserSchema.set("toJSON", {
  transform: (_doc, ret) => {
    delete (ret as any).password;
    return ret;
  },
});

UserSchema.index({ supervisorId: 1 });

UserSchema.pre("save", function (next) {
  if (this.role === "ceo" && this.supervisorId) {
    return next(new Error("CEO cannot have a supervisor"));
  }
  next();
});

export const User = mongoose.model<IUser>("User", UserSchema);
