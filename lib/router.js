'use strict';

// Holds all the routes and middleware and matches them against a request, in the
// order they were added (like Express). ":name" matches one path segment, "*"
// matches the rest; each pattern is turned into a regex when it's registered.

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

class Router {
  constructor() {
    this.layers = [];
  }

  register(method, pattern, handler) {
    const { regex, paramNames } = compilePattern(pattern, false);
    this.layers.push({
      method: method.toUpperCase(),
      regex,
      paramNames,
      handler,
      isMiddleware: false
    });
  }

  // no path -> runs for everything; a path -> runs under that prefix
  use(pathOrHandler, maybeHandler) {
    const mountPath = typeof pathOrHandler === 'string' ? pathOrHandler : '/';
    const handler = typeof pathOrHandler === 'string' ? maybeHandler : pathOrHandler;

    const { regex, paramNames } = compilePattern(mountPath, true);
    this.layers.push({
      method: null, // any method
      regex,
      paramNames,
      handler,
      isMiddleware: true
    });
  }

  // every matching layer, in order, each with the params from its own pattern
  resolve(method, pathname) {
    const matched = [];

    for (const layer of this.layers) {
      // a GET route also answers HEAD (the app drops the body later)
      const methodOk = layer.method === null
        || layer.method === method
        || (layer.method === 'GET' && method === 'HEAD');
      if (!methodOk) continue;

      const groups = layer.regex.exec(pathname);
      if (groups === null) continue;

      const params = {};
      layer.paramNames.forEach((name, i) => {
        params[name] = groups[i + 1] === undefined ? '' : safeDecode(groups[i + 1]);
      });

      matched.push({ handler: layer.handler, params, isMiddleware: layer.isMiddleware });
    }

    return matched;
  }

  // which methods exist for a path, so the app can return 405 instead of 404
  methodsFor(pathname) {
    const allowed = new Set();
    for (const layer of this.layers) {
      if (layer.isMiddleware || layer.method === null) continue;
      if (layer.regex.test(pathname)) {
        allowed.add(layer.method);
        if (layer.method === 'GET') allowed.add('HEAD');
      }
    }
    return [...allowed];
  }
}

// Turn a pattern like "/users/:id" into a regex plus the names it captures. We
// scan left to right so ":name" and "*" become capture groups while the literal
// text between them is regex-escaped (so a "." in the path isn't treated as a
// wildcard).
function compilePattern(pattern, prefixMatch) {
  const paramNames = [];
  const token = /:([A-Za-z_][A-Za-z0-9_]*)|(\*)/g;

  let source = '';
  let cursor = 0;
  let match;

  while ((match = token.exec(pattern)) !== null) {
    source += escapeLiteral(pattern.slice(cursor, match.index));
    if (match[1] !== undefined) {
      paramNames.push(match[1]);
      source += '([^/]+)';
    } else {
      paramNames.push('wildcard');
      source += '(.*)';
    }
    cursor = token.lastIndex;
  }
  source += escapeLiteral(pattern.slice(cursor));

  // drop a trailing slash on a mount path, otherwise "/" would only match "/"
  if (prefixMatch) {
    source = source.replace(/\/$/, '');
  }

  // a prefix also matches anything under it; a route must match exactly
  const full = prefixMatch ? `^${source}(?:/.*)?$` : `^${source}$`;
  return { regex: new RegExp(full), paramNames };
}

function escapeLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

module.exports = { Router, HTTP_METHODS };
