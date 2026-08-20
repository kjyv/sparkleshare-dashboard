/* vim: set tabstop=2 shiftwidth=2 expandtab: */

/**
 * Module dependencies.
 */
var express = require('express');
var flash = require('connect-flash');
var logger = require('morgan');

var querystring = require('querystring');
var i18n = require("i18n");

var config = require('./config');
var errors = require('./error');
var utils = require('./utils');
var pathlib = require('path');
var crypto = require('crypto');

const redis = require('redis')
const ExpressSession = require('express-session');
const RedisStore = require('connect-redis').RedisStore;

let redisClient = redis.createClient(config.redis || {});
// unref'd only once the server is listening (see runApp): an unref'd socket is
// not enough to hold the event loop open, so doing it earlier makes node exit
// during startup before the upgrade query can come back.
redisClient.on('error', console.log)
let redisStore = new RedisStore({ client: redisClient })

// The session secret signs the cookies that carry every login, so a guessable
// one lets anybody mint a session for any user, admins included. The value in
// example-config.js is published in this repository, so leaving it in place is
// the same as having no authentication at all - warn loudly rather than let it
// pass unnoticed.
function checkSessionSecret() {
  var secret = config.sessionSecret;
  var problem = null;

  if (!secret || typeof secret !== 'string') {
    problem = 'is missing';
  } else if (secret === 'JustSomeRandomString') {
    problem = 'is still the placeholder from example-config.js, which is public';
  } else if (secret.length < 32) {
    problem = 'is only ' + secret.length + ' characters; use at least 32';
  }

  if (problem) {
    console.error('');
    console.error('  ****************************************************************');
    console.error('  * WARNING: config.sessionSecret ' + problem);
    console.error('  * Anyone who knows it can forge a session for any user.');
    console.error('  * Generate one with:');
    console.error('  *   node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"');
    console.error('  ****************************************************************');
    console.error('');
  }
}

checkSessionSecret();

let session = ExpressSession({
  cookie: {
    maxAge: config.sessionValidFor,
    httpOnly: true,
    sameSite: 'lax',
    //'auto' marks the cookie Secure whenever the request itself was secure,
    //which - with 'trust proxy' set below - includes TLS terminated at a
    //reverse proxy. Tying this to config.https.enabled instead meant a
    //proxied deployment shipped its session cookie without Secure.
    secure: 'auto'
  },
  resave: true,
  saveUninitialized: false,
  rolling: true,
  secret: config.sessionSecret,
  store: redisStore
});

var sass = require('sass');
var fs = require('fs');

var app = express();

// Built here rather than in runApp() so an unreadable key/cert fails at startup,
// but not listened on until runApp(): binding twice would leave a second,
// unrestricted listener alongside the configured one.
var server;
if (config.https.enabled) {
  var https = require("https");

  server = https.createServer({
    key: fs.readFileSync(config.https.key).toString(),
    cert: fs.readFileSync(config.https.cert).toString()
  }, app);
} else {
  var http = require('http');

  server = http.createServer(app);
}

i18n.configure({
  locales: ['en', 'cs', 'de', 'el']
});


// Configuration
var lf = utils.getLoggingFormat();
if (lf) {
  app.use(logger(lf));
}
app.set('views', __dirname + '/views');
app.set('view engine', 'pug');
app.set('basepath', config.basepath);

//X-Forwarded-* is only meaningful when a proxy we trust sets it. Previously
//any client could send X-Forwarded-Proto: https and have the app treat its
//plaintext connection as encrypted; express' own handling gates that on this
//setting, and it is what makes req.ip (used for rate limiting) and the 'auto'
//cookie flag above correct behind a proxy.
app.set('trust proxy', config.trustProxy || false);

var DeviceProvider = require('./deviceProvider').DeviceProvider;
var deviceProvider = new DeviceProvider(redisClient);
var UserProvider = require('./users/userProvider').UserProvider;
var userProvider = new UserProvider(config.userProvider, redisClient, deviceProvider)

var passport = require('passport');

passport.serializeUser(function (user, next) {
  userProvider.serializeUser(user, next);
});

passport.deserializeUser(function (login, next) {
  userProvider.deserializeUser(login, next);
});

passport.use(userProvider.strategy)

var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var methodOverride = require('method-override');

