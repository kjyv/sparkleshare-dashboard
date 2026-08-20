var Strategy = require('passport-local').Strategy
var crypto = require('crypto');
var errors = require('../error');
var toCallback = require('../redisPromise').toCallback;

LocalUserProvider = function (options, redisClient, deviceProvider) {
  this.rclient = redisClient;
  this.deviceProvider = deviceProvider;

  var provider = this;
  this.strategy = new Strategy(options, function (login, password, next) {
    process.nextTick(function () {
      provider.findByLogin(login, function (error, user) {
        if (!user) {
          return next(null, false, { message: 'Invalid login' })
        }

        if (user.checkPassword(password)) {
          return next(null, user);
        } else {
          return next(null, false, { message: 'Invalid login' })
        }
      })
    })
  })
}

// legacy password hash (single-round HMAC-SHA256) kept only to verify
// passwords stored before the scrypt migration
function hash(msg, key) {
  return crypto.createHmac('sha256', key).update(msg).digest('hex');
}

var SCRYPT_KEYLEN = 64;

// scrypt-based password hash, self-describing format: scrypt$<saltHex>$<hashHex>
function scryptHash(password, saltBuf) {
  var derived = crypto.scryptSync(String(password), saltBuf, SCRYPT_KEYLEN);
  return 'scrypt$' + saltBuf.toString('hex') + '$' + derived.toString('hex');
}

LocalUserProvider.prototype = {
  createNew: function (login, name, password, admin, acl, next) {
    var provider = this;
    this.findByLogin(login, function (error, user) {
      if (!user) {
        var newUser = new User();
        newUser.login = login;
        newUser.name = name;
        newUser.setPassword(password);
        newUser.admin = admin;
        newUser.acl = acl;
        toCallback(provider.rclient.incr('seq:nextUserId'), function (error, nuid) {
          if (error) {
            return next(error);
          }
          newUser.uid = nuid;

          //the login->uid mapping and the uids set must both be in place
          //before the caller is told the user exists, or the very next login
          //attempt can miss
          Promise.all([
            provider.rclient.set("uid:" + newUser.uid + ":user", JSON.stringify(newUser)),
            provider.rclient.sAdd("uid:" + newUser.uid + ":deviceNames", ''),
            provider.rclient.set("login:" + newUser.login + ":uid", String(newUser.uid)),
            provider.rclient.sAdd("uids", String(newUser.uid))
          ]).then(function () {
            next(null, newUser);
          }, next);
        });
      } else {
        next(new Error('Login already used'));
      }
    });
  },

  updateUser: function (user, next) {
    var provider = this;

    this.findByUid(user.uid, function (error, fuser) {
      if (error) {
        return next(error);
      }
      if (!fuser) {
        return next(new errors.NotFound("User not found"));
      }
      if (user.login != fuser.login) {
        return next(new Error("You can not change login!"));
      }

      toCallback(
        provider.rclient.set("uid:" + fuser.uid + ":user", JSON.stringify(user)),
        function (error) {
          if (error) { return next(error); }
          next(null, user);
        });
    });
  },

  deleteUser: function (uid, next) {
    var provider = this;

    this.findByUid(uid, function (error, fuser) {
      if (error) {
        return next(error);
      }
      if (!fuser) {
        return next(new errors.NotFound("User not found"));
      }

      var delUser = function () {
        return Promise.all([
          provider.rclient.del("uid:" + fuser.uid + ":user"),
          provider.rclient.del("uid:" + fuser.uid + ":devices"),
          provider.rclient.del("uid:" + fuser.uid + ":deviceNames"),
          provider.rclient.del("login:" + fuser.login + ":uid"),
          provider.rclient.sRem("uids", String(fuser.uid))
        ]);
      };

      // unlink all devices owned by user
      provider.deviceProvider.findByUserId(fuser.uid, function (error, devices) {
        if (error) {
          return next(error);
        }

        var count = devices.length;
        if (count === 0) {
          return delUser().then(function () { next(); }, next);
        }
        devices.forEach(function (device) {
          provider.deviceProvider.unlinkDevice(device.id, function (error) {
            if (error) {
              return next(error);
            }
            if (--count === 0) {
              delUser().then(function () { next(); }, next);
            }
          });
        });
      });
    });
  },

  findByUid: function (uid, next) {
    toCallback(this.rclient.get("uid:" + uid + ":user"), function (error, data) {
      if (error) {
        return next(error);
      }
      if (!data) {
        return next();
      }
      next(null, new User(JSON.parse(data)));
    });
  },

  findByLogin: function (login, next) {
    var provider = this;
    toCallback(provider.rclient.get("login:" + login + ":uid"), function (error, uid) {

      if (error) {
        return next(error);
      }
      if (!uid) {
        next();
        return null;
      }
      if (next) {
        provider.findByUid(uid, next);
      }

      return uid;
    });
  },

  getUserCount: function (next) {
    toCallback(this.rclient.sCard("uids"), next);
  },

  findAll: function (next) {
    var provider = this;
    toCallback(provider.rclient.sMembers("uids"), function (error, uids) {
      if (error) {
        return next(error);
      }
      var r = [];
      var count = uids.length;
      if (count === 0) {
        next(null, r);
      }
      uids.forEach(function (uid) {
        provider.findByUid(uid, function (error, user) {
          if (error) {
            return next(error);
          }
          r.push(user);
          if (--count === 0) {
            next(null, r);
          }
        });
      });
    });
  },

  serializeUser: function (user, next) {
    next(null, user.login);
  },

  deserializeUser: function (login, next) {
    this.findByLogin(login, function (err, user) {
      next(err, user);
    });
  }
};

User = function (data) {
  this.uid = null;
  this.login = "";
  this.name = "";
  this.salt = "";
  this.pass = "";
  this.admin = false;
  this.acl = [];

  if (data) {
    this.uid = data.uid;
    this.login = data.login;
    this.name = data.name;
    this.salt = data.salt;
    this.pass = data.pass;
    this.admin = data.admin ? true : false;
    this.acl = data.acl ? data.acl : [];
  }
};

User.prototype = {
  setPassword: function (password) {
    // store using scrypt; salt is embedded in the hash string
    this.pass = scryptHash(password, crypto.randomBytes(16));
    this.salt = '';
  },

  checkPassword: function (password) {
    if (typeof this.pass !== 'string' || this.pass.length === 0) {
      return false;
    }

    // new scrypt format: scrypt$<saltHex>$<hashHex>
    if (this.pass.indexOf('scrypt$') === 0) {
      var parts = this.pass.split('$');
      if (parts.length !== 3) {
        return false;
      }
      var saltBuf = Buffer.from(parts[1], 'hex');
      var expected = Buffer.from(parts[2], 'hex');
      var actual = crypto.scryptSync(String(password), saltBuf, expected.length);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }

    // legacy HMAC-SHA256 format (verified in constant time, upgraded on next change)
    var legacyExpected = Buffer.from(this.pass);
    var legacyActual = Buffer.from(hash(password, this.salt));
    return legacyExpected.length === legacyActual.length &&
      crypto.timingSafeEqual(legacyExpected, legacyActual);
  }
};

exports.UserProvider = LocalUserProvider;