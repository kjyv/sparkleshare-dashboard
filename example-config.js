// Secret used to sign session cookies. Use a long, random, secret value and
// keep it private: anyone who knows it can forge session cookies.
// Generate one with, e.g.:
//   openssl rand -base64 48
//   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
exports.sessionSecret = 'JustSomeRandomString';

exports.folders = [
  { type: 'git', name: 'Public GIT folder', path: '/mnt/data/repos/repo1', pub: true },
  { type: 'git', name: 'Private GIT folder', path: '/mnt/data/repos/repo2', pub: false },
  { type: 'git', name: 'Windows GIT folder', path: 'D:\\data\\repo3\\.git', pub: false }
];

exports.listen = {
  port: 3000,
  host: null
};

exports.https = {
  enabled: false,
  key: '/path/to/private.key',
  cert: '/path/to/cert.crt'
};

exports.basepath = '';
exports.externalUrl = null;

// Connection options for the redis server holding users, devices and sessions.
// An empty object means localhost:6379. Anything node-redis' createClient
// accepts works here, e.g.:
//   exports.redis = { url: 'redis://:password@redis.internal:6379/0' };
exports.redis = {};

// Set this when the dashboard runs behind a reverse proxy, so X-Forwarded-For
// and X-Forwarded-Proto are honoured: rate limiting then sees the real client
// address, and the session cookie is marked Secure for TLS terminated at the
// proxy. Leave false when the app is reached directly, otherwise any client can
// spoof those headers. Accepts anything express' 'trust proxy' accepts, e.g.
// true, 1 (number of hops), 'loopback', or a specific address.
exports.trustProxy = false;

// time until link code is invalidated (in seconds)
exports.linkCodeValidFor = 300;

//time until session cookie is invalidated
exports.sessionValidFor = 3600000 * 24     //24 hours

// none | min | info | debug
exports.logging = 'none';

// Push notifications about folder changes, over a plain TCP pub/sub protocol.
// It has no authentication: anything that can reach the port may subscribe to
// any channel and announce on any channel, so notifications are both readable
// and forgeable by any client that can connect. Keep host restricted to an
// interface only trusted clients can reach - null would bind all of them.
exports.fanout = {
  enabled: false,
  host: '127.0.0.1',
  port: 1986
};

exports.backend = {
  'git': {
    'bin': 'git',               //the git executable
    'temp': '/mnt/data/temp'    //directory used for local checkouts (should exist)
  }
};

exports.userProvider = {
  name: 'local',                // for now, only 'local' (using Redis) is available
  usernameField: 'login',
  passwordField: 'password'
}
