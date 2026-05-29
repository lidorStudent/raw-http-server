'use strict';

// Builds the bytes we send back. A response is just a status line, headers, a
// blank line, then the body:
//
//   HTTP/1.1 200 OK\r\n
//   Content-Type: text/html\r\n
//   Content-Length: 12\r\n
//   \r\n
//   Hello world!
//
// json(), html(), send() etc. are shortcuts over writeHead() + end()/stream().

const fs = require('fs');
const { resolveMimeType } = require('./mime-types');

const STATUS_TEXT = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Payload Too Large',
  416: 'Range Not Satisfiable',
  500: 'Internal Server Error',
  501: 'Not Implemented'
};

class OutgoingResponse {
  // keepAlive: keep the connection open after this response?
  // onComplete: called once the response is fully sent, so the next request on
  //             this connection can run.
  constructor(socket, { keepAlive, onComplete }) {
    this.socket = socket;
    this.keepAlive = keepAlive;
    this.onComplete = onComplete;

    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
    this.finished = false;
  }

  // status/set/type return `this` so you can chain, e.g. res.status(201).json(...)
  status(code) {
    this.statusCode = code;
    return this;
  }

  set(name, value) {
    this.headers[name] = value;
    return this;
  }

  type(mimeType) {
    this.headers['Content-Type'] = mimeType;
    return this;
  }

  // Pass a body buffer to set Content-Length from it, or null when streaming
  // (you've set the length yourself).
  writeHead(bodyForLength) {
    if (this.headersSent) {
      throw new Error('Headers already sent');
    }

    const reason = STATUS_TEXT[this.statusCode] || 'Unknown';
    const lines = [`HTTP/1.1 ${this.statusCode} ${reason}`];

    // standard headers, unless the handler already set them
    this.#defaultHeader('Date', new Date().toUTCString());
    this.#defaultHeader('Server', 'Sprig');
    this.#defaultHeader('Connection', this.keepAlive ? 'keep-alive' : 'close');

    if (bodyForLength !== null && bodyForLength !== undefined) {
      this.headers['Content-Length'] = Buffer.byteLength(bodyForLength);
    }

    for (const [name, value] of Object.entries(this.headers)) {
      lines.push(`${name}: ${value}`);
    }

    this.socket.write(lines.join('\r\n') + '\r\n\r\n');
    this.headersSent = true;
  }

  end(body) {
    if (this.finished) return;

    const buffer = body === undefined
      ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(String(body));

    if (!this.headersSent) {
      this.writeHead(buffer);
    }

    // 204 and 304 must not carry a body
    if (buffer && this.statusCode !== 204 && this.statusCode !== 304) {
      this.socket.write(buffer);
    }

    this.#done();
  }

  // stream a readable (e.g. a file) as the body instead of buffering it all in
  // memory. headers must be written first.
  stream(readable) {
    if (this.finished) return;
    if (!this.headersSent) {
      throw new Error('Call writeHead() before stream()');
    }

    // end: false so piping doesn't close a keep-alive socket; we close it
    // ourselves when the stream ends
    readable.pipe(this.socket, { end: false });

    readable.on('end', () => this.#done());
    readable.on('error', () => {
      // headers (with a Content-Length) already went out, so the response is
      // half-broken now. dropping the connection is the only honest option.
      this.socket.destroy();
      this.finished = true;
      this.onComplete();
    });
  }

  json(value) {
    this.#defaultHeader('Content-Type', 'application/json; charset=utf-8');
    this.end(JSON.stringify(value));
  }

  text(value) {
    this.#defaultHeader('Content-Type', 'text/plain; charset=utf-8');
    this.end(value);
  }

  html(markup) {
    this.#defaultHeader('Content-Type', 'text/html; charset=utf-8');
    this.end(markup);
  }

  // guess a type from the value: object -> json, otherwise send as text
  send(value) {
    if (value === null || value === undefined) {
      this.end();
    } else if (Buffer.isBuffer(value)) {
      this.#defaultHeader('Content-Type', 'application/octet-stream');
      this.end(value);
    } else if (typeof value === 'object') {
      this.json(value);
    } else {
      this.#defaultHeader('Content-Type', 'text/html; charset=utf-8');
      this.end(String(value));
    }
  }

  redirect(location, code = 302) {
    this.statusCode = code;
    this.set('Location', location);
    this.end();
  }

  // Send a file by path: figures out its size and content type, then streams it.
  // (static-handler.js has the fancier version with range + caching support.)
  sendFile(filePath) {
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        if (!this.headersSent) this.status(404).json({ error: 'File not found' });
        return;
      }
      this.set('Content-Type', resolveMimeType(filePath));
      this.headers['Content-Length'] = stats.size;
      this.writeHead(null);
      this.stream(fs.createReadStream(filePath));
    });
  }

  #defaultHeader(name, value) {
    if (this.headers[name] === undefined) {
      this.headers[name] = value;
    }
  }

  #done() {
    if (this.finished) return;
    this.finished = true;

    if (!this.keepAlive) {
      this.socket.end();
    }
    this.onComplete();
  }
}

module.exports = { OutgoingResponse, STATUS_TEXT };
