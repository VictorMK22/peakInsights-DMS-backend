import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  createTodoList,
  getMyTodoLists,
  updateTodoList,
  toggleTodoItem,
  deleteTodoList,
} from "../controllers/todoController";

/**
 * Personal to-do lists, each with a start/end period.
 *   GET    /                         my lists (?from=&to= → overlapping period)
 *   POST   /                         create a list
 *   PUT    /:id                      edit title / period / items
 *   PATCH  /:id/items/:itemId        tick or untick one item
 *   DELETE /:id                      delete a list
 */

const router = Router();
router.use(authenticate);

router.get("/", getMyTodoLists);
router.post("/", createTodoList);
router.put("/:id", updateTodoList);
router.patch("/:id/items/:itemId", toggleTodoItem);
router.delete("/:id", deleteTodoList);

export default router;