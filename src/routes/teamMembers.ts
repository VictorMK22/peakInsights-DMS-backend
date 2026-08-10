import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import {
  listTeamMembers,
  addTeamMember,
  updateTeamMember,
  removeTeamMember,
} from "../controllers/teamMemberController";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.get("/", listTeamMembers);
router.post("/", addTeamMember);
router.put("/:id", updateTeamMember);
router.delete("/:id", removeTeamMember);

export default router;
