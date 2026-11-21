import express, { type RequestHandler } from 'express';

const DEFAULT_LIMIT = '100kb';
/** Written answers can be long, and a few characters of Yoruba or Igbo take up to 3 bytes each. */
const LONG_ANSWER_LIMIT = '512kb';

/** Saving answers and submitting an attempt: the only requests allowed a body bigger than the default. */
const LONG_ANSWER_ROUTE = /^\/api\/v1\/cbt\/attempts\/[a-f0-9]{24}\/(answers|submit)\/?$/i;

const defaultJson = express.json({ limit: DEFAULT_LIMIT });

/**
 * The app-wide JSON reader, 100 KB. It steps aside for the two long-answer routes, which read their own bigger body
 * AFTER the student has signed in (see longAnswerBody), so nobody anonymous can make the server read half a megabyte.
 */
export const jsonBody: RequestHandler = (req, res, next) => {
  if (req.method !== 'GET' && LONG_ANSWER_ROUTE.test(req.path)) {
    next();
    return;
  }
  defaultJson(req, res, next);
};

/** Put this on a route AFTER authenticate and authorize, and before validate. */
export const longAnswerBody: RequestHandler = express.json({ limit: LONG_ANSWER_LIMIT });
