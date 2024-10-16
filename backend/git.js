/* vim: set tabstop=2 shiftwidth=2 expandtab: */

var config = require('../config');

GitBackend = function (path) {
  this.path = path;
};

var spawn = require('child_process').spawn;
var querystring = require('querystring');
var mime = require('mime');
var fs = require('fs');
var pathlib = require('path');
var async = require('async');
var exec = require('child_process').exec;

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
        mimeType = mime.getType(x[4]);
        if(mimeType === null) {
          mimeType = "text/plain"
        }
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
          var changeType = entryLine.charAt(35);
          if (changeType == ".") {
            //newer git versions
            changeType = entryLine.charAt(39);
          }
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
    var ignore_output
    var ign_idx = params.indexOf("ignore_output")
    if (ign_idx != -1) {
      ignore_output = true
      params.splice(ign_idx, 1)
    } else {
      ignore_output = false
    }

    var ignore_return_code
    ign_idx = params.indexOf("ignore_return_code")
    if (ign_idx != -1) {
      ignore_return_code = true
      params.splice(ign_idx, 1)
    } else {
      ignore_return_code = false
    }

    //add path parameter, needed for older git versions
    params.unshift('--git-dir='+this.path);

    //console.log('git exec: git ' + params);

    //call git with all the given parameters
    var g = spawn(config.backend.git.bin, params, { encoding: 'binary', env: {
      GIT_DIR: this.path
    }});

    // under some very weird circumstances the 'exit'
    // event may arise _before_ the 'data' event is triggered
    // and in this case the ondata callback is called with
    // an empty output. with this little trick we're synching
    // the results of both callbacks and only return back if
    // both have been called. this - of course - might go
    // totally wrong if some exec call does not write anything
    // to stdout and therefor never triggers the 'data' event ...
    var finalize = function() {
    //handle data and exit events and call handler function that was passed
      if (exitCode && !ignore_return_code) {
        return next(new Error('GIT failed'));
      } else {
        return next(null, out);
      }
    };

    var exitCode, out;
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
         if (typeof(exitCode) != "undefined") {
            finalize();
         }
      });
    }

    g.stderr.on('data', function(data) {
       //console.log('git stderr: ' + data);
       //in case there is stderr output, also allow finalizing on exit for calls that
       //don't return data (not a proper solution really)
       if (typeof(out) == 'undefined') {
          out = "git: " + data;
       }
       if (typeof(exitCode) != "undefined") {
            finalize();
       }
    });

    g.on('exit', function(code) {
      exitCode = code;
      //console.log("git exit code: " + code);
      if(typeof(out) != "undefined" || ignore_output)
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

    var mybackend = this;
    function getItemsFromHere(baseHash, path, next) {
      var execPath = path;
      if (!baseHash) {
        baseHash = 'HEAD';
      }

      mybackend.execGit(['ls-tree', '-z', '-l', baseHash, '.'], function(error, data) {
        if (error) { return next(error); }
        parseList(data, path, next);
      });
    }

    if (!baseHash && path) {
      this.execGit(['ls-tree', '-z', '-l', 'HEAD', path], function(error, data) {
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

  //overwrite an existing file
  putFile: function(req, data, next) {
    var path = req.query.path;
    if (!path) {
      next(new Error('No file path given'));
    }

    //enforce unix file ending
    //TODO: detect previous line ending and keep it
    data = data.replace(/(?:\r\n|\r)/g, '\n')

    var temp_dir = config.backend.git.temp
    var wc_dir = pathlib.join(temp_dir, pathlib.basename(this.path))

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

    async.series([
      function(callback){
        //clone repo to get a working copy (files are hard linked)
        //sparse checkout of only that directory is maybe also worth looking into (this will copy files however)
        //http://stackoverflow.com/questions/600079/is-there-any-way-to-clone-a-git-repositorys-sub-directory-only
        parent.execGit(['clone', '-n', parent.path, wc_dir], function(error, data){
          if (error != null) { return next(error); }
          callback(null)
        });
      },

      function(callback){
        //change current directory to new working copy
        parent.old_this_path = parent.path
        parent.path = pathlib.join(wc_dir, '.git')
        callback(null)
      },

      //set username and email for new working copy
      function(callback){
        //console.log("Set user.name")
        parent.execGit(['config', 'user.name', req.user.name, 'ignore_output'],
          function(error, data){
            if (error) { return next(error); }
            callback(null)
        });
      },

      function(callback){
        //TODO: add email field to UserProvider
        //console.log("Set user.email")
        parent.execGit(['config', 'user.email', req.user.login+'@'+req.user.deviceName,
          'ignore_output'], function(error, data){
            if (error) { return next(error); }
            callback(null)
        });
      },

      function(callback){
        //get original path and file
        //console.log("Checkout file")
        parent.execGit(['--work-tree=' + wc_dir, 'checkout', 'HEAD', '--', path, 'ignore_output'],
          function(error, data){
            if (error) { return next(error); }
            callback(null)
        });
      },

      function(callback){
        //save data into the file given by path
        //fs.mkdir(pathlib.basename(path), 0777, true, function(){ ... })
        fs.writeFile(pathlib.join(wc_dir, path), data, function(error){
          if(error) { return next(error); }
          callback(null)
        });
      },

      function(callback){
        //add the new file
        //console.log("Add new file")
        parent.execGit(['--work-tree=' + wc_dir, 'add', pathlib.join(wc_dir, path), 'ignore_output'],
          function(error, data){
            if (error) { return next(error); }
            callback(null)
        });
      },

      function(callback){
        //commit only this new file
        //console.log("Commit new file")
        parent.execGit(['--work-tree=' + wc_dir, 'commit', pathlib.join(wc_dir, path), '-m',
          '/ ‘' + path + '‘', "ignore_return_code"], function(error, data){
            if (error) { return next(error); }
            callback(null)
        });
      },

      function(callback){
        //push the commit
        //console.log("Push commit")
        parent.execGit(['--work-tree=' + wc_dir, 'push'],
          function(error, data){
            if (error) { return next(error); }
            callback(null)
        });
      },
      function(callback){
        //delete working copy again

        //console.log("Delete working copy")
        deleteFolderRecursive = function(path) {
          var files = [];
          if( fs.existsSync(path) ) {
            //rename to random directory name to get out of the way for new checkouts
            var rand = Math.floor(Math.random() * 10) + parseInt(new Date().getTime()).toString(36)
            var path_rand = path.replace(/\/$/, "")+rand
            fs.renameSync(path, path_rand)

            //async delete using rm
            var cmd = "rm -Rf " + path_rand
            exec(cmd, function(error, stdout, stderr) {
              // command output is in stdout
              if (!error)
                console.log("deleted " + path_rand)
              else
                console.log("error while deleting working copy: " + error)
            });

            /*
            files = fs.readdirSync(path);
            files.forEach(function(file,index){
                var curPath = pathlib.join(path, file);
                if(fs.lstatSync(curPath).isDirectory()) { // recurse
                    deleteFolderRecursive(curPath);
                } else { // delete file
                    fs.unlinkSync(curPath);
                }
            });
            fs.rmdirSync(path);
            */
          }
        };
        deleteFolderRecursive(wc_dir);

        callback(null)
      },
      function(callback){
        //console.log("finished editing file")
        parent.path = parent.old_this_path
        callback(null)
        next(null, "Ok.")
      }
    ]);
  }
};

exports.GitBackend = GitBackend;
