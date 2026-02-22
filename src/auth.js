import cfg from "./config.js";

/**
 * Express middleware – API-key gating.
 * If API_KEYS env is empty, auth is completely disabled.
 *
 * Accepts:
 *   Authorization: Bearer <key>
 *   X-API-Key: <key>
 *   ?apiKey=<key>   (query-string, lowest priority)
 */
export function authMiddleware(req, res, next) {
  if (cfg.apiKeys.length === 0) return next();          // auth disabled

  const key =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
    req.query.apiKey;

  if (!key || !cfg.apiKeys.includes(key)) {
    return res.status(401).json({
      error: "unauthorized",
      message: "Invalid or missing API key",
    });
  }

  req.apiKey = key;
  next();
}
