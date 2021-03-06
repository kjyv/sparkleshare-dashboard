The following steps are needed to get the Dashboard running:

- Install `git` from your favourite distro
- Install `redis`, the nosql database, from http://redis.io or your favourite distro
- Install `nodejs` from http://nodejs.org or your favourite distro
- Install `npm`, the node package manager, as root via `curl https://npmjs.org/install.sh | sh`
- Install the dependencies `npm install` (this will look into package.json)
- Start a redis instance
- Copy `example-config.js` to `config.js` and add the git repositories you want to serve publicly and / or privately.
  Also add a temporary directoy if you want to be able to edit files. Make sure this directory is
  chown'ed to storage:storage (i.e. the user that was created by dazzle that owns your git repositories).
- As user storage, start the Dashboard with `/path/to/node /path/to/dashboard/app.js`; or to run
  node in production mode, prepend `NODE_ENV=production ` to that command.
- It is recommended to use the post-update git hook from
  https://github.com/hbons/sparkleshare-git-hook/ so clients are immediately notified when a file was
  changed from dashboard.
