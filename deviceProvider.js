var errors = require('./error');
var crypto = require('crypto');
var toCallback = require('./redisPromise').toCallback;

DeviceProvider = function(redisClient) {
  this.rclient = redisClient;
};

DeviceProvider.prototype = {
  createNew: function(name, uid, next) {
    var provider = this;
    var newDevice = new Device();
    name = name ? name : '';

    provider.findUniqueNameForUid(uid, name, 0, function(error, reqName) {
      if (error) { return next(error); }

      newDevice.name = reqName;
      newDevice.ownerUid = uid;

      toCallback(provider.rclient.incr('seq:nextDeviceId'), function(error, nid) {
        if (error) { return next(error); }
        newDevice.id = nid;

        Promise.all([
          provider.rclient.set("deviceId:" + newDevice.id + ":device", JSON.stringify(newDevice)),
          provider.rclient.set("deviceIdent:" + newDevice.ident + ":deviceId", String(newDevice.id)),
          provider.rclient.sAdd("deviceIds", String(newDevice.id)),
          provider.rclient.sAdd("uid:" + newDevice.ownerUid + ":devices", String(newDevice.id)),
          provider.rclient.sAdd("uid:" + newDevice.ownerUid + ":deviceNames", newDevice.name)
        ]).then(function () {
          next(null, newDevice);
        }, next);
      });
    });
  },

  findUniqueNameForUid: function(uid, name, num, next) {
    var provider = this;
    var reqName = name;
    if (num > 0) {
      reqName += " (" + num + ")";
    }

    toCallback(provider.rclient.sIsMember("uid:" + uid + ":deviceNames", reqName), function(error, ismember) {
      if (error) { return next(error); }
      if (ismember) {
        provider.findUniqueNameForUid(uid, name, ++num, next);
      } else {
        next(null, reqName);
      }
    });
  },

  findAll: function(next) {
    var provider = this;
    toCallback(provider.rclient.sMembers("deviceIds"), function(error, ids) {
      if (error) { return next(error); }
      var r = [];
      var count = ids.length;
      if (count === 0) {
        next (null, r);
      }
      ids.forEach(function(id) {
        provider.findById(id, function(error, device) {
          if (error) { return next(error); }
          r.push(device);
          if (--count === 0) {
            next(null, r);
          }
        });
      });
    });
  },

  findById: function(id, next) {
    toCallback(this.rclient.get("deviceId:" + id + ":device"), function(error, data) {
      if (error) { return next(error); }
      if (!data) { return next(); }

      next(null, new Device(JSON.parse(data)));
    });
  },

  findByIdent: function(ident, next) {
    var provider = this;
    toCallback(this.rclient.get("deviceIdent:" + ident + ":deviceId"), function(error, id) {
      if (error) { return next(error); }
      if (!id) { return next(); }

      provider.findById(id, next);
    });
  },

  findByUserId: function(uid, next) {
    var provider = this;

    toCallback(this.rclient.sMembers("uid:" + uid + ":devices"), function(error, dids) {
      if (error) { return next(error); }

      var r = [];
      var count = dids.length;
      if (count === 0) {
        next (null, r);
      }
      dids.forEach(function(did) {
        provider.findById(did, function(error, device) {
          if (error) { return next(error); }
          r.push(device);
          if (--count === 0) {
            next(null, r);
          }
        });
      });
    });
  },

  updateDevice: function(device, next) {
    var provider = this;
    this.findById(device.id, function(error, fdevice) {
      if (error) { return next(error); }
      if (!fdevice) { return next(new errors.NotFound("Device not found")); }
      if (device.ident != fdevice.ident) {
        return next(new Error("You can not change ident!"));
      }
      if (device.ownerUid != fdevice.ownerUid) {
        return next(new Error("You can not change owner!"));
      }

      function saveDevice() {
        toCallback(
          provider.rclient.set("deviceId:" + fdevice.id + ":device", JSON.stringify(device)),
          function(error) {
            if (error) { return next(error); }
            next(null, device);
          });
      }

      if (device.name != fdevice.name) {
        if (fdevice.name && fdevice.name !== '') {
          toCallback(provider.rclient.sRem("uid:" + fdevice.ownerUid + ":deviceNames", fdevice.name));
        }

        provider.findUniqueNameForUid(device.ownerUid, device.name, 0, function(error, reqName) {
          if (error) { return next(error); }
          device.name = reqName;

          toCallback(provider.rclient.sAdd("uid:" + device.ownerUid + ":deviceNames", device.name));
          saveDevice();
        });
      } else {
        saveDevice();
      }
    });
  },

  unlinkDevice: function(id, next) {
    var provider = this;

    this.findById(id, function(error, fdevice) {
      if (error) { return next(error); }
      if (!fdevice) { return next(new errors.NotFound("Device not found")); }

      //unlinking must be complete before we report success, or a device could
      //still authenticate after the user was told it was gone
      var removals = [
        provider.rclient.del("deviceId:" + fdevice.id + ":device"),
        provider.rclient.del("deviceIdent:" + fdevice.ident + ":deviceId"),
        provider.rclient.sRem("deviceIds", String(fdevice.id)),
        provider.rclient.sRem("uid:" + fdevice.ownerUid + ":devices", String(fdevice.id))
      ];
      if (fdevice.name && fdevice.name !== '') {
        removals.push(provider.rclient.sRem("uid:" + fdevice.ownerUid + ":deviceNames", fdevice.name));
      }

      Promise.all(removals).then(function () {
        next();
      }, next);
    });
  },

  // One-time migration for records written while tokens were stored in
  // cleartext. Only the stored form changes, so linked devices keep working and
  // nothing has to be re-linked.
  rehashStoredAuthCodes: function(next) {
    var provider = this;

    toCallback(provider.rclient.sMembers("deviceIds"), function(error, ids) {
      if (error) { return next(error); }
      if (!ids || ids.length === 0) { return next(); }

      var pending = ids.length;
      var firstError = null;
      var migrated = 0;

      function done(error) {
        if (error && !firstError) { firstError = error; }
        if (--pending === 0) {
          if (migrated > 0) {
            console.log("DB UPGRADE: replaced " + migrated + " cleartext device auth token(s) with a hash");
          }
          next(firstError);
        }
      }

      ids.forEach(function(did) {
        var key = "deviceId:" + did + ":device";
        toCallback(provider.rclient.get(key), function(error, data) {
          if (error) { return done(error); }
          if (!data) { return done(); }

          var stored;
          try {
            stored = JSON.parse(data);
          } catch (e) {
            return done();
          }
          if (!stored.authCode) {
            return done();
          }

          migrated++;
          //the constructor hashes a cleartext token it finds, and toJSON omits
          //the cleartext, so re-saving is the whole migration
          toCallback(provider.rclient.set(key, JSON.stringify(new Device(stored))), done);
        });
      });
    });
  }
};

