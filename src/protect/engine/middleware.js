import { notify } from '../notify.js';
import { PatchstackRuleClient } from './client.js';
import { RuleEngine } from './engine.js';

export function createMiddleware(rulesData, options = {}) {
  const engine = new RuleEngine(rulesData);

  const middleware = (req, res, next) => {
    const result = engine.evaluate(req);

    if (result.blocked) {
      if (options.onBlock) {
        options.onBlock({
          rule: result.rule,
          message: result.message,
          request: {
            method: req.method,
            url: req.url,
            ip: req.ip ?? req.socket?.remoteAddress
          }
        });
      }

      return res.status(403).json({
        error: 'Blocked by Patchstack WAF',
        message: result.message,
        timestamp: new Date().toISOString()
      });
    }

    next();
  };

  middleware.engine = engine;

  return middleware;
}

export function createLogger() {
  const events = [];
  const MAX_EVENTS = 100;
  let stats = { total: 0, blocked: 0, allowed: 0, totalDuration: 0 };

  const middleware = (req, res, next) => {
    const start = Date.now();

    const originalEnd = res.end.bind(res);
    res.end = function (...args) {
      const duration = Date.now() - start;
      const blocked = res.statusCode === 403;

      stats.total++;
      stats.totalDuration += duration;

      if (blocked) {
        stats.blocked++;
      } else {
        stats.allowed++;
      }

      events.push({
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration,
        blocked
      });

      if (events.length > MAX_EVENTS) {
        events.shift();
      }

      return originalEnd(...args);
    };

    next();
  };

  return {
    middleware,
    getStats: () => ({
      total: stats.total,
      blocked: stats.blocked,
      allowed: stats.allowed,
      avgDuration: stats.total > 0 ? Math.round(stats.totalDuration / stats.total) : 0
    }),
    getEvents: () => [...events]
  };
}

export async function protect(options = {}) {
  const token = options.token ?? process.env.PATCHSTACK_WAF_TOKEN;

  if (!token) {
    console.warn('[patchstack] No WAF token provided. WAF protection disabled.');
    return passThrough();
  }

  try {
    const client = new PatchstackRuleClient({
      token,
      baseUrl: options.baseUrl,
      cacheTtl: options.cacheTtl
    });

    const rulesData = await client.getRules();

    if (!rulesData.success) {
      console.warn(`[patchstack] Failed to fetch WAF rules: ${rulesData.error}. WAF protection disabled.`);
      return passThrough();
    }

    if (options.onScan) {
      options.onScan(rulesData);
    }

    const wafMiddleware = createMiddleware(rulesData, options);

    if (options.logging !== false) {
      const logger = createLogger();

      const combined = (req, res, next) => {
        logger.middleware(req, res, () => {
          wafMiddleware(req, res, next);
        });
      };

      combined.getStats = logger.getStats;
      combined.getEvents = logger.getEvents;
      combined.rules = rulesData;
      combined.engine = wafMiddleware.engine;

      return combined;
    }

    wafMiddleware.rules = rulesData;

    return wafMiddleware;
  } catch (err) {
    console.warn(`[patchstack] WAF initialization error: ${err.message}. WAF protection disabled.`);
    return passThrough();
  }
}

export function protectSync(options = {}) {
  let initialized = false;
  let initError = null;
  let middleware = null;
  let initPromise = null;

  const lazyMiddleware = (req, res, next) => {
    if (initError) {
      return next();
    }

    if (initialized && middleware) {
      return middleware(req, res, next);
    }

    if (!initPromise) {
      initPromise = protect(options)
        .then(m => {
          middleware = m;
          initialized = true;
        })
        .catch(err => {
          initError = err;
          console.warn(`[patchstack] WAF lazy init failed: ${err.message}. Passing through.`);

          notify(options.onError, err, 'onError');
        });
    }

    initPromise
      .then(() => {
        if (initError) {
          return next();
        }
        return middleware(req, res, next);
      })
      .catch(() => next());
  };

  return lazyMiddleware;
}

function passThrough() {
  return (_req, _res, next) => next();
}
