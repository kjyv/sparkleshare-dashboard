The following steps are needed to get the Dashboard running:

- Install `git` from your favourite distro
- Install `redis`, the nosql database, from http://redis.io or your favourite distro
- Install `nodejs` (version 22 or newer) from http://nodejs.org or your favourite distro.
  `npm` ships with it, so it does not need installing separately.
- Install the dependencies with `npm ci` (or `npm install`; both read package.json)
- Start a redis instance
- Copy `example-config.js` to `config.js` and add the git repositories you want to serve publicly and / or privately.
  Also add a temporary directoy if you want to be able to edit files. Make sure this directory is
  chown'ed to storage:storage (i.e. the user that was created by dazzle that owns your git repositories).
- **Set `sessionSecret` to a long random value.** It signs the cookie behind every
  login, so anyone who knows it can forge a session for any user, including an
  admin. The value in `example-config.js` is published in this repository and is
  no better than having no login at all. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`.
  The Dashboard warns at startup if this is missing, too short, or still the
  example value.
- As user storage, start the Dashboard with `/path/to/node /path/to/dashboard/app.js`; or to run
  node in production mode, prepend `NODE_ENV=production ` to that command.
- **Create the first account before the Dashboard is reachable from anywhere you
  do not trust.** While no user exists, `/createFirstUser` is open by design —
  it has to be, since there is nobody to authenticate against yet — so whoever
  loads it first becomes the admin. On a fresh instance, either complete that
  step over localhost or an SSH tunnel, or keep the port firewalled until it is
  done. There is no second chance: once an account exists the page redirects
  away, so an attacker who got there first simply owns the instance.
- It is recommended to use the post-update git hook from
  https://github.com/hbons/sparkleshare-git-hook/ so clients are immediately notified when a file was
  changed from dashboard.

Optional configuration worth knowing about:

- `redis` — connection options passed to node-redis, for a redis that is not on
  `localhost:6379` or needs a password, e.g.
  `exports.redis = { url: 'redis://:password@redis.internal:6379/0' };`
- `trustProxy` — set this when running behind a reverse proxy so
  `X-Forwarded-For` and `X-Forwarded-Proto` are honoured. Without it the
  Dashboard sees every request as coming from the proxy, which puts all clients
  in one rate-limit bucket and stops the session cookie being marked `Secure`
  for TLS terminated at the proxy. Leave it `false` when the Dashboard is
  reached directly, or any client can spoof those headers.
- `https` — serving TLS directly. Either this or a terminating proxy is
  strongly recommended: the login form and the device API tokens otherwise
  cross the network in the clear.
- `fanout` — push notifications about changes, over a plain TCP pub/sub
  protocol with **no authentication**: anything that can reach the port may
  read and forge notifications on any channel. Keep `host` bound to an
  interface only trusted clients can reach; it defaults to `127.0.0.1`.