app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(bodyParser.json());
app.use(methodOverride());
app.use(cookieParser());
app.use(flash());
app.use(function(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  // req.path is the raw request target: it is not normalised, so joining it
  // onto a directory lets "/../../.." escape. Take only the stylesheet name,
  // from a pattern that cannot match a separator or a dot segment.
  var name = /^\/stylesheets\/([\w-]+)\.css$/.exec(req.path);
  if (!name) return next();

  var scssPath = pathlib.join(__dirname, 'stylesheets', name[1] + '.scss');
  var cssPath = pathlib.join(__dirname, 'public', 'stylesheets', name[1] + '.css');

  try {
    var srcStat = fs.statSync(scssPath);
  } catch(e) {
    return next();
  }

  try {
    var destStat = fs.statSync(cssPath);
    if (destStat.mtime >= srcStat.mtime) return next();
  } catch(e) {
    // CSS doesn't exist yet, compile it
  }

  try {
    var result = sass.compile(scssPath);
    fs.mkdirSync(pathlib.dirname(cssPath), { recursive: true });
    fs.writeFileSync(cssPath, result.css);
  } catch(e) {
    console.error('Sass compilation error:', e.message);
  }
  next();
});
app.use(express.static(pathlib.join(__dirname, 'public')));
app.use(i18n.init);
app.use(session);
app.use(passport.initialize());
app.use(passport.session());

app.use(function (req, res, next) {
  res.locals.session = req.session;
  res.locals.user = req.user;
  res.locals.basepath = app.get('basepath');
  res.locals.convertSize = function (bytes) {
    var unit = 0;
    while (unit < 3 && bytes >= 1024) {
      unit++;
      bytes /= 1024;
    };
    return (Math.round(bytes * 100, 2) / 100).toString() + " " + ["", "Ki", "Mi", "Gi"][unit] + "B";
  }
  res.locals.__i = i18n.__;
  res.locals.__n = i18n.__n;

  res.locals.flash = req.flash;

  //prevent caching of file preview and listing to prevent showing old data
  res.header('Cache-Control', 'no-cache, private, no-store, must-revalidate, max-stale=0, post-check=0, pre-check=0, max-age=0')
  res.header('Expires', '-1')
  res.header('Pragma', 'no-cache')

  //baseline hardening headers
  res.header('X-Content-Type-Options', 'nosniff')
  res.header('X-Frame-Options', 'SAMEORIGIN')
  res.header('Referrer-Policy', 'same-origin')

  //Everything this app loads is same-origin, so the policy can start from
  //nothing and name only what is actually used. It matters most on the file
  //preview and inline image/pdf routes, which serve repository content back
  //from this origin. The two inline <script> blocks carry this nonce instead of
  //the policy having to allow inline script wholesale.
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  res.header('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'self' 'nonce-" + res.locals.cspNonce + "'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "object-src 'none'"
  ].join('; '))

  //pointless over plain http, and only correct about the scheme once
  //'trust proxy' is configured for a terminating proxy. Deliberately without
  //includeSubDomains or preload: both reach hosts this app knows nothing about
  //and are painful to walk back.
  if (req.secure) {
    res.header('Strict-Transport-Security', 'max-age=15552000')
  }

  next();
});

var FolderProvider = require('./folderProvider').FolderProvider;
var folderProvider = new FolderProvider(config.folders);
var LinkCodeProvider = require('./linkCodeProvider').LinkCodeProvider;
var linkCodeProvider = new LinkCodeProvider();

var middleware = require('./middleware');
middleware.setup(userProvider, deviceProvider, folderProvider, linkCodeProvider);

var RateLimiter = require('./rateLimit').RateLimiter;

//scrypt runs on the event loop, so an unauthenticated login flood is also a
//liveness problem, not just a guessing problem. Only failures are counted.
var loginAttempts = new RateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

app.use(middleware.csrfToken);
app.use(middleware.csrfProtect);

// Routes
app.all(/^(?!\/api\/).+/, function (req, res, next) {
  session(req, res, next);
});

require('./api')(app, deviceProvider, folderProvider, middleware);

app.get('/', function (req, res) {
  res.redirect('/login');
});

//POST, so a third-party page cannot log a user out with an <img> tag
app.post('/logout', function (req, res) {
  req.session.destroy(function () {
    res.redirect('/login');
  });
});

