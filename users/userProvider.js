var Dashboard = require('./local').LocalUserProvider
var UserApp = require('./userapp').UAUserProvider

UserProvider = function (options) {
  this.type = options.type

  if (this.type === 'local') {
    this.userProvider = new Dashboard(options)
  }

  if (this.type === 'userapp') {
    this.userProvider = new UserApp(options)
  }

  this.strategy = this.userProvider.strategy
}

UserProvider.prototype = {
  createNew: function (login, name, password, admin, acl, next) {
    this.userProvider.createNew(login, name, password, admin, acl, next)
  },
  updateUser: function (user, next) {
    this.userProvider.updateUser(user, next)
  },
  deleteUser: function (uid, next) {
    this.userProvider.deleteUser(uid, next)
  },
  findByUid: function (uid, next) {
    this.userProvider.findByUid(uid, next)
  },
  findByLogin: function (login, next) {
    this.userProvider.findByLogin(login, next)
  },
  getUserCount: function (next) {
    this.userProvider.getUserCount(next)
  },
  findAll: function (next) {
    this.userProvider.findAll(next)
  },
  serializeUser: function (user, next) {
    this.userProvider.serializeUser(user, next)
  },
  deserializeUser: function (user, next) {
    this.userProvider.deserializeUser(user, next)
  }
}

exports.UserProvider = UserProvider;