//   fanout.js
//
//   A fanout messaging server for node.js
//   by @jazzychad - Chad Etzel
//
//   + some modifications to be the default
//     messaging system for SparkleShare
//
//   MIT Licensed - see LICENSE
//
//   Vendored into this repository: upstream
//   (github.com/nextsux/fanout.node.js) has had no commit since 2011 and no
//   longer runs on a supported node version.

// Usage: subscribe <channel>
//        unsubscribe <channel>
//        announce <channel> <message>
//        ping
//
// NOTE: the protocol has no authentication - any client that can reach the
// port may subscribe to any channel and announce on any channel. Bind it to an
// interface only trusted clients can reach (see config.fanout.host).

var tcp = require("net");
var EventEmitter = require("events").EventEmitter;

// a single client may not tie up more than this many emitter listeners
var MAX_CHANNELS_PER_CLIENT = 64;

// longest line accepted before the peer is assumed to be misbehaving
var MAX_LINE_BYTES = 8192;

function Client(connection, me) {
  this.socket = connection;
  this.channels = [];
  // a null-prototype object, not an array: channel names come from the
  // network, and names like "length" or "constructor" would otherwise collide
  // with Array/Object members (assigning to .length throws outright)
  this.listeners = Object.create(null);
  this.msgEmitter = me;
  this.buffer = "";
}

// adds channel. must use "subscribe" to take effect
Client.prototype.addChannel = function(channel) {
  if (!channel) {
    return;
  }
  this.removeChannel(channel);
  if (this.channels.length >= MAX_CHANNELS_PER_CLIENT) {
    return;
  }
  this.channels.push(channel);
  this.subscribe();
};

// removes channel. also removes associated listener immediately
Client.prototype.removeChannel = function(channel) {
  // remove channel if it exists; backwards so splicing cannot skip an entry
  for (var i = this.channels.length - 1; i >= 0; i--) {
    if (channel == this.channels[i]) {
      this.channels.splice(i, 1);
    }
  }

  // remove listener
  var listener = this.listeners[channel];
  if (listener) {
    this.msgEmitter.removeListener(channel, listener);
  }

  this.subscribe();
};

Client.prototype.subscribe = function() {
  var client = this;
  this.channels.forEach(function(channel) {
    var listener = client.listeners[channel];

    if (listener) {
      client.msgEmitter.removeListener(channel, listener);
    }
  });

  this.listeners = Object.create(null);

  this.channels.forEach(function(channel) {
    var listener = function(c, msg) {
      client.socket.write(c + "!" + msg + "\n");
    };

    client.listeners[channel] = listener;
    client.msgEmitter.addListener(channel, listener);
  });
};

Client.prototype.deconstruct = function() {
  var client = this;
  this.channels.forEach(function(channel) {
    var listener = client.listeners[channel];
    if (listener) {
      client.msgEmitter.removeListener(channel, listener);
    }
  });
  this.channels = [];
  this.listeners = Object.create(null);
};

function Fanout() {
  this.connections = [];
  this.msgEmitter = new EventEmitter();
  // one listener per subscribed channel per client, so the default warning
  // threshold of 10 is meaningless here
  this.msgEmitter.setMaxListeners(0);
}

Fanout.prototype.removeConnection = function(connection) {
  for (var i = this.connections.length - 1; i >= 0; i--) {
    if (connection == this.connections[i]) {
      this.connections.splice(i, 1);
    }
  }
};

Fanout.prototype.handleMessage = function(connection, socket, data) {
  if (data == "ping") {
    socket.write(Date.now() + "\n");

  } else if (data.indexOf("subscribe ") === 0) {
    connection.addChannel(data.split(' ')[1]);

  } else if (data.indexOf("unsubscribe ") === 0) {
    connection.removeChannel(data.split(' ')[1]);

  } else if (data.indexOf("announce ") === 0) {
    data = data.substring(9);
    var pos = data.indexOf(' ');
    if (pos <= 0) {
      return;
    }
    var channel = data.slice(0, pos);
    var msg = data.slice(pos + 1);
    this.msgEmitter.emit(channel, channel, msg);
  }
};


Fanout.prototype.listen = function(port, host, next) {
  var fa = this;
  var server = tcp.createServer(function(socket) {
    var connection = new Client(socket, fa.msgEmitter);
    fa.connections.push(connection);

    socket.setNoDelay();
    socket.setEncoding("utf8");

    connection.addChannel("all");

    function cleanUp() {
      if (!connection) {
        return;
      }
      connection.deconstruct();
      fa.removeConnection(connection);
      connection = null;
    }

    socket.addListener("data", function(data) {
      // buffer until a newline: a message split across packets used to be
      // mangled, and the trailing fragment was dropped rather than kept
      connection.buffer += data;

      if (connection.buffer.length > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }

      var lines = connection.buffer.split(/\r\n|\r|\n/);
      connection.buffer = lines.pop();

      lines.forEach(function(line) {
        if (line.length) {
          fa.handleMessage(connection, socket, line);
        }
      });
    });

    socket.addListener("end", cleanUp);
    socket.addListener("close", cleanUp);

    // without this a peer that resets the connection raises an unhandled
    // 'error' event, which is fatal for the whole dashboard process
    socket.addListener("error", function() {
      cleanUp();
    });
  });

  server.addListener("error", function(error) {
    console.error("fanout server error: " + (error && error.message ? error.message : error));
  });

  server.listen(port, host, next);
};

module.exports.listen = function(port, host, next) {
  var fa = new Fanout();
  fa.listen(port, host, next);
};