app.route('/login').get(function (req, res) {
  userProvider.getUserCount(function (error, count) {
    if (count < 1) {
      res.redirect('/createFirstUser');
    } else {
      if (req.user) {
        res.redirect('/folder');
      } else {
        res.render('login');
      }
    }
  });
}).post(function (req, res, next) {
  var key = RateLimiter.byIp(req);

  if (loginAttempts.isBlocked(key)) {
    res.set('Retry-After', String(loginAttempts.retryAfter(key)));
    return next(new errors.TooManyRequests('Too many login attempts'));
  }

  //custom callback rather than the failureRedirect option, so a failure can be
  //counted against the limiter above
  passport.authenticate(config.userProvider.name, function (error, user) {
    if (error) {
      return next(error);
    }
    if (!user) {
      loginAttempts.hit(key);
      req.flash('error', i18n.__('Invalid username or password.'));
      return res.redirect('/login');
    }

    req.logIn(user, function (error) {
      if (error) {
        return next(error);
      }
      loginAttempts.reset(key);
      res.redirect('/folder');
    });
  })(req, res, next);
});

app.route('/createFirstUser').get(middleware.userDbEmpty, function (req, res) {
  res.render('createFirstUser', {
    formval: {}
  });
}).post(middleware.userDbEmpty, function (req, res) {
  var reRenderForm = function () {
    res.render('createFirstUser', {
      formval: req.body
    });
  };

  if (!req.body.passwd1) {
    req.flash('error', i18n.__('Password could not be empty'));
    return reRenderForm();
  }

  if (req.body.passwd1 != req.body.passwd2) {
    req.flash('error', i18n.__('Passwords must match'));
    return reRenderForm();
  }

  userProvider.createNew(req.body.login, req.body.realname, req.body.passwd1, true, [], function (error, user) {
    if (error) {
      req.flash('error', error);
      reRenderForm();
    } else {
      res.redirect('/login');
    }
  });
});

app.route('/changeProfile').get(middleware.isLogged, function (req, res) {
  res.render('changeProfile', {
    formval: req.user
  });
}).post(middleware.isLogged, function (req, res, next) {
  var reRenderForm = function () {
    res.render('changeProfile', {
      formval: req.body
    });
  };

  var user = req.user;

  var saveProfile = function () {
    user.name = req.body.name;

    userProvider.updateUser(user, function (error) {
      if (error) {
        return next(error);
      }
      req.flash('info', i18n.__('Profile updated'));
      res.redirect('/changeProfile');
    });
  };

  if (!req.body.new1) {
    return saveProfile();
  }

  if (req.body.new1 != req.body.new2) {
    req.flash('error', i18n.__('Passwords must match'));
    return reRenderForm();
  }

  if (!req.body.current) {
    req.flash('error', i18n.__('Current password is not correct'));
    return reRenderForm();
  }

  //a live session alone must not be enough to set a new password, or a
  //hijacked cookie (or an unlocked shared browser) turns into permanent
  //account takeover with the real owner locked out
  user.checkPassword(req.body.current, function (error, matches) {
    if (error) {
      return next(error);
    }
    if (!matches) {
      req.flash('error', i18n.__('Current password is not correct'));
      return reRenderForm();
    }

    user.setPassword(req.body.new1, function (error) {
      if (error) {
        return next(error);
      }
      req.flash('info', i18n.__('Password updated'));
      saveProfile();
    });
  });
});

app.get('/manageUsers', [middleware.isLogged, middleware.isAdmin], function (req, res, next) {
  userProvider.findAll(function (error, u) {
    if (error) {
      return next(error);
    }
    res.render('manageUsers', {
      users: u
    });
  });
});

app.route('/modifyUser/:uid').get([middleware.isLogged, middleware.isAdmin, middleware.loadUser], function (req, res, next) {
  folderProvider.findAll(function (error, folders) {
    if (error) {
      return next(error);
    }
    res.render('modifyUser', {
      u: req.loadedUser,
      folders: folders
    });
  });
}).post([middleware.isLogged, middleware.isAdmin, middleware.loadUser], function (req, res, next) {
  folderProvider.findAll(function (error, folders) {
    if (error) {
      return next(error);
    }

    var u = req.loadedUser;
    u.name = req.body.name;
    u.admin = req.body.admin == 't' ? true : false;
    u.acl = req.body.acl ? req.body.acl : [];

    userProvider.updateUser(u, function (error) {
      req.flash('info', i18n.__('User updated'));
      res.redirect('/manageUsers');
    });
  });
});

