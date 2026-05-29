'use strict';

// Sprig - a small HTTP/1.1 framework on top of the raw net module. See the README
// for usage.

const { Application } = require('./lib/application');
const { serveStatic } = require('./lib/static-handler');

function sprig() {
  return new Application();
}

// expose the static middleware too, in case you'd rather mount it with app.use()
sprig.static = serveStatic;
sprig.Application = Application;

module.exports = sprig;
