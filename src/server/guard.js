/**
 * Cost guards for a publicly reachable deployment.
 *
 * A URL with an API key behind it is an open tab on someone's bill. Two
 * cheap controls keep a demo deployment bounded:
 *
 *   ACCESS_CODE        Every /api/verify call must carry this code. It is
 *                      put in the link sent to reviewers (?code=...), so
 *                      they never have to type anything.
 *   DAILY_LABEL_LIMIT  Maximum labels checked per UTC day, across all
 *                      users. The counter is in memory, so a restart
 *                      resets it; the hard backstop is a prepaid credit
 *                      balance with auto-reload off in the Anthropic Console.
 *
 * Both are off when unset, so local development needs no configuration.
 */

import { timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison, so the code can't be guessed by timing. */
export function codesMatch(provided, expected) {
  const a = Buffer.from(String(provided ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * A per-day counter. `take()` returns true and counts the request if the
 * day's allowance remains, false otherwise. `now` is injectable for tests.
 */
export function createDailyLimiter(limit, now = () => new Date()) {
  let day = '';
  let used = 0;
  const today = () => now().toISOString().slice(0, 10);

  return {
    take() {
      if (!limit) return true;
      const d = today();
      if (d !== day) {
        day = d;
        used = 0;
      }
      if (used >= limit) return false;
      used += 1;
      return true;
    },
    status() {
      if (today() !== day) return { limit: limit || null, used: 0 };
      return { limit: limit || null, used };
    },
  };
}

/**
 * Express middleware applying both guards to one route.
 * Errors are plain English, because they are shown to agents as-is.
 */
export function costGuard({ accessCode, dailyLimit }) {
  const limiter = createDailyLimiter(dailyLimit);

  const middleware = (req, res, next) => {
    if (accessCode) {
      const provided = req.get('x-access-code') || req.query.code || '';
      if (!codesMatch(provided, accessCode)) {
        return res.status(401).json({
          error: 'This demo needs the access link you were sent. Please open that link and try again.',
        });
      }
    }
    if (!limiter.take()) {
      return res.status(429).json({
        error: "Today's checking limit for this demo has been reached. Please try again tomorrow.",
      });
    }
    next();
  };

  middleware.status = () => limiter.status();
  return middleware;
}
