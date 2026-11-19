import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  listMyBookingLinks,
  createBookingLink,
  updateBookingLink,
  deleteBookingLink,
  listBookingRequests,
  approveBookingRequestHandler,
  declineBookingRequestHandler,
} from "../controllers/bookingController";

/**
 * Manage your own booking links (the shareable "book a meeting with me"
 * pages). Every route is scoped to the logged-in user in the controller —
 * nobody can read or edit someone else's link. Mounted at
 * /api/booking-links.
 */
const router = Router();
router.use(authenticate);

// Requests waiting for your approval (links with "approve each booking" on).
// Declared before the /:id routes so "requests" is never read as an id.
router.get("/requests", listBookingRequests);
router.post("/requests/:id/approve", approveBookingRequestHandler);
router.post("/requests/:id/decline", declineBookingRequestHandler);

router.get("/", listMyBookingLinks);
router.post("/", createBookingLink);
router.put("/:id", updateBookingLink);
router.delete("/:id", deleteBookingLink);

export default router;
