import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

// Only letters, digits, underscore and hyphen, 8 to 64 characters.
// Anything else from a client is thrown away, so nobody can inject odd
// characters or fake log lines through this header.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  const id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();

  req.id = id;
  req.log = logger.child({ requestId: id });
  res.setHeader('X-Request-Id', id);

  next();
}