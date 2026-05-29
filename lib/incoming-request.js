'use strict';

// Wraps a parsed request so handlers get a clean path, the query as an object,
// route params, and a body that's already decoded based on its content type.

class IncomingRequest {
  constructor(parsed, socket) {
    this.method = parsed.method.toUpperCase();
    this.httpVersion = parsed.httpVersion;
    this.headers = parsed.headers;
    this.socket = socket;

    // split the target into path and query on the first '?' only
    const q = parsed.target.indexOf('?');
    if (q === -1) {
      this.path = safeDecode(parsed.target);
      this.query = {};
      this.queryString = '';
    } else {
      this.path = safeDecode(parsed.target.slice(0, q));
      this.queryString = parsed.target.slice(q + 1);
      this.query = parseQuery(this.queryString);
    }

    this.params = {}; // filled in by the router when a route like /users/:id matches

    this.raw = parsed.rawBody;
    this.body = parseBody(parsed.rawBody, this.headers['content-type']);
  }

  header(name) {
    return this.headers[name.toLowerCase()];
  }
}

// decodeURIComponent throws on a bad string (e.g. a lone '%'); fall back to the
// original instead of crashing the request.
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// "page=2&tag=a&tag=b" -> { page: '2', tag: ['a', 'b'] }. a repeated key
// collapses into an array.
function parseQuery(queryString) {
  const result = {};
  if (queryString === '') return result;

  for (const pair of queryString.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);

    // '+' is an old encoding for a space
    const key = safeDecode(rawKey.replace(/\+/g, ' '));
    const value = safeDecode(rawValue.replace(/\+/g, ' '));

    if (result[key] === undefined) {
      result[key] = value;
    } else if (Array.isArray(result[key])) {
      result[key].push(value);
    } else {
      result[key] = [result[key], value];
    }
  }

  return result;
}

// json/form bodies become objects, text becomes a string, everything else stays
// a Buffer. broken JSON comes back as raw text so the handler can decide if
// that's a 400.
function parseBody(rawBody, contentType) {
  if (rawBody.length === 0) return undefined;

  const type = (contentType || '').split(';')[0].trim().toLowerCase();

  if (type === 'application/json') {
    const text = rawBody.toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  if (type === 'application/x-www-form-urlencoded') {
    return parseQuery(rawBody.toString('utf8'));
  }

  if (type.startsWith('text/')) {
    return rawBody.toString('utf8');
  }

  return rawBody;
}

module.exports = { IncomingRequest };
