// Escaped-error capture for api/*.js handlers (#154).
//
// withErrorCapture(handler, name) wraps a `(req, res) => Promise` handler.
// Each handler's INTERNAL try/catches remain the primary error handling —
// the wrapper only sees what escapes them (a genuinely uncaught throw), so
// wrapping changes no existing status codes or bodies on handled paths.
//
// On an escaped throw: record the event in the platform error journal
// (best-effort — appendError never throws), log it, and answer 500 iff no
// response has started. The handler's export signature is unchanged.

const { appendError } = require('./error-log');

function withErrorCapture(handler, handlerName) {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } catch (err) {
      console.error(`[error-capture] ${handlerName}:`, err);
      await appendError({
        source: 'api',
        handler: handlerName,
        message: err && err.message ? String(err.message) : String(err),
        severity: 'error',
        statusCode: 500,
        stack: err && err.stack ? String(err.stack) : null,
      });
      if (res && !res.headersSent && typeof res.status === 'function') {
        try {
          res.status(500).json({ error: 'server error' });
        } catch {
          // Response already unusable — nothing more we can do.
        }
      }
    }
  };
}

module.exports = {
  withErrorCapture,
  // Inline capture for existing catch blocks that want to record a handled
  // error without re-throwing. Same never-throws contract as appendError.
  captureError: appendError,
};
