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
  }
};

Device = function(data) {
  if (data) {
    this.id = data.id;
    this.ident = data.ident;
    this.authCode = data.authCode;
    this.name = data.name;
    this.ownerUid = data.ownerUid;
  } else {
    this.id = null;
    this.ident = this.genIdent();
    this.authCode = this.genAuthCode();
    this.name = "";
    this.ownerUid = null;
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
    if (typeof authCode !== 'string' || typeof this.authCode !== 'string') {
      return false;
    }
    var a = Buffer.from(this.authCode);
    var b = Buffer.from(authCode);
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }
};

exports.DeviceProvider = DeviceProvider;