app.route('/deleteUser/:uid').get([middleware.isLogged, middleware.isAdmin, middleware.loadUser], function (req, res, next) {
  res.render('deleteUser', {
    u: req.loadedUser
  });
}).post([middleware.isLogged, middleware.isAdmin, middleware.loadUser], function (req, res, next) {
  var reRenderForm = function () {
    res.render('deleteUser', {
      u: req.body
    });
  };

  var u = req.loadedUser;

  userProvider.deleteUser(u.uid, function (error) {
    if (error) {
      req.flash('error', error.message);
      reRenderForm();
    } else {
      req.flash('info', i18n.__('User deleted'));
      res.redirect('/manageUsers');
    }
  });
});

app.route('/createUser').get([middleware.isLogged, middleware.isAdmin], function (req, res) {
  res.render('createUser', {
    formval: {}
  });
}).post([middleware.isLogged, middleware.isAdmin], function (req, res) {
  var reRenderForm = function () {
    res.render('createUser', {
      formval: req.body
    });
  };

  if (!req.body.passwd1) {
    req.flash('error', i18n.__('Password could not be empty'));
    return reRenderForm();
  }

  if (req.body.passwd1 != req.body.passwd2) {
    req.flash('error', i18n.__('Passwords must match'));
    return reRenderForm();
  }

  userProvider.createNew(req.body.login, req.body.realname, req.body.passwd1, req.body.admin == 't', [], function (error, user) {
    if (error) {
      req.flash('error', error);
      reRenderForm();
    } else {
      req.flash('info', i18n.__('User created'));
      res.redirect('/manageUsers');
    }
  });
});

//TODO: put logic that is shared between publicFolder and folder into helper func
//note: this deliberately does not apply checkFolderAcl - a folder marked
//pub:true in the config is documented as a public folder, so any logged-in
//user may read it. Only folders the caller can already reach ever render a
//"Public Link", so this is reachable by URL-guessing alone; tighten it here if
//pub is ever meant to mean "listed publicly but still ACL-gated".
app.get('/publicFolder/:folderId', middleware.isLogged, function (req, res, next) {
  folderProvider.findById(req.params.folderId, function (error, folder) {
    //without this, an unknown folderId dereferences undefined below and 500s
    if (error) {
      return next(error);
    }
    if (!folder.pub) {
      next(new errors.Permission('This is not a public folder'));
    } else {
      var filename = req.query.name;
      if (!filename) {
        filename = 'file';
      }
      res.attachment(filename);

      folder.getRawData(req,
        function (error, data) {
          if (error) {
            return next(error);
          }
          res.write(data);
        },
        function (error, data) {
          if (error) {
            return next(error);
          }
          res.end();
        }
      );
    }
  });
});

