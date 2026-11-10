import mongoose, { Document, Schema } from "mongoose";

/**
 * A personal to-do list. Private to its owner.
 *
 * Each list carries the period in which its items are meant to be done
 * (startDate → endDate). Individual items may optionally narrow that with
 * their own due date, but the list period is the primary scheduling unit.
 */

export interface ITodoItem {
  _id: mongoose.Types.ObjectId;
  text: string;
  done: boolean;
  completedAt?: Date;
  dueDate?: Date;
}

export interface ITodoList extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  items: ITodoItem[];
  createdAt: Date;
  updatedAt: Date;
}

const TodoItemSchema = new Schema<ITodoItem>({
  text: { type: String, required: true, trim: true, maxlength: 500 },
  done: { type: Boolean, default: false },
  completedAt: { type: Date },
  dueDate: { type: Date },
});

const TodoListSchema = new Schema<ITodoList>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    items: { type: [TodoItemSchema], default: [] },
  },
  { timestamps: true },
);

TodoListSchema.index({ userId: 1, startDate: 1, endDate: 1 });

export const TodoListModel = mongoose.model<ITodoList>(
  "TodoList",
  TodoListSchema,
);