import { Request, Response, NextFunction } from 'express';
import { scheduleErrorReport, isReportingEnabled } from '../services/errorReportService';
import { describeRequest, REPORTED } from './requestContext';
import { isClientFaultError } from '../utils/errorScrub';

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
}

export const errorHandler = (err: AppError, req: Request, res: Response, _next: NextFunction): void => {
  const statusCode = err.statusCode ?? 500;
  const message = err.message ?? 'Internal Server Error';

  console.error(`[Error] ${statusCode}: ${message}`, err.stack);

  // Tell the tech supervisor about genuine server faults. Errors that are
  // really the caller's fault (bad id, blocked file type, duplicate email…)
  // are skipped so alerts stay meaningful. Marking the response as handled
  // stops the res.send hook (requestContext) from reporting it a second time.
  if (!res.locals[REPORTED]) {
    res.locals[REPORTED] = true;
    if (statusCode >= 500 && isReportingEnabled() && !isClientFaultError(err)) {
      const { context, user } = describeRequest(req, statusCode);
      scheduleErrorReport({
        source: 'server',
        error: err,
        context,
        requestId: res.locals['requestId'],
        user,
      });
    }
  }

  res.status(statusCode).json({
    success: false,
    message,
    // Lets a person quote it when they report the problem.
    ...(res.locals['requestId'] && { requestId: res.locals['requestId'] }),
    ...(process.env['NODE_ENV'] === 'development' && { stack: err.stack }),
  });
};

export const notFound = (req: Request, res: Response): void => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
};