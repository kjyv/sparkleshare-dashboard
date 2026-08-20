var userProvider = null;
var deviceProvider = null;
var folderProvider = null;
var linkCodeProvider = null;

var crypto = require('crypto');
var errors = require('./error');
var RateLimiter = require('./rateLimit').RateLimiter;

// A correct link code hands out a permanent device token carrying the code
// owner's full ACL, so wrong guesses are budgeted per source address. Only
// failures count, so a user fumbling one code is unaffected. Deliberately
// per-IP and not global: a global budget would let one attacker stop everybody
// else from linking a device.
var linkCodeAttempts = new RateLimiter({ windowMs: 5 * 60 * 1000, max: 10 });

var SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function tokensEqual(expected, given) {
  if (typeof given !== 'string' || typeof expected !== 'string') {
    return false;
  }
  var a = Buffer.from(expected, 'utf8');
  var b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  setup: function(up, dp, fp, lcp) {
    userProvider = up;
    deviceProvider = dp;
    folderProvider = fp;
    linkCodeProvider = lcp;
  },

  isLogged: function(req, res, next) {
    if (req.isAuthenticated()) {
      next();
    } else {
      res.redirect('/login');
    }
  },


  isAdmin: function(req, res, next) {
    if (req.user.admin) {
      next();
    } else {
      next(new errors.Permission('Only admin can do this!'));
    }
  },

  owningDevice: function(req, res, next) {
    if (req.user.admin || req.loadedDevice.ownerUid == req.user.uid) {
      next();
    } else {
      next(new errors.Permission('You are not admin nor you own this device!'));
    }
  },

  checkFolderAcl: function(req, res, next) {
    if (!req.params.folderId || req.user.admin) {
      next();
    } else {
      if (req.user.acl.indexOf(req.params.folderId) >= 0) {
        next();
      } else {
        next(new errors.Permission('You do not have a permission to access this folder'));
      }
    }
  },

  loadUser: function(req, res, next) {
    if (!req.params.uid) {
      next(new errors.NotFound('No user ID specified'));
    } else {
      userProvider.findByUid(req.params.uid, function(error, user) {
        if (error || !user) { return next(new errors.NotFound('User not found!')); }
        req.loadedUser = user;
        next();
      });
    }
  },

  loadDevice: function(req, res, next) {
    if (!req.params.did) {
      next(new errors.NotFound('No device ID specified'));
    } else {
      deviceProvider.findById(req.params.did, function(error, device) {
        if (error || !device) { return next(new errors.NotFound('Device not found')); }
        req.loadedDevice = device;
        next();
      });
    }
  },

  loadFolder: function(req, res, next) {
    if (!req.params.folderId) {
      next(new errors.NotFound('No folder specified'));
    } else {
      folderProvider.findById(req.params.folderId, function(error, folder) {
        if (error || !folder) { return next(new errors.NotFound('Folder not found')); }
        req.loadedFolder = folder;
        next();
      });
    }
  },

  userDbEmpty: function(req, res, next) {
    userProvider.getUserCount(function(error, count) {
      if (count < 1) {
        next();
      } else {
        req.flash('error', 'There are already some users. Ask admin for an account');
        res.redirect('/login');
      }
    });
  },

  validateLinkCode: function(req, res, next) {
    var key = RateLimiter.byIp(req);

    if (linkCodeAttempts.isBlocked(key)) {
      res.set('Retry-After', String(linkCodeAttempts.retryAfter(key)));
      return next(new errors.TooManyRequests('Too many link code attempts'));
    }

    var code = req.body.code;
    if (code) {
      var valid = linkCodeProvider.isCodeValid(code);
      if (valid[0]) {
        linkCodeAttempts.reset(key);
        req.linkCodeForUid = valid[1];
        return next();
      }
    }

    linkCodeAttempts.hit(key);
    next(new errors.Permission('Invalid link code'));
  },

  //issues a per-session CSRF token and makes it available to the templates
  csrfToken: function(req, res, next) {
    if (req.session) {
      if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      }
      res.locals.csrfToken = req.session.csrfToken;
    } else {
      res.locals.csrfToken = '';
    }
    next();
  },

  //sameSite=lax alone does not cover a same-site attacker (another vhost or a
  //plain-http sibling), so state-changing requests carry a token as well
  csrfProtect: function(req, res, next) {
    if (SAFE_METHODS.indexOf(req.method) !== -1) {
      return next();
    }

    //device API clients authenticate with X-SPARKLE-* headers rather than the
    //session cookie, so a cross-site form post cannot act as them
    if (req.path.indexOf('/api/') === 0) {
      return next();
    }

    var given = (req.body && req.body._csrf) || req.header('X-CSRF-Token');
    if (req.session && tokensEqual(req.session.csrfToken, given)) {
      return next();
    }

    next(new errors.Permission('Invalid or missing CSRF token'));
  },

  validateAuthCode: function(req, res, next) {
    var ident = req.header('X-SPARKLE-IDENT');
    var authCode = req.header('X-SPARKLE-AUTH');
    if (!ident || !authCode) {
      res.status(403).send('Missing auth code');
    } else {
      deviceProvider.findByIdent(ident, function(error, device) {
        if (!device) {
          res.status(403).send('Invalid ident');
        } else if (!device.ownerUid) {
          res.status(500).send('No device owner');
        } else if (device.checkAuthCode(authCode)) {
          userProvider.findByUid(device.ownerUid, function(error, user) {
            if (error || !user) {
              res.status(403).send('Invalid owner');
            } else {
              req.user = user;
              req.currentDevice = device;
              next();
            }
          });
        } else {
          res.status(403).send('Invalid auth code');
        }
      });
    }
  }
};
