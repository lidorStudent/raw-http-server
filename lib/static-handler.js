'use strict';

// Serves files from a folder. On top of reading and sending, it does the HTTP
// bits browsers expect: blocks path traversal, 304 caching, and Range requests
// (206) for video seeking / resumable downloads. Files are streamed, not buffered.

const fs = require('fs');
const path = require('path');
const { resolveMimeType } = require('./mime-types');

function serveStatic(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const indexFile = options.indexFile || 'index.html';

  return function staticMiddleware(request, response, next) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return next();
    }

    // under a prefix (/assets/*) the wildcard holds the rest; otherwise use the path
    const requested = request.params.wildcard !== undefined
      ? request.params.wildcard
      : request.path;

    // Normalize against '/' first so any "../" collapses, then make sure the
    // result is still inside root. The path.sep check stops "/public-secret"
    // from sneaking past a "/public" root.
    const filePath = path.resolve(root, '.' + path.posix.normalize('/' + requested));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      return response.status(403).text('Forbidden');
    }

    fs.stat(filePath, (err, stats) => {
      if (err) {
        return next(); // not found -> let the app return 404
      }

      if (stats.isDirectory()) {
        const indexPath = path.join(filePath, indexFile);
        return fs.stat(indexPath, (indexErr, indexStats) => {
          if (indexErr || !indexStats.isFile()) return next();
          sendFile(request, response, indexPath, indexStats);
        });
      }

      if (!stats.isFile()) return next();
      sendFile(request, response, filePath, stats);
    });
  };
}

function sendFile(request, response, filePath, stats) {
  const lastModified = stats.mtime.toUTCString();
  // cheap ETag: size + mtime in hex, enough to tell two versions apart
  const etag = `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;

  response.set('Last-Modified', lastModified);
  response.set('ETag', etag);
  response.set('Accept-Ranges', 'bytes');

  // if the browser's cached copy is still current, reply 304 with no body.
  // (Last-Modified is second-precision, so round mtime down before comparing.)
  const ifNoneMatch = request.header('if-none-match');
  const ifModifiedSince = request.header('if-modified-since');
  const etagMatches = ifNoneMatch === etag;
  const notModified = ifModifiedSince !== undefined
    && Date.parse(ifModifiedSince) >= Math.floor(stats.mtimeMs / 1000) * 1000;

  if (etagMatches || notModified) {
    return response.status(304).end();
  }

  const mimeType = resolveMimeType(filePath);

  const rangeHeader = request.header('range');
  if (rangeHeader) {
    const range = parseRange(rangeHeader, stats.size);
    if (range === null) {
      return response
        .status(416)
        .set('Content-Range', `bytes */${stats.size}`)
        .text('Range not satisfiable');
    }

    const { start, end } = range;
    response
      .status(206)
      .set('Content-Type', mimeType)
      .set('Content-Range', `bytes ${start}-${end}/${stats.size}`)
      .set('Content-Length', end - start + 1);
    response.writeHead(null);

    if (request.method === 'HEAD') return response.end();
    return response.stream(fs.createReadStream(filePath, { start, end }));
  }

  response.set('Content-Type', mimeType).set('Content-Length', stats.size);
  response.writeHead(null);

  if (request.method === 'HEAD') return response.end();
  response.stream(fs.createReadStream(filePath));
}

// Parse a single-range "Range: bytes=start-end" header (the common case, not
// multi-range). Handles "200-999", "200-" (to the end), and "-500" (last 500
// bytes). Returns { start, end } or null if it doesn't make sense.
function parseRange(rangeHeader, fileSize) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (match === null) return null;

  const startToken = match[1];
  const endToken = match[2];

  let start;
  let end;

  if (startToken === '' && endToken === '') {
    return null;
  } else if (startToken === '') {
    start = Math.max(fileSize - Number.parseInt(endToken, 10), 0);
    end = fileSize - 1;
  } else {
    start = Number.parseInt(startToken, 10);
    end = endToken === '' ? fileSize - 1 : Number.parseInt(endToken, 10);
  }

  end = Math.min(end, fileSize - 1);
  if (start > end || start < 0 || start >= fileSize) {
    return null;
  }

  return { start, end };
}

module.exports = { serveStatic };
