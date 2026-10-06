import { Router } from "express";
import { authenticate, requireIctAccess } from "../middleware/auth";
import {
  listTeamMembers,
  addTeamMember,
  updateTeamMember,
  removeTeamMember,
} from "../controllers/teamMemberController";

const router = Router();
router.use(authenticate, requireIctAccess);

router.get("/", listTeamMembers);
router.post("/", addTeamMember);
router.put("/:id", updateTeamMember);
router.delete("/:id", removeTeamMember);

export default router;