app.get(['/folder', '/folder/:folderId'], middleware.isLogged, middleware.checkFolderAcl, function (req, res, next) {
  if (!req.params.folderId) {
    folderProvider.findAll(function (error, folders) {
      if (error) {
        return next(error);
      }

      utils.aclFilterFolderList(folders, req.user);

      //show repo list
      res.render('folders', {
        folders: folders
      });
    });
  } else {
    //show specified folderId
    folderProvider.findById(req.params.folderId, function (error, folder) {
      if (error) {
        return next(error);
      }

      //get current repo path from url; defaulted because the preview below
      //feeds it to path.dirname(), which throws on undefined, and that throw
      //lands in a git callback where it would kill the process
      var curPath = req.query.path || '';
      var parUrl = null;

      if (curPath) {
        var parPath = curPath.split('/');
        parPath.pop();
        parPath = parPath.join('/');
        parUrl = querystring.stringify({
          path: parPath
        });
      }

      if (req.query.type == 'file') {
        //show one file
        var filename = req.query.name;
        if (!filename) {
          filename = 'file';
        }

        //set Content-Disposition so file is downloaded by the browser (Content-Type will be set by .ext)
        res.attachment(filename);

        //content types that wil be treated as text (editable)
        var text_types = [
            'text/',
            'application/x-tex',
            'application/x-sh',
            'application/x-javascript',
            'application/xhtml+xml',
            'application/xml'
        ]

        //content types that will be passed to the browser and not downloaded
        var view_types = [
            'image/',
            'application/pdf',
        ]

        var is_editable = false;
        text_types.forEach(function (t) {
          if (res.get('Content-Type').search(t) != -1) {
            //display directly if text type
            //res.set('Content-Disposition', '')
            res.removeHeader('Content-Disposition')
            res.set('Content-Type', 'text/plain')
            is_editable = true
          }
        });

        //SVG (and XML-based images) can carry embedded <script>; never serve
        //them inline as that would execute in the dashboard's origin (stored XSS).
        //Such files keep their attachment Content-Disposition and are downloaded.
        var ctype = res.get('Content-Type') || '';
        var inlineSafe = ctype.search('svg') == -1 && ctype.search('xml') == -1;

        view_types.forEach(function (t) {
          if (inlineSafe && ctype.search(t) != -1) {
            res.set('Content-Disposition', '')
          }
        });

        if (req.query.download == 'force') {
          is_editable = false
        }

        //download file
        var previewChunks = is_editable ? [] : null;

        folder.getRawData(req,
          function (error, data) {
            if (error) {
              return next(error);
            }
            if (is_editable) {
              //this fires once per git stdout chunk, so the preview must not be
              //rendered here: a file larger than one chunk (~64k) would render
              //repeatedly and throw ERR_HTTP_HEADERS_SENT from inside a stream
              //handler, where express cannot catch it and node exits. Collect
              //the chunks and render once, below, when git is done.
              previewChunks.push(data);
            } else {
              //otherwise just return the file contents
              res.write(data);
            }
          },
          function (error, data) {
            if (error) {
              return next(error);
            }
            if (!is_editable) {
              return res.end();
            }

            //if we have a viewable type, render preview/edit view
            res.removeHeader('Content-Type')
            res.render('preview', {
              'file': filename,   //this file (called file because pug has filename reserved)
              'path': querystring.escape(curPath),    //repo path to file (with filename)
              'parent': folder,   //parent directory object
              'parent_repo_path': querystring.escape(pathlib.dirname(curPath)),  //parent path in repo
              'data': Buffer.concat(previewChunks).toString('utf8'),   //file contents
              'filehash': req.query.hash
            })
          }
        );
      } else {
        //show folder contents
        folder.getItems(req, function (error, list) {
          if (error) {
            return next(error);
          }

          res.render('folder', {
            folder: folder,
            tree: list,
            path: curPath,
            parUrl: parUrl
          });
        });
      }
    });
  }
});

app.post('/putFile/:folderId', [middleware.isLogged, middleware.checkFolderAcl], function (req, res, next) {
  if (!req.params.folderId) {
    return next(new Error('No folder id given'))
  } else {
    folderProvider.findById(req.params.folderId, function (error, folder) {
      if (error) {
        return next(error);
      }
      var filepath = req.query.path
      if (req.body.content && filepath) {
        //call api method or common helper method to save file
        folder.putFile(req, req.body.content,
          function (error, data) {
            if (error) {
              return next(error);
            }
            res.redirect('/folder/' + folder.id + '?type=dir&' + querystring.stringify({
              path: pathlib.dirname(filepath)
            }))
          });
      } else {
        return next(new Error('no data from form'))
      }
    });
  }
});

app.get(['/recentchanges', '/recentchanges/:folderId'], middleware.isLogged, middleware.checkFolderAcl, function (req, res, next) {
  folderProvider.findById(req.params.folderId, function (error, folder) {
    if (error) {
      return next(error);
    }
    folder.getRecentChanges(req, function (error, data) {
      if (error) {
        return next(error);
      }

      res.render('recentchanges', {
        data: data,
        folder: folder
      });
    });
  });
});

app.get('/download/:folderId', middleware.isLogged, middleware.checkFolderAcl, function (req, res, next) {
  folderProvider.findById(req.params.folderId, function (error, folder) {
    if (error) {
      return next(error);
    }
    var headersSent = false;
    var maybeSentHeaders = function () {
      if (headersSent) {
        return;
      }
      headersSent = true;
      var filename = 'archive';
      var path = req.query.path;
      if (path && path != '') {
        //must be global: a single unreplaced quote, semicolon, CR or LF from the
        //path would otherwise reach the Content-Disposition header below, which
        //either injects a second header parameter or throws from writeHead
        filename += '-' + path.replace(/[^\w\d-]/g, '_');
      }
      filename += '-' + req.params.folderId.substring(0, 8) + '.zip';
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + filename + '"'
      });
    };
    folder.createArchive(req, function (error, data) {
        if (error) {
          return next(error);
        }
        maybeSentHeaders();
        res.write(data);
      },
      function (error, data) {
        if (error) {
          return next(error);
        }
        maybeSentHeaders();
        res.end();
      }
    );
  });
});

