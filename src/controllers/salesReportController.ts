import { Response } from "express";
import { AuthRequest } from "../types/auth";
import {
  buildSalesActivityReport,
  lastCompletedWeek,
  parseReportDate,
  MAX_REPORT_RANGE_DAYS,
  buildSalesRepDetail,
  ACTIVITY_METRICS,
  parseStageMetric,
} from "../services/salesReportService";

/**
 * GET /api/analytics/sales-activity?from=2026-11-02&to=2026-11-09   (CEO)
 * `from` is inclusive, `to` is exclusive; plain dates are Nairobi midnight.
 * With no params it reports on the last completed Monday–Sunday week.
 */
export const getSalesActivityReport = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    let from: Date;
    let to: Date;
    if (req.query.from === undefined && req.query.to === undefined) {
      ({ from, to } = lastCompletedWeek());
    } else {
      const f = parseReportDate(req.query.from);
      const t = parseReportDate(req.query.to);
      if (!f || !t)
        return res.status(400).json({
          success: false,
          message: "Provide both from and to as dates (YYYY-MM-DD)",
        });
      from = f;
      to = t;
    }

    if (to <= from)
      return res
        .status(400)
        .json({ success: false, message: "`to` must be after `from`" });
    if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_REPORT_RANGE_DAYS)
      return res.status(400).json({
        success: false,
        message: `Date range can't exceed ${MAX_REPORT_RANGE_DAYS} days`,
      });

    const report = await buildSalesActivityReport(from, to);
    return res.json({ success: true, data: report });
  } catch (err) {
    console.error("Sales activity report failed:", err);
    return res.status(500).json({ success: false });
  }
};

/**
 * GET /api/analytics/sales-activity/:userId/clients?metric=calls&from=2026-11-09&to=2026-11-16   (CEO)
 * The clients behind one number in the report. `metric` is an activity key
 * (calls, emails, won …) or a current-pipeline snapshot such as `stage:in_discussion`.
 */
export const getSalesActivityDetail = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const { userId } = req.params;
    const metric = String(req.query.metric ?? "");
    if (!/^[a-f\d]{24}$/i.test(userId))
      return res.status(400).json({ success: false, message: "Invalid user id" });
    const isStage = parseStageMetric(metric) !== null;
    if (!isStage && !(ACTIVITY_METRICS as readonly string[]).includes(metric))
      return res.status(400).json({ success: false, message: "Unknown metric" });

    const from = parseReportDate(req.query.from);
    const to = parseReportDate(req.query.to);
    if (!isStage) {
      if (!from || !to || to <= from)
        return res.status(400).json({
          success: false,
          message: "Provide from and to as dates (YYYY-MM-DD)",
        });
      if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_REPORT_RANGE_DAYS)
        return res.status(400).json({
          success: false,
          message: `Date range can't exceed ${MAX_REPORT_RANGE_DAYS} days`,
        });
    }

    const data = await buildSalesRepDetail(
      userId,
      metric,
      from ?? new Date(0),
      to ?? new Date(),
    );
    return res.json({ success: true, data });
  } catch (err) {
    console.error("Sales activity detail failed:", err);
    return res.status(500).json({ success: false });
  }
};