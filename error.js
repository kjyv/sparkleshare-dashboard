var util = require('util');

function NotFound(msg) {
  this.name = 'Not Found';
  this.message = msg ? msg : '';
  Error.call(this, msg); // really do not know why this is not working! Fixed by setting message manually
  Error.captureStackTrace(this, arguments.callee);
}
util.inherits(NotFound, Error);

function Permission(msg) {
  this.name = 'Forbidden';
  this.message = msg ? msg : '';
  Error.call(this, msg);
  Error.captureStackTrace(this, arguments.callee);
}
util.inherits(Permission, Error);

function ISE(msg) {
  this.name = 'Internal Server Error';
  this.message = msg ? msg : '';
  Error.call(this, msg);
  Error.captureStackTrace(this, arguments.callee);
}
util.inherits(ISE, Error);

function Conflict(msg) {
  this.name = 'Conflict';
  this.message = msg ? msg : '';
  Error.call(this, msg);
  Error.captureStackTrace(this, arguments.callee);
}
util.inherits(Conflict, Error);

function TooManyRequests(msg) {
  this.name = 'Too Many Requests';
  this.message = msg ? msg : '';
  Error.call(this, msg);
  Error.captureStackTrace(this, arguments.callee);
}
util.inherits(TooManyRequests, Error);

function errorHandler(err, req, res, next) {
  var name = err.name;
  var message = err.message;

  if (err instanceof NotFound) {
    res.statusCode = 404;
  } else if (err instanceof Permission) {
    res.statusCode = 403;
  } else if (err instanceof Conflict) {
    res.statusCode = 409;
  } else if (err instanceof TooManyRequests) {
    res.statusCode = 429;
  } else {
    // unexpected error: log details server-side, but show a generic message
    // to the client so we don't leak internals (paths, git stderr, stacks)
    res.statusCode = 500;
    console.error(err && err.stack ? err.stack : err);
    name = 'Internal Server Error';
    message = 'Internal Server Error';
  }

  var accept = req.headers.accept || '';
  if (~accept.indexOf('html')) {
    // html
    res.render('error', { e: { name: name, message: message } });
  } else if (~accept.indexOf('json')) {
    // json
    var json = JSON.stringify({ error: name, msg: message });
    res.setHeader('Content-Type', 'application/json');
    res.end(json);
  } else {
    // plain text
    res.setHeader('Content-Type', 'text/plain');
    res.end(name + ": " + message);
  }
}

module.exports = {
  NotFound: NotFound,
  Permission: Permission,
  Conflict: Conflict,
  TooManyRequests: TooManyRequests,
  errorHandler: errorHandler
};
