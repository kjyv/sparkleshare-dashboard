var config = require('./config');
var crypto = require('crypto');

LinkCodeProvider = function() {
  this.validCodes = [];
};

// Codes are compared against attacker-supplied input, so compare in constant
// time and never leak a position-of-first-difference signal.
function codeEquals(expected, given) {
  if (typeof given !== 'string') {
    return false;
  }
  var a = Buffer.from(expected, 'utf8');
  var b = Buffer.from(given, 'utf8');
  // length is not secret (it is displayed to the user), so bailing here is fine
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

LinkCodeProvider.prototype = {
  // digits in a linking code. This keyspace is the only thing between an
  // unauthenticated caller of /api/getAuthCode and a permanent device token
  // carrying the code owner's full ACL, so it is deliberately wider than a
  // human-friendly 6 digits; guessing is additionally rate limited in app.js.
  codeLen: 8,

  getNewCode: function(uid) {
    this.gc();

    // cryptographically secure, uniformly distributed numeric code
    var max = Math.pow(10, this.codeLen);
    var code = crypto.randomInt(0, max).toString().padStart(this.codeLen, '0');

    this.validCodes.push({
      code: code,
      validUntil: (new Date()).getTime() + config.linkCodeValidFor * 1000,
      ownerUid: uid
    });

    return {code: code, validFor: config.linkCodeValidFor};
  },

  gc: function() {
    var now = (new Date()).getTime();
    var newValidCodes = [];

    for (var i = 0; i < this.validCodes.length; i++) {
      if (now < this.validCodes[i].validUntil) {
        newValidCodes.push(this.validCodes[i]);
      }
    }

    this.validCodes = newValidCodes;
  },

  isCodeValid: function(code) {
    var valid = false;
    var ownerUid = null;
    var now = (new Date()).getTime();

    for (var i = 0; i < this.validCodes.length; i++) {
      if (now >= this.validCodes[i].validUntil) {
        continue;
      }
      if (codeEquals(this.validCodes[i].code, code)) {
        this.validCodes[i].validUntil = 0;
        valid = true;
        ownerUid = this.validCodes[i].ownerUid;
        break;
      }
    }

    this.gc();
    return [valid, ownerUid];
  }
};

exports.LinkCodeProvider = LinkCodeProvider;
