var deviceProvider = null;
var folderProvider = null;
var middleware = null;

var utils = require('./utils');
var bodyParser = require('body-parser');

Api = function(app, dp, fp, mw) {
  deviceProvider = dp;
  folderProvider = fp;
  middleware = mw;

  app.post('/api/getAuthCode', middleware.validateLinkCode, function(req, res, next) {
    //the clients post the device name in the form body alongside the link code;
    //only the query string was read before, so every device linked from a phone
    //was stored nameless and showed up as "", " (1)", " (2)" in the device list.
    //The query string is still accepted for anything that sends it there.
    var name = (req.body && req.body.name) || req.query.name;
    if (typeof name !== 'string') {
      name = '';
    }

    deviceProvider.createNew(name, req.linkCodeForUid, function(error, dev) {
      //without this an error left dev undefined, and the TypeError below came
      //out of a promise callback - an unhandled rejection, which is fatal
      if (error) {
        return next(error);
      }

      res.json({
        ident: dev.ident,
        authCode: dev.authCode
      });
    });
  });

  app.get('/api/getFolderList', middleware.validateAuthCode, function(req, res, next) {
    folderProvider.findAll(function(error, folders) {
      if (error) { return next(error); }

      utils.aclFilterFolderList(folders, req.user);

      var f = [];
      for (var id in folders) {
        if (folders.hasOwnProperty(id)) {
          f.push({
            name: folders[id].name,
            id: folders[id].id,
            type: folders[id].type
          });
        }
      }
      res.json(f);
    });
  });

  app.get('/api/getFile/:folderId', [middleware.validateAuthCode, middleware.checkFolderAcl,
        middleware.loadFolder], function(req, res, next) {
    var filename = req.query.name;
    if (!filename) {
      filename = 'file';
    }
    res.attachment(filename);

    req.loadedFolder.getRawData(req,
      function(error, data) {
        if (error) { return next(error); }
        res.write(data);
      },
      function(error, data) {
        if (error) { return next(error); }
        res.end();
      }
    );
  });

  app.post('/api/putFile/:folderId', [
        bodyParser.raw({ type: 'application/octet-stream', limit: '50mb' }),
        middleware.validateAuthCode, middleware.checkFolderAcl,
        middleware.loadFolder], function(req, res, next) {
    var fileData;
    if (Buffer.isBuffer(req.body)) {
      fileData = req.body;
    } else if (req.body && req.body.data) {
      fileData = req.body.data;
    } else {
      return res.status(400).send('No file data received');
    }

    req.loadedFolder.putFile(req, fileData,
      function(error, data) {
        if (error) { return next(error); }
        res.send(data);
      });
  });

  app.post('/api/postFile/:folderId', [
        bodyParser.raw({ type: 'application/octet-stream', limit: '50mb' }),
        middleware.validateAuthCode, middleware.checkFolderAcl,
        middleware.loadFolder], function(req, res, next) {
    var fileData;
    if (Buffer.isBuffer(req.body)) {
      fileData = req.body;
    } else if (req.body && req.body.data) {
      fileData = req.body.data;
    } else {
      return res.status(400).send('No file data received');
    }

    req.loadedFolder.putFile(req, fileData, { createOnly: true },
      function(error, data) {
        if (error) { return next(error); }
        res.status(201).send(data);
      });
  });

  app.get('/api/getFolderContent/:folderId', [middleware.validateAuthCode, middleware.checkFolderAcl,
        middleware.loadFolder], function(req, res, next) {
    //console.log(req.deviceAcl);
    req.loadedFolder.getItems(req, function(error, list) {
      if (error) { return next(error); }

      res.json(list);
    });
  });

  app.get('/api/getFolderRevision/:folderId', [middleware.validateAuthCode, middleware.checkFolderAcl,
        middleware.loadFolder], function(req, res, next) {
    req.loadedFolder.getCurrentRevision(req, function(error, revision) {
      if (error) { return next(error); }
      res.json(revision);
    });
  });

  app.get('/api/getAllItemCount/:folderId', [middleware.validateAuthCode, middleware.checkFolderAcl,
        middleware.loadFolder], function(req, res, next) {
    req.loadedFolder.getAllItemCount(req, function(error, count) {
      if (error) { return next(error); }
      res.json(count);
    });
  });

  app.get('/api/getFolderItemCount/:folderId', [middleware.validateAuthCode, middleware.checkFolderAcl,
        middleware.loadFolder], function(req, res, next) {
    req.loadedFolder.getFolderItemCount(req, function(error, count) {
      if (error) { return next(error); }
      if (!res.headersSent) { 
         res.json(count);
      }
    });
  });

  app.get('/api/whoami', middleware.validateAuthCode, function(req, res, next) {
    res.json({
      login: req.user.login,
      name: req.user.name,
      deviceName: req.currentDevice.name
    });
  });

  app.get('/api/ping', middleware.validateAuthCode, function(req, res, next) {
    res.json("pong");
  });
};

module.exports = Api;
