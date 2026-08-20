/* vim: set tabstop=2 shiftwidth=2 expandtab: */

var config = require('../config');
var errors = require('../error');

GitBackend = function (path) {
  this.path = path;
};

var spawn = require('child_process').spawn;
var querystring = require('querystring');
var mimeTypes = require('mime-types');
var fs = require('fs');
var pathlib = require('path');
var async = require('async');
var crypto = require('crypto');

//NUL and other control characters make spawn() and fs.writeFile() throw
//synchronously. On the putFile path that throw happens inside a git exit
//callback, outside express' reach, so it takes the whole process down; a
//newline additionally forges a second Content-Disposition parameter when the
//path is echoed into a download filename. Neither is legitimate in a repo path.
function hasControlChars(path) {
  return /[\x00-\x1f\x7f]/.test(path);
}

function parseList(list, curPath, next) {
  var r = list.split(/\0/);
  linere = /^[0-9]+\s(blob|tree)\s([a-f0-9]{40})\s+([0-9]+|-)\t+(.*)$/;

  ret = [];
  for(var i = 0; i < r.length; i++) {
    x = r[i].match(linere);
    if (x) {
      var type = null;
      var mimeType = null;
      if (x[1] == 'blob') {
        type = "file";
        mimeType = mimeTypes.lookup(x[4]) || "text/plain";
      } else if (x[1] == 'tree') {
        type = "dir";
        mimeType = "dir";
      }

      var listEntry = {
        id: x[2],
        hash: x[2],
        type: type,
        mime: mimeType,
        mimeBase: mimeType.split("/")[0],
        name: x[4],
        url: querystring.stringify({
          path: curPath.length ? curPath + '/' + x[4] : x[4],
          hash: x[2],
          name: x[4]
        }),
        directUrl: querystring.stringify({
          hash: x[2],
          name: x[4]
        })
      };

      if (type == 'file') {
        listEntry.fileSize = x[3];
      }

      ret.push(listEntry);
    }
  }
  next(null, ret);
}

function parseGitLog(data) {
  var lines =  data.split(/\r\n|\r|\n|\0/);
  var entries = [];
  var entryIndex = 0;
  var entry = "";
  var lastEntry = "";
  var j = 0;

  for(var i=0; i<lines.length; i++) {
    var line = lines[i];
    if ((line.slice(0,6) == "commit") && (j > 0)) {
      entries[entryIndex++] = entry;
      entry = "";
    }
    entry = entry + line + "\n";
    j++;
    lastEntry = entry;
  }
  entries[entryIndex++] = entry;

  var mergeRegex = /commit ([a-z0-9]{40})\nMerge: .+ .+\nAuthor: (.+) <(.+)>\nDate:   (.+)\n*/;
  var nonMergeRegex = /commit ([a-z0-9]{40})\nAuthor: (.+) <(.+)>\nDate:   (.+)\n*/;

  var changeSet = [];
  var changeSetIndex = 0;
  for(var i=0; i<entries.length; i++) {
    var logEntry = entries[i];
    var isMergeCommit = false;
    var regex;

    if (logEntry.indexOf("\nMerge: ") != -1) {
      regex = mergeRegex;
      isMergeCommit = true;
    }
    else {
      regex = nonMergeRegex;
    }

    var result = logEntry.match(regex);
    if (result != null) {
      var changeSetEntry = new Object();

      changeSetEntry.revision = result[1];
      changeSetEntry.username = result[2];
      changeSetEntry.useremail = result[3];
      changeSetEntry.isMagical = isMergeCommit;
      var timestamp = new Date(result[4]);
      changeSetEntry.timestamp = timestamp;

      changeSetEntry.added = []; var ai = 0;
      changeSetEntry.edited = []; var ei = 0;
      changeSetEntry.deleted = []; var di = 0;
      changeSetEntry.renamed = []; var ri = 0;

      var entryLines = logEntry.split(/\r\n|\r|\n/);
      for(var elIndex = 0; elIndex < entryLines.length; elIndex++) {
        entryLine = entryLines[elIndex];
        if (entryLine.charAt(0) == ":") {
          //extract change type from raw diff line
          //format: :old_mode new_mode old_hash new_hash status
          var parts = entryLine.split(/\s+/);
          var changeType = parts.length >= 5 ? parts[4].charAt(0) : null;
          var filePath = entryLines[elIndex + 1];
          var toFilePath = "";

          if (filePath.slice(-6) == ".empty") {
            filePath = filePath.substring(0, filePath.length - ".empty".length);
          }

          if ((changeType == "A") && (filePath.indexOf(".notes") == -1)) {
            changeSetEntry.added[ai++] = filePath;
          }
          else if (changeType == "M") {
            changeSetEntry.edited[ei++] = filePath;
          }
          else if (changeType == "D") {
            changeSetEntry.deleted[di++] = filePath;
          }
          else if (changeType == "R") {
            var renamedObj = new Object();
            var tabPos = entryLine.lastIndexOf("\t");
            filePath = entryLines[elIndex + 1];
            toFilePath = entryLines[elIndex + 2];

            renamedObj.from = filePath;
            renamedObj.to = toFilePath;

            changeSetEntry.renamed[ri++] = renamedObj;
          }
        }
      }

      if ((changeSetEntry.added.length
           + changeSetEntry.edited.length
           + changeSetEntry.deleted.length
           + changeSetEntry.renamed.length) > 0) {
          changeSet[changeSetIndex++] = changeSetEntry;
      }
    }
  }

  return changeSet;
}

