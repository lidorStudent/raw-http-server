# Sprig

A small HTTP server framework built on Node's `net` module. No `http`,
`https`, or `http2`, and no outside packages, it parses and writes the raw HTTP
itself.

The name just means "small" — that's the whole goal. Under the hood each request
gets passed through a chain of middleware and route handlers, one after the
other, until one of them sends a reply. That's basically the idea, and it's the
same way Express works.

```js
const sprig = require('sprig');
const app = sprig();

app.get('/hello/:name', (req, res) => {
  res.json({ greeting: `Hello, ${req.params.name}!` });
});

app.static('public');
app.listen(3000, () => console.log('listening on http://localhost:3000'));
```

## Running it

```bash
npm start        # runs examples/server.js
```

Then open http://localhost:3000 for the demo page, or use curl:

```bash
curl http://localhost:3000/api/notes

curl -X POST http://localhost:3000/api/notes \
     -H 'Content-Type: application/json' \
     -d '{"title":"My note","body":"hello"}'
```

`examples/server.js` is the quickest way to see everything: a notes API with
GET/POST/PUT/DELETE and `:id` params, static files served two ways, logging and
CORS middleware, and an error handler.

## The files

Each one does a single job:

- `lib/message-parser.js` — reads raw bytes into requests. The tricky file (see below).
- `lib/incoming-request.js` — wraps a request: path, query, params, parsed body.
- `lib/outgoing-response.js` — builds the response, plus `res.json()`, `res.send()`, etc.
- `lib/router.js` — stores routes/middleware and matches them.
- `lib/static-handler.js` — serves files from a folder.
- `lib/application.js` — the net server, connections, and the middleware chain.

## Reading requests

TCP gives you a stream of bytes, not whole messages. So one `data` event might be half a request,
a full one, or two stuck together. In local testing it almost always looks like
one event per request, which makes it easy to write something that breaks the
moment a request gets split across packets.

So the parser buffers the bytes and only pulls out a request once it's all there:

1. add new bytes to the buffer
2. wait for the blank line (`\r\n\r\n`) that ends the headers
3. read `Content-Length` to know how big the body is
4. once the whole body arrived, cut the request out and keep the rest

It keeps everything as a `Buffer` until it knows a part is text, because joining
chunks as strings can split a UTF-8 character in half or wreck a binary upload.

## API

Make an app:

```js
const app = require('sprig')();
```

Routes (one per method, plus `head` and `options`):

```js
app.get('/users/:id', handler);
app.post('/users', handler);
app.put('/users/:id', handler);
app.delete('/users/:id', handler);
app.get('/files/*', handler);   // * matches the rest of the path
```

Handlers get `(req, res, next)`. Call `next()` to move on to the next matching
layer, or just send a response.

Middleware:

```js
app.use(fn);             // runs for every request
app.use('/admin', fn);   // runs only under /admin
```

The request:

- `req.method`, `req.path`, `req.httpVersion`
- `req.query` — parsed query string (repeated keys become an array)
- `req.params` — route params (`:id`, and `wildcard` for `*`)
- `req.headers` / `req.header(name)` — name is case-insensitive
- `req.body` — JSON and form bodies become objects, text becomes a string, anything else stays a Buffer
- `req.raw` — the raw body Buffer

The response:

```js
res.status(201).json({ ok: true });   // chainable
res.set('X-Custom', 'value');
res.text('plain text');
res.html('<h1>hi</h1>');
res.send(value);          // object -> JSON, otherwise text
res.sendFile('/abs/path/to/file.png');   // streams it with the right Content-Type
res.redirect('/somewhere');
res.end();
```

`Date`, `Server`, `Connection`, and `Content-Length` are added for you unless
you set them yourself.

Static files:

```js
app.static('public');             // serve ./public at /
app.static('/assets', 'public');  // serve ./public under /assets
```

Errors:

```js
app.onError((err, req, res) => {
  res.status(500).json({ error: 'oops' });
});
```

Anything a handler throws ends up here.

## Extra stuff it handles

On top of the required static files and routing, the parts I put extra work into:

- **304 caching.** Static files send `ETag` and `Last-Modified`. If the browser
  already has the file it asks with `If-None-Match` / `If-Modified-Since` and we
  reply `304 Not Modified` with no body instead of resending it.
- **Range requests.** A `Range: bytes=0-1023` header gets back `206 Partial
  Content` with just that slice. This is what lets a browser seek in a video or
  resume a download. A bad range gets `416`.
- **Keep-alive.** Connections stay open for multiple requests, with an idle
  timeout. Requests on one connection run in order so responses can't get mixed up.
- **Body parsing by content type**, so `req.body` is usually ready to use.
- **405 vs 404.** A `DELETE` to a GET-only route returns `405` with an `Allow`
  header, not a misleading 404.

## What I tested

With curl and a few raw-socket scripts:

- GET/POST/PUT/DELETE routing with `:id` params and `*` wildcards
- JSON body parsing, `201` with `Location`, `204` with no body
- static files at the root and under `/assets`, with correct content types
- a traversal attempt (`/../../etc/passwd`) staying inside the folder
- `304` from an ETag, `206` and `416` for ranges
- two pipelined requests on one connection coming back in order
- a POST split across two TCP packets getting put back together
- a malformed request line returning `400`

## Rules followed

- Only the `net` module. No `http`/`https`/`http2`, no dependencies.
- Requests parsed by hand: request line, headers, body.
- Responses written by hand: status line, headers, blank line, body.
