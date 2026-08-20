var toCallback = require('./redisPromise').toCallback;

function createUserDeviceNames(rclient, next) {
  // create user device name sets when they are missing
  var DeviceProvider = require('./deviceProvider').DeviceProvider;
  var deviceProvider = new DeviceProvider(rclient);

  toCallback(rclient.sMembers("uids"), function(error, uids) {
    if (error) { return next(error); }

    var count = uids.length;
    if (count === 0) {
      return next();
    }

    function doneForUid() {
      if (--count === 0) {
        return next();
      }
    }

    function saveDeviceNamesList(uid, next) {
      console.log("DB UPGRADE: saving device names list for uid: " + uid);
      deviceProvider.findByUserId(uid, function(error, devices) {
        if (error) { return next(error); }

        var dcount = devices.length;
        if (dcount === 0) {
          toCallback(rclient.sAdd("uid:" + uid + ":deviceNames", ''));
          return next();
        }
        devices.forEach(function(device) {
          toCallback(rclient.sAdd("uid:" + uid + ":deviceNames", device.name ? device.name : ''));
          if (--dcount === 0) {
            return next();
          }
        });
      });
    }

    uids.forEach(function(uid) {
      toCallback(rclient.exists("uid:" + uid + ":deviceNames"), function(error, exists) {
        if (error) { return next(error); }
        if (!exists) {
          saveDeviceNamesList(uid, doneForUid);
        } else {
          doneForUid();
        }
      });
    });
  });
}

exports.upgrade = function(rclient, next) {
  createUserDeviceNames(rclient, next);
};
