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

// time until link code is invalidated (in seconds)
exports.linkCodeValidFor = 300;

//time until session cookie is invalidated
exports.sessionValidFor = 3600000 * 24     //24 hours

// none | min | info | debug
exports.logging = 'none';

exports.fanout = {
  enabled: false,
  host: null,
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
