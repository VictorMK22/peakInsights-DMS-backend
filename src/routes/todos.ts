import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  createTodoList,
  getMyTodoLists,
  updateTodoList,
  toggleTodoItem,
  deleteTodoList,
} from "../controllers/todoController";
import {
  getMyTodoReminders,
  setTodoReminder,
  clearTodoReminder,
} from "../controllers/todoReminderController";

/**
 * Personal to-do lists, each with a start/end period.
 *   GET    /                         my lists (?from=&to= → overlapping period)
 *   POST   /                         create a list
 *   PUT    /:id                      edit title / period / items
 *   PATCH  /:id/items/:itemId        tick or untick one item
 *   DELETE /:id                      delete a list
 *   GET    /reminders/mine           my pending item reminders
 *   PUT    /:id/items/:itemId/reminder     set an item reminder
 *   DELETE /:id/items/:itemId/reminder     clear it
 */

const router = Router();
router.use(authenticate);

router.get("/", getMyTodoLists);
router.get("/reminders/mine", getMyTodoReminders);
router.post("/", createTodoList);
router.put("/:id", updateTodoList);
router.patch("/:id/items/:itemId", toggleTodoItem);
router.put("/:id/items/:itemId/reminder", setTodoReminder);
router.delete("/:id/items/:itemId/reminder", clearTodoReminder);
router.delete("/:id", deleteTodoList);

export default router;