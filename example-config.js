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

exports.userProvider = 'local'  // 'local', or 'userapp' for https://www.userapp.io/ support
exports.appId = ''              // userapp id
