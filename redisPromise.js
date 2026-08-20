/* vim: set tabstop=2 shiftwidth=2 expandtab: */

// Adapts a redis command promise to the node-style callback the providers in
// this project expose.
//
// A call with no callback is fire-and-forget, but its rejection still has to be
// consumed, or node reports an unhandled rejection and exits.
function toCallback(promise, next) {
  if (typeof next !== 'function') {
    promise.catch(function (error) {
      console.error('redis command failed: ' + (error && error.message ? error.message : error));
    });
    return;
  }

  promise.then(function (result) {
    next(null, result);
  }, function (error) {
    next(error);
  });
}

exports.toCallback = toCallback;
