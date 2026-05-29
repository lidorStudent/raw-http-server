'use strict';

// Turns the raw byte stream into HTTP requests. The tricky bit: TCP is a stream
// of bytes, not messages, so a 'data' event can hold part of a request or several
// at once. We buffer what arrives, wait for the headers and then the
// Content-Length body, and keep any leftover for the next request. Bytes stay a
// Buffer until we know they're text (joining chunks as strings can mangle UTF-8).

const HEADER_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_SIZE = 64 * 1024; // don't let a client send endless headers

class MessageParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.pendingHeaders = null; // set once headers are parsed, while we wait for the body
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  // Returns one request, or null if we need more bytes. Call it in a loop to
  // drain pipelined requests.
  next() {
    if (this.pendingHeaders === null) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd === -1) {
        if (this.buffer.length > MAX_HEADER_SIZE) {
          throw new RequestParseError('Headers are too large');
        }
        return null;
      }

      // headers are ASCII, so a string view is safe here
      const headerText = this.buffer.slice(0, headerEnd).toString('latin1');
      const parsed = this.#parseHeaders(headerText);
      parsed.bodyStart = headerEnd + HEADER_END.length;
      this.pendingHeaders = parsed;
    }

    const { bodyStart, contentLength } = this.pendingHeaders;
    const bodyEnd = bodyStart + contentLength;
    if (this.buffer.length < bodyEnd) {
      return null;
    }

    const body = this.buffer.slice(bodyStart, bodyEnd);
    this.buffer = this.buffer.slice(bodyEnd); // keep leftover bytes for the next request

    const request = {
      method: this.pendingHeaders.method,
      target: this.pendingHeaders.target,
      httpVersion: this.pendingHeaders.httpVersion,
      headers: this.pendingHeaders.headers,
      rawBody: body
    };

    this.pendingHeaders = null;
    return request;
  }

  #parseHeaders(headerText) {
    // accept a bare \n too, so hand-typed requests (telnet, tests) still work
    const lines = headerText.split(/\r\n|\n/);

    // first line: METHOD  target  HTTP/x.y
    const requestLine = lines[0].split(' ');
    if (requestLine.length !== 3) {
      throw new RequestParseError(`Bad request line: "${lines[0]}"`);
    }

    const [method, target, httpVersion] = requestLine;
    if (!/^HTTP\/\d\.\d$/.test(httpVersion)) {
      throw new RequestParseError(`Bad HTTP version: "${httpVersion}"`);
    }

    // remaining lines are "Name: value". lowercase the name for easy lookups,
    // and join a repeated header with a comma (per the spec).
    const headers = Object.create(null);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === '') continue;

      const colon = line.indexOf(':');
      if (colon <= 0) {
        throw new RequestParseError(`Bad header line: "${line}"`);
      }

      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
    }

    let contentLength = 0;
    if (headers['content-length'] !== undefined) {
      const length = Number.parseInt(headers['content-length'], 10);
      if (Number.isNaN(length) || length < 0) {
        throw new RequestParseError(`Bad Content-Length: "${headers['content-length']}"`);
      }
      contentLength = length;
    }

    return { method, target, httpVersion, headers, contentLength };
  }
}

// lets the app tell a client mistake (400) from a bug on our side (500)
class RequestParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestParseError';
  }
}

module.exports = { MessageParser, RequestParseError };