// The auth code is a 200-character token from a 64-character alphabet, so it
// carries far more entropy than any password and cannot be brute forced from
// its digest; a plain SHA-256 is enough and no salt or KDF is warranted.
function hashAuthCode(authCode) {
  return crypto.createHash('sha256').update(String(authCode), 'utf8').digest('hex');
}

Device = function(data) {
  if (data) {
    this.id = data.id;
    this.ident = data.ident;
    this.name = data.name;
    this.ownerUid = data.ownerUid;

    if (data.authHash) {
      this.authHash = data.authHash;
    } else if (data.authCode) {
      // record written before tokens were hashed: convert on load so that
      // saving it again drops the cleartext, without invalidating the token
      this.authHash = hashAuthCode(data.authCode);
    } else {
      this.authHash = null;
    }
  } else {
    this.id = null;
    this.ident = this.genIdent();
    this.name = "";
    this.ownerUid = null;

    // the cleartext exists only on this in-memory instance, to hand back to
    // the client once; toJSON below keeps it out of the stored record
    this.authCode = this.genAuthCode();
    this.authHash = hashAuthCode(this.authCode);
  }
};

Device.prototype = {
  genCode: function(len) {
    var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-_";
    var salt = '';

    // use a cryptographically secure RNG for auth tokens / identifiers
    var bytes = crypto.randomBytes(len);
    for (var i=0; i < len; i++) {
      salt += chars.charAt(bytes[i] % chars.length);
    }
    return salt;
  },

  genIdent: function() {
    return this.genCode(8);
  },

  genAuthCode: function() {
    return this.genCode(200);
  },

  checkAuthCode: function(authCode) {
    if (typeof authCode !== 'string' || typeof this.authHash !== 'string') {
      return false;
    }
    var expected = Buffer.from(this.authHash, 'hex');
    var actual = Buffer.from(hashAuthCode(authCode), 'hex');
    if (expected.length !== actual.length) {
      return false;
    }
    return crypto.timingSafeEqual(expected, actual);
  },

  // keeps the cleartext token out of redis: only ever returned to the client
  // that created the device
  toJSON: function() {
    return {
      id: this.id,
      ident: this.ident,
      authHash: this.authHash,
      name: this.name,
      ownerUid: this.ownerUid
    };
  }
};

exports.DeviceProvider = DeviceProvider;
