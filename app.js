/**
 * Module dependencies.
 */
var express = require('express');
var querystring = require('querystring');

var config = require('./config');

var app = null;
if (config.https.enabled) {
  var fs = require("fs");
  var privateKey = fs.readFileSync(config.https.key);
  var certificate = fs.readFileSync(config.https.cert);
  app = module.exports = express.createServer({ key: privateKey, cert: certificate });
} else {
  app = module.exports = express.createServer();
}

// Configuration

app.configure(function(){
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(express.cookieParser());
  app.use(express.session({ secret: 'your secret here' }));
  app.use(express.compiler({ src: __dirname + '/public', enable: ['sass'] }));
  app.use(app.router);
  app.use(express.static(__dirname + '/public'));
});

var FolderProvider = require('./folderProvider').FolderProvider;
var folderProvider = new FolderProvider(config.folders);
var UserProvider = require('./userProvider').UserProvider;
var userProvider = new UserProvider('./user.db.json');
var LinkCodeProvider = require('./linkCodeProvider').LinkCodeProvider;
var linkCodeProvider = new LinkCodeProvider();
var DeviceProvider = require('./deviceProvider').DeviceProvider;
var deviceProvider = new DeviceProvider('./device.db.json');

require('./api')(app, linkCodeProvider, deviceProvider, folderProvider);

app.configure('development', function(){
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true })); 
});

app.configure('production', function(){
  app.use(express.errorHandler()); 
});

function auth(login, pass, next) {
 userProvider.findByLogin(login, function(error, user) {
    if (!user) {
      return next(new Error('Invalid login'));
    }

    if (user.checkPassword(pass)) {
      return next(null, user);
    } else {
      return next(new Error('Invalid login'));
    }
  });
}

function restrict(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    req.flash('error', 'Access denied!');
    res.redirect('/login');
  }
}
function userDbEmpty(req, res, next) {
  userProvider.getUserCount(function(error, count) {
    if (count < 1) {
      next();
    } else {
      req.flash('error', 'There are already some users. Ask admin for an account');
      res.redirect('/login');
    }
  });
}

// Dynamic helpers
app.dynamicHelpers({
  messages: require('express-messages'),
  user: function(req, res) {
    return req.session.user;
  }
});

// Routes
app.get('/', function(req, res){
  res.redirect('/login');
});

app.get('/logout', function(req, res){
  req.session.destroy(function(){
    res.redirect('home');
  });
});

app.get('/login', function(req, res){
  userProvider.getUserCount(function(error, count) {
    if (count < 1) {
      res.redirect('/createFirstUser');
    } else {
      if (req.session.user) {
        res.redirect('/folder');
      } else {
        res.render('login');
      }
    }
  });
});

app.get('/createFirstUser', userDbEmpty, function(req, res) {
  res.render('createFirstUser', { formval: {} });
});

app.post('/createFirstUser', userDbEmpty, function(req, res) {
  var reRenderForm = function() {
    res.render('createFirstUser', {
      formval: req.body
    });
  };

  if (!req.body.passwd1) {
    req.flash('error', 'Password could not be empty');
    return reRenderForm();
  }

  if (req.body.passwd1 != req.body.passwd2) {
    req.flash('error', 'Passwords must match');
    return reRenderForm();
  }

  userProvider.createNew(req.body.login, req.body.realname, req.body.passwd1, function(error, user) {
    if (error) {
      req.flash('error', error);
      reRenderForm();
    } else {
      res.redirect('/login');
    }
  });
});

app.post('/login', function(req, res){
  auth(req.body.login, req.body.password, function(error, user) {
    if (error) {
      req.flash('error', error);
      res.render('login');
    } else {
      if (user) {
        req.session.regenerate(function(){
          req.session.user = user;
          res.redirect('back');
        });
      } else {
        req.flash('error', error);
        res.render('login');
      }
    }
  });
});

app.get('/changePassword', restrict, function(req, res) {
  res.render('changePassword');
});

app.post('/changePassword', restrict, function(req, res, next) {
  if (!req.body.old) {
    req.flash('error', 'You must provide your old password');
    return res.render('changePassword');
  }

  if (!req.body.new1) {
    req.flash('error', 'New password could not be empty');
    return res.render('changePassword');
  }

  if (req.body.new1 != req.body.new2) {
    req.flash('error', 'Passwords must match');
    return res.render('changePassword');
  }

  auth(req.session.user.login, req.body.old, function(error, user) {
    if (error) {
      req.flash('error', 'Your old password is not valid');
      return res.render('changePassword');
    }

    user.setPassword(req.body.new1);
    userProvider.updateUser(user, function(error) {
      req.flash('info', 'Password updated');
      res.redirect('back');
    });
  });
});

app.get('/folder/:folderId?', restrict, function(req, res, next){
  if (!req.params.folderId) {
    folderProvider.findAll(function(error, folders){
      if (error) {return next(error);}
      res.render('folders', {
        folders: folders
      });
    });
  } else {
    folderProvider.findById(req.params.folderId, function(error, folder){
      if (req.param('type') == 'file') {
        var filename = req.param('name');
        if (!filename) {
          filename = 'file';
        }
        res.attachment(filename);

        folder.getRawData(req,
          function(error, data) {
            if (error) { return next(error); }
            res.write(data);
          },
          function(error, data) {
            if (error) { return next(error); }
            res.end();
          }
        );
      } else {
        folder.getItems(req, function(error, list) {
          if (error) { return next(error); }

          var curPath = req.param('path');
          var parUrl = null;

          if (curPath) {
            var parPath = curPath.split('/');
            parPath.pop();
            parPath = parPath.join('/');
            parUrl = querystring.stringify({
              path: parPath
            });
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

app.get('/linkedDevices', restrict, function(req, res, next) {
  deviceProvider.findAll(function(error, devices) {
    if (error) { return next(error); }
    res.render('linkedDevices', {
      devices: devices
    });
  });
});

app.get('/linkDevice', restrict, function(req, res) {
  res.render('linkDevice', {
    url: 'http://' + req.header('host')
  });
});

app.get('/getLinkCode', restrict, function(req, res) {
  var code = linkCodeProvider.getNewCode();
  code.url = 'http://' + req.header('host');

  res.contentType('application/json');
  res.send(code);
});

app.listen(3000);
console.log("Express server listening on port %d in %s mode", app.address().port, app.settings.env);