GitBackend.prototype = {
  execGit: function(params, ondata, next) {
    //overload as execGit(params, next)
    if (typeof(next) == "undefined") {
      next = ondata;
      ondata = null;
    }

    //continue after git command has exited and do not care for output
    //(fixing problems with below logic when commands do not return anything)
    //callers append these as trailing arguments, so only strip them from the
    //end: searching the whole array with indexOf would splice out a
    //user-supplied path that happens to equal one of these strings, silently
    //changing which path the git command acts on
    var ignore_output = false
    var ignore_return_code = false
    for (;;) {
      var last = params[params.length - 1]
      if (last === "ignore_output") {
        ignore_output = true
        params.pop()
      } else if (last === "ignore_return_code") {
        ignore_return_code = true
        params.pop()
      } else {
        break
      }
    }

    //add path parameter, needed for older git versions
    params.unshift('--git-dir='+this.path);

    //console.log('git exec: git ' + params);

    //call git with all the given parameters
    var g = spawn(config.backend.git.bin, params, { encoding: 'binary' });

    // 'exit' can fire before stdout has been drained, so this used to wait for
    // both an 'exit' and a 'data' event before calling back. That never
    // completed for a command which writes nothing to stdout - git cat-file on
    // a zero-byte blob, for instance - leaving the request hung forever and the
    // socket held open. 'close' is emitted only once the process has ended AND
    // its stdio streams are closed, which is exactly the handshake wanted, so
    // it is a single authoritative signal.
    var exitCode, out, stderrOutput = '';
    var finalized = false;

    var finalize = function() {
      if (finalized) {
        return;
      }
      finalized = true;

      if (exitCode && !ignore_return_code) {
        var errMsg = 'GIT failed (exit code ' + exitCode + '): git ' + params.join(' ');
        if (stderrOutput) {
          errMsg += '\n' + stderrOutput.trim();
        }
        return next(new Error(errMsg));
      }
      //a command that produced nothing reports empty output rather than
      //undefined, which callers like parseList would choke on
      return next(null, typeof(out) == 'undefined' && !ondata ? '' : out);
    };

    if (ondata) {
      g.stdout.on('data', function(data) {
        out = true;
        ondata(null, data);
      });
    } else {
      g.stdout.on('data', function(data) {
         if (typeof(out) == 'undefined') {
            out = '';
         }
         out += data.toString('utf8');
      });
    }

    g.stderr.on('data', function(data) {
       //console.log('git stderr: ' + data);
       stderrOutput += data.toString('utf8');
       //preserved: callers of stderr-only commands used to receive this as the
       //command's output
       if (typeof(out) == 'undefined') {
          out = "git: " + data;
       }
    });

    g.on('close', function(code) {
      exitCode = code;
      //console.log("git exit code: " + code);
      finalize();
    });

    g.on('error', function(error) {
      //spawn itself failed (git missing, bad argument); without this the error
      //event is unhandled and takes the process down
      stderrOutput += error.message;
      exitCode = exitCode || 1;
      finalize();
    });
  },

  getRawData: function(req, ondata, next) {
    var hash = req.query.hash;
    if (!hash) {
      return next(new Error('No hash'));
    }
    if (!hash.match(/^[a-f0-9]{40}$/)) {
      return next(new Error('Invalid hash'));
    }

    this.execGit(['cat-file', 'blob', hash], ondata, next);
  },

  createArchive: function(req, ondata, next) {
    var arg = 'HEAD';
    var path = req.query.path;
    if (path) {
      if (hasControlChars(path)) {
        return next(new Error('Invalid file path'));
      }
      arg += ':' + path;
    }
    this.execGit(['archive', arg, '--prefix=archive/', '--format=zip'], ondata, next);
  },

  getItems: function(req, next) {
    var baseHash = req.query.hash;
    var path = req.query.path;
    if (!path) {
      path = '';
    }

    //a supplied tree-ish must be a full git object hash; reject anything else
    //so it can't be interpreted as a git option (argument injection)
    if (baseHash && !baseHash.match(/^[a-f0-9]{40}$/)) {
      return next(new Error('Invalid hash'));
    }
    if (hasControlChars(path)) {
      return next(new Error('Invalid file path'));
    }

    var mybackend = this;
    function getItemsFromHere(baseHash, path, next) {
      var execPath = path;
      if (!baseHash) {
        baseHash = 'HEAD';
      }

      mybackend.execGit(['ls-tree', '-z', '-l', baseHash, '--', '.'], function(error, data) {
        if (error) { return next(error); }
        parseList(data, path, next);
      });
    }

    if (!baseHash && path) {
      this.execGit(['ls-tree', '-z', '-l', 'HEAD', '--', path], function(error, data) {
        if (error) { return next(error); }
        parseList(data, path, function(error, list) {
          if (error) { return next(error); }
          if (list.length != 1) { return next(new Error('GIT parent lookup failed')); }
          baseHash = list[0].id;
          getItemsFromHere(baseHash, path, next);
        });
      });
    } else {
      getItemsFromHere(baseHash, path, next);
    }
  },

  getRecentChanges: function(req, next) {
    this.execGit(['log', '-z', '-50', '--raw', '-M', '--date=iso'], function(error, data) {
      if (error) { return next(error); }

      var changes = parseGitLog(data)
      next(null, changes);
    });
  },

  getId: function(next) {
    this.execGit(['rev-list', '--reverse', 'HEAD'], function(error, data) {
        if (error) { return next(error); }
        var r = data.split(/\r\n|\r|\n/);
        if (r[0].match(/^[a-f0-9]{40}$/)) {
          next(null, r[0]);
        } else {
          next(new Error('Folder not initialized'));
        }
      }
    );
  },

  getCurrentRevision: function(req, next) {
    this.execGit(['rev-list', '--max-count=1', 'HEAD'], function(error, data) {
      if (error) { return next(error); }
        var r = data.split(/\r\n|\r|\n/);
        if (r[0].match(/^[a-f0-9]{40}$/)) {
          next(null, r[0]);
        } else {
          next(new Error('Folder not initialized'));
        }
    });
  },

  getAllItemCount: function(req, next) {
    this.execGit(['ls-tree', '-rt', 'HEAD'], function(error, data) {
      if (error) { return next(error); }
        var r = data.split(/\r\n|\r|\n/);
        next(null, r.length - 1);
    });
  },

  getFolderItemCount: function(req, next) {
    this.getItems(req, function(error, items) {
      next(null, items.length);
    });
  },

  //overwrite an existing file or create a new one
  putFile: function(req, data, optionsOrNext, maybeNext) {
    var options, next;
    if (typeof optionsOrNext === 'function') {
      options = {};
      next = optionsOrNext;
    } else {
      options = optionsOrNext || {};
      next = maybeNext;
    }

    var path = req.query.path;
    if (!path) {
      return next(new Error('No file path given'));
    }

    // Prevent path traversal attacks
    var normalizedPath = pathlib.normalize(path).replace(/\\/g, '/');
    if (normalizedPath.startsWith('..') || pathlib.isAbsolute(path)) {
      return next(new Error('Invalid file path'));
    }
    if (hasControlChars(path)) {
      return next(new Error('Invalid file path'));
    }

    //enforce unix file ending for text data
    //TODO: detect previous line ending and keep it
    if (typeof data === 'string') {
      data = data.replace(/(?:\r\n|\r)/g, '\n')
    }

    var temp_dir = config.backend.git.temp
    //unique per operation: this used to be derived from the folder name alone,
    //so two concurrent writes to one folder shared a working copy and deleted
    //each other's checkout
    var wc_dir = pathlib.join(temp_dir,
      pathlib.basename(this.path) + '-' + crypto.randomBytes(8).toString('hex'))

    fsErrorHandler = function(err){
      if(err) {
        console.log(err);
      }
    };

    //0th step: temp dir (left to the user for now) check if dir exists or create it
    //check if exists: fs.stat, better way to do: try to create and if it fails (dir or file with
    //that name exists), check with stat if it is a directory. if not fail and stop with proper message
    //otherwise: fs.mkdir(temp_dir, 0755, fsErrorHandler);

    var parent = this

    //The steps below the clone operate on the working copy. They used to do
    //that by overwriting parent.path, which is the shared per-folder backend
    //object: for as long as a write was in flight, concurrent reads of the same
    //folder were served out of this temporary checkout, and were liable to fail
    //outright once it was deleted. This delegating object carries a different
    //path without touching the shared one.
    var wc = Object.create(parent)
    wc.path = pathlib.join(wc_dir, '.git')

    function cleanupWorkingCopy() {
      if (fs.existsSync(wc_dir)) {
        var rand = Math.floor(Math.random() * 10) + parseInt(new Date().getTime()).toString(36)
        var path_rand = wc_dir.replace(/\/$/, "") + rand
        try {
          fs.renameSync(wc_dir, path_rand)
          spawn('rm', ['-Rf', path_rand]).on('exit', function(code) {
            if (code === 0)
              console.log("deleted " + path_rand)
            else
              console.log("error while deleting working copy, exit code: " + code)
          });
        } catch(e) {
          console.log("error during cleanup: " + e.message)
        }
      }
    }

    async.series([
      function(callback){
        //for create-only mode, check that the file doesn't already exist
        if (!options.createOnly) {
          return callback(null);
        }
        parent.execGit(['ls-tree', 'HEAD', '--', path, 'ignore_output'], function(error, data) {
          if (error) { return callback(error); }
          if (data && data.trim().length > 0) {
            return callback(new errors.Conflict('File already exists'));
          }
          callback(null);
        });
      },

      function(callback){
        //clone repo to get a working copy
        parent.execGit(['clone', '--shared', '-n', parent.path, wc_dir], function(error, data){
          if (error != null) { return callback(error); }
          callback(null)
        });
      },

      //set username and email for new working copy
      function(callback){
        wc.execGit(['config', 'user.name', req.user.name, 'ignore_output'],
          function(error, data){
            if (error) { return callback(error); }
            callback(null)
        });
      },

      function(callback){
        //TODO: add email field to UserProvider
        wc.execGit(['config', 'user.email', req.user.login+'@'+req.user.deviceName,
          'ignore_output'], function(error, data){
            if (error) { return callback(error); }
            callback(null)
        });
      },

      function(callback){
        //get original path and file (ignore errors when file doesn't exist yet)
        var checkoutArgs = ['--work-tree=' + wc_dir, 'checkout', 'HEAD', '--', path, 'ignore_output',
          'ignore_return_code'];
        wc.execGit(checkoutArgs,
          function(error, data){
            if (error) { return callback(error); }
            callback(null)
        });
      },

      function(callback){
        //ensure parent directory exists (needed for new files in subdirectories)
        var fileDir = pathlib.dirname(pathlib.join(wc_dir, path));
        fs.mkdir(fileDir, { recursive: true }, function(error) {
          if (error) { return callback(error); }
          callback(null);
        });
      },

      function(callback){
        //save data into the file given by path
        fs.writeFile(pathlib.join(wc_dir, path), data, function(error){
          if(error) { return callback(error); }
          callback(null)
        });
      },

      function(callback){
        //add the new file
        wc.execGit(['--work-tree=' + wc_dir, 'add', pathlib.join(wc_dir, path), 'ignore_output'],
          function(error, data){
            if (error) { return callback(error); }
            callback(null)
        });
      },

      function(callback){
        //commit only this new file
        wc.execGit(['--work-tree=' + wc_dir, 'commit', pathlib.join(wc_dir, path), '-m',
          '/ ‘' + path + '’', "ignore_return_code"], function(error, data){
            if (error) { return callback(error); }
            callback(null)
        });
      },

      function(callback){
        //push the commit
        wc.execGit(['--work-tree=' + wc_dir, 'push'],
          function(error, data){
            if (error) { return callback(error); }
            callback(null)
        });
      }
    ], function(error) {
      //always clean up, whether we succeeded or failed
      cleanupWorkingCopy();

      if (error) {
        next(error);
      } else {
        next(null, "Ok.");
      }
    });
  }
};

exports.GitBackend = GitBackend;
