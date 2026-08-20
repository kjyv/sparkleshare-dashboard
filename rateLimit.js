/* vim: set tabstop=2 shiftwidth=2 expandtab: */

// Small fixed-window rate limiter. In-memory on purpose: the dashboard is a
// single process, so there is no need to round-trip redis for this, and losing
// the counters on restart is acceptable.
//
// Counters are only advanced by callers on *failure* (see hit()), so a user who
// keeps getting it right is never throttled.

var errors = require('./error');

function RateLimiter(options) {
  this.windowMs = options.windowMs;
  this.max = options.max;
  this.entries = new Map();
}

RateLimiter.prototype.gc = function(now) {
  for (var entry of this.entries) {
    if (entry[1].resetAt <= now) {
      this.entries.delete(entry[0]);
    }
  }
};

// true when the key is already over budget and should be refused
RateLimiter.prototype.isBlocked = function(key) {
  var now = Date.now();
  var e = this.entries.get(key);
  if (!e || e.resetAt <= now) {
    return false;
  }
  return e.count >= this.max;
};

// record one failed attempt against the key
RateLimiter.prototype.hit = function(key) {
  var now = Date.now();

  // keep the map from growing without bound on a spray across many keys
  if (this.entries.size > 10000) {
    this.gc(now);
  }

  var e = this.entries.get(key);
  if (!e || e.resetAt <= now) {
    e = { count: 0, resetAt: now + this.windowMs };
    this.entries.set(key, e);
  }
  e.count++;
  return e;
};

RateLimiter.prototype.reset = function(key) {
  this.entries.delete(key);
};

RateLimiter.prototype.retryAfter = function(key) {
  var e = this.entries.get(key);
  if (!e) {
    return 0;
  }
  return Math.max(0, Math.ceil((e.resetAt - Date.now()) / 1000));
};

// Middleware that refuses a request once its key is over budget. Nothing is
// counted here; the route counts its own failures with limiter.hit().
RateLimiter.prototype.block = function(keyFn, message) {
  var limiter = this;

  return function(req, res, next) {
    var key = keyFn(req);
    if (!limiter.isBlocked(key)) {
      return next();
    }

    res.set('Retry-After', String(limiter.retryAfter(key)));
    next(new errors.TooManyRequests(message));
  };
};

// Most limits here are per-source-address. Requires 'trust proxy' to be
// configured when running behind a reverse proxy, otherwise every request
// appears to come from the proxy and shares one bucket.
RateLimiter.byIp = function(req) {
  return req.ip || 'unknown';
};

exports.RateLimiter = RateLimiter;
