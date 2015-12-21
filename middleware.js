var userProvider = null;
var deviceProvider = null;
var folderProvider = null;
var linkCodeProvider = null;

var errors = require('./error');

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
        if (error || !folder) { next(new errors.NotFound('Folder not found')); }
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
    var code = req.param('code');
    if (code) {
      var valid = linkCodeProvider.isCodeValid(code);
      if (valid[0]) {
        req.linkCodeForUid = valid[1];
        next();
      } else {
        res.send('Invalid link code', 403);
      }
    } else {
      res.send('Invalid link code', 403);
    }
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
