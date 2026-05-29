'use strict';

// The server itself: owns the net server, gives each connection a parser, and
// runs every request through the middleware/route chain.

const net = require('net');

const { MessageParser, RequestParseError } = require('./message-parser');
const { IncomingRequest } = require('./incoming-request');
const { OutgoingResponse } = require('./outgoing-response');
const { Router, HTTP_METHODS } = require('./router');
const { serveStatic } = require('./static-handler');

const IDLE_TIMEOUT_MS = 30_000;

class Application {
  constructor() {
    this.router = new Router();
    this.server = null;
    this.errorHandler = defaultErrorHandler;

    // build app.get, app.post, app.delete, ... one per method
    for (const method of HTTP_METHODS) {
      this[method.toLowerCase()] = (pattern, handler) => {
        this.router.register(method, pattern, handler);
        return this;
      };
    }
  }

  use(pathOrHandler, maybeHandler) {
    this.router.use(pathOrHandler, maybeHandler);
    return this;
  }

  //   app.static('public')            -> serve at the root
  //   app.static('/assets', 'public') -> serve under /assets
  static(virtualPathOrDir, maybeDir, options) {
    if (maybeDir === undefined) {
      this.router.use('/', serveStatic(virtualPathOrDir));
    } else {
      this.router.use(`${virtualPathOrDir}/*`, serveStatic(maybeDir, options));
    }
    return this;
  }

  onError(handler) {
    this.errorHandler = handler;
    return this;
  }

  listen(port, callback) {
    this.server = net.createServer((socket) => this.#handleConnection(socket));
    // e.g. port already in use; log instead of crashing
    this.server.on('error', (err) => console.error(`[sprig] server error: ${err.message}`));
    this.server.listen(port, callback);
    return this.server;
  }

  close(callback) {
    if (this.server) this.server.close(callback);
  }

  #handleConnection(socket) {
    const parser = new MessageParser();
    socket.setTimeout(IDLE_TIMEOUT_MS);

    // one request at a time: HTTP/1.1 responses must come back in request order,
    // so we don't start the next one until the current response is fully sent
    const queue = [];
    let busy = false;

    const drain = async () => {
      if (busy) return;
      busy = true;
      while (queue.length > 0) {
        await this.#serve(socket, queue.shift());
      }
      busy = false;
    };

    socket.on('data', (chunk) => {
      parser.push(chunk);

      try {
        let request;
        while ((request = parser.next()) !== null) {
          queue.push(request);
        }
      } catch (err) {
        // the stream is broken now and we can't tell where the next request
        // would start, so reply once and close
        const status = err instanceof RequestParseError
          ? [400, 'Bad Request', err.message]
          : [500, 'Internal Server Error', 'Parser failure'];
        writeRawError(socket, ...status);
        socket.destroy();
        return;
      }

      drain();
    });

    socket.on('timeout', () => socket.end());
    socket.on('end', () => socket.end());
    socket.on('error', () => socket.destroy()); // without this, a reset crashes us
  }

  // handle one request; resolves when the response is fully sent so the queue
  // can move on
  #serve(socket, parsed) {
    return new Promise((resolve) => {
      const request = new IncomingRequest(parsed, socket);

      // HTTP/1.1 is keep-alive unless told "close"; HTTP/1.0 is the opposite
      const connection = (request.header('connection') || '').toLowerCase();
      const keepAlive = request.httpVersion === 'HTTP/1.1'
        ? connection !== 'close'
        : connection === 'keep-alive';

      const response = new OutgoingResponse(socket, { keepAlive, onComplete: resolve });

      this.#dispatch(request, response).catch((err) => {
        // even the error handler threw; do something so the queue doesn't hang
        if (!response.finished) {
          try {
            this.errorHandler(err, request, response);
          } catch {
            if (!response.headersSent) response.status(500).text('Internal Server Error');
            else socket.destroy();
          }
        }
        if (!response.finished) resolve();
      });
    });
  }

  // walk the matching layers in order, passing next() along, like Express. the
  // first one to respond ends the chain; if none do, return 404 (or 405).
  async #dispatch(request, response) {
    const layers = this.router.resolve(request.method, request.path);
    let i = 0;

    const next = async (err) => {
      if (err) return this.errorHandler(err, request, response);
      if (response.finished) return;

      const layer = layers[i++];
      if (layer === undefined) {
        return this.#notHandled(request, response);
      }

      request.params = layer.params;

      // a throw (sync or async) goes to next() so it reaches the error handler
      try {
        await layer.handler(request, response, next);
      } catch (handlerErr) {
        await next(handlerErr);
      }
    };

    await next();
  }

  #notHandled(request, response) {
    const allowed = this.router.methodsFor(request.path);
    if (allowed.length > 0) {
      return response
        .status(405)
        .set('Allow', allowed.join(', '))
        .json({ error: 'Method Not Allowed', allow: allowed });
    }
    return response.status(404).json({ error: 'Not Found', path: request.path });
  }
}

function defaultErrorHandler(error, request, response) {
  console.error(`[sprig] error on ${request.method} ${request.path}:`, error);
  if (!response.headersSent) {
    response.status(500).json({ error: 'Internal Server Error' });
  } else {
    response.socket.destroy();
  }
}

// minimal response straight to the socket, for failures before we have a proper
// request/response pair (like a parse error)
function writeRawError(socket, statusCode, reason, body) {
  const payload = Buffer.from(body, 'utf8');
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${payload.length}\r\n` +
    'Connection: close\r\n\r\n'
  );
  socket.write(payload);
}

module.exports = { Application };