app.get('/linkedDevices', middleware.isLogged, function (req, res, next) {
  if (req.user.admin) {
    deviceProvider.findAll(function (error, devices) {
      if (error) {
        return next(error);
      }

      r = function (logins) {
        res.render('linkedDevices', {
          devices: devices,
          logins: logins
        });
      };

      var logins = {};
      userProvider.findAll(function (error, users) {
        var count = users.length;
        if (count === 0) {
          r(logins);
        }
        users.forEach(function (user) {
          logins[user.uid] = user.login;
          if (--count === 0) {
            r(logins);
          }
        });
      });
    });
  } else {
    deviceProvider.findByUserId(req.user.uid, function (error, devices) {
      if (error) {
        return next(error);
      }
      res.render('linkedDevices', {
        devices: devices
      });
    });
  }
});

app.get('/linkDevice', middleware.isLogged, function (req, res) {
  var schema = config.https.enabled ? 'https' : 'http';
  var url = schema + '://' + req.hostname
  if (config.listen.port != 80) {
    url += ":" + config.listen.port;
  }

  if (config.externalUrl) {
    url = config.externalUrl;
  }

  res.render('linkDevice', {
    url: url
  });
});


app.route('/unlinkDevice/:did').get([middleware.isLogged, middleware.loadDevice, middleware.owningDevice], function (req, res, next) {
  res.render('unlinkDevice', {
    d: req.loadedDevice
  });
}).post([middleware.isLogged, middleware.loadDevice, middleware.owningDevice], function (req, res, next) {
  var d = req.loadedDevice;

  deviceProvider.unlinkDevice(d.id, function (error) {
    if (error) {
      req.flash('error', error.message);
      res.render('unlinkDevice', {
        d: req.loadedDevice
      });
    } else {
      req.flash('info', i18n.__('Device unlinked'));
      res.redirect('/linkedDevices');
    }
  });
});

app.route('/modifyDevice/:did').get([middleware.isLogged, middleware.loadDevice, middleware.owningDevice], function (req, res, next) {
  res.render('modifyDevice', {
    d: req.loadedDevice
  });
}).post([middleware.isLogged, middleware.loadDevice, middleware.owningDevice], function (req, res, next) {
  var d = req.loadedDevice;
  d.name = req.body.name;

  deviceProvider.updateDevice(d, function (error) {
    req.flash('info', i18n.__('Device updated'));
    res.redirect('/linkedDevices');
  });
});

//POST, not GET: minting a link code changes state, and as a GET it could be
//triggered by luring a logged-in user to a plain link (sameSite=lax still
//sends the session cookie on a top-level navigation), letting an attacker
//create codes for that user's uid on demand. As a POST it needs the CSRF token.
app.post('/getLinkCode', middleware.isLogged, function (req, res) {
  var code = linkCodeProvider.getNewCode(req.user.uid);
  var schema = config.https.enabled ? 'https' : 'http';
  code.url = schema + '://' + req.header('host');

  if (config.externalUrl) {
    code.url = config.externalUrl;
  }

  res.contentType('application/json');
  res.send(code);
});

// always keep this as last route
app.get('/stylesheets', function (req, res, next) {
  next();
});

app.use(function (req, res, next) {
  next(new errors.NotFound(req.url));
});

// error handler must be registered after all routes so next(err) reaches it
app.use(errors.errorHandler);

function runApp() {
  // app.listen() would open a second socket next to `server`; listen on the one
  // server we built, so config.listen.host is honoured over TLS as well.
  server.listen(config.listen.port, config.listen.host, function () {
    // the listening socket now holds the event loop, so the redis client no
    // longer needs to
    redisClient.unref();

    console.log("SparkleShare Dashboard listening on %s:%d over %s in %s mode",
      config.listen.host || '*', config.listen.port,
      config.https.enabled ? 'https' : 'http', app.settings.env);
  });

  if (config.fanout.enabled) {
    var fanout = require('./fanout/fanout');
    fanout.listen(config.fanout.port, config.fanout.host, function () {
      console.log("SparkleShare Fanout listening on port %d", config.fanout.port);
    });
  }
}

redisClient.connect().then(function () {
  //note: the client is deliberately not unref'd here - nothing else holds the
  //event loop open yet, so node would exit before the upgrade query returns.
  //runApp does it once the server is listening.

  // upgrade database
  require('./upgrade').upgrade(redisClient, runApp);
}, function (error) {
  console.error('could not connect to redis: ' + (error && error.message ? error.message : error));
  process.exit(1);
});
