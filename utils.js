var config = require('./config');

// Headers carrying credentials: the session cookie and the permanent device
// token. Debug logs are routinely pasted into bug reports, so these are never
// written out verbatim.
var REDACTED_HEADERS = ['cookie', 'set-cookie', 'authorization', 'x-sparkle-auth'];

function redactHeaders(headers) {
  var safe = {};
  for (var name in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, name)) {
      safe[name] = REDACTED_HEADERS.indexOf(name.toLowerCase()) === -1
        ? headers[name] : '[redacted]';
    }
  }
  return safe;
}

module.exports = {
  aclFilterFolderList: function(folders, user) {
    if (!user.admin) {
      for (var fid in folders) {
        if (!(user.acl.indexOf(fid) >= 0)) {
          delete folders[fid];
        }
      }
    }

    return folders;
  },

  getLoggingFormat: function() {
    if (config.logging == 'min') {
      return 'short';
    } else if (config.logging == 'info') {
      return 'default';
    } else if (config.logging == 'debug') {
      return function (tokens, req, res) {
        var status = res.statusCode;
        var color = 32;

        if (status >= 500) {
          color = 31;
        } else if (status >= 400) {
          color = 33;
        } else if (status >= 300) {
          color = 36;
        }

        return "\033[90m" + req.method +
          " " + req.originalUrl + " " +
          "\033[" + color + "m" + res.statusCode +
          " \033[90m" +
          (new Date() - req._startTime) +
          "ms\033[0m" +
          " C: " + JSON.stringify(redactHeaders(req.headers));
      };
    }

    return null;
  }
}
