'use strict';

// Demo server. Run with `npm start`, then use a browser or curl.
// Shows: static files, static under a prefix, routes with params,
// POST/PUT/DELETE, middleware, and the custom error handler.

const path = require('path');
const sprig = require('..');

const app = sprig();

// log each request and how long it took. Sprig calls response.onComplete when
// the reply is sent, so we wrap it to time the round trip.
app.use((request, response, next) => {
  const start = process.hrtime.bigint();
  const originalOnComplete = response.onComplete;
  response.onComplete = () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`${request.method.padEnd(6)} ${request.path}  ${response.statusCode}  ${ms.toFixed(1)}ms`);
    originalOnComplete();
  };
  next();
});

// allow CORS so the API is callable from anywhere while testing
app.use((request, response, next) => {
  response.set('Access-Control-Allow-Origin', '*');
  response.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.set('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    return response.status(204).end();
  }
  next();
});

// a tiny in-memory store so the routes have something to work with
const notes = new Map();
let nextId = 1;
function addNote(title, body) {
  const id = String(nextId++);
  notes.set(id, { id, title, body, createdAt: new Date().toISOString() });
}
addNote('Welcome', 'This note lives in memory and is served over raw TCP.');
addNote('Try me', 'POST to /api/notes to add your own.');

// --- routes ---

app.get('/api/notes', (request, response) => {
  response.json({ count: notes.size, notes: [...notes.values()] });
});

app.get('/api/notes/:id', (request, response) => {
  const note = notes.get(request.params.id);
  if (!note) {
    return response.status(404).json({ error: `No note with id ${request.params.id}` });
  }
  response.json(note);
});

app.post('/api/notes', (request, response) => {
  const { title, body } = request.body || {};
  if (typeof title !== 'string' || title.trim() === '') {
    return response.status(400).json({ error: 'title is required' });
  }
  const id = String(nextId++);
  const note = { id, title, body: body || '', createdAt: new Date().toISOString() };
  notes.set(id, note);
  response.status(201).set('Location', `/api/notes/${id}`).json(note);
});

app.put('/api/notes/:id', (request, response) => {
  if (!notes.has(request.params.id)) {
    return response.status(404).json({ error: 'Note not found' });
  }
  const { title, body } = request.body || {};
  const note = { id: request.params.id, title: title || '', body: body || '', updatedAt: new Date().toISOString() };
  notes.set(request.params.id, note);
  response.json(note);
});

app.delete('/api/notes/:id', (request, response) => {
  if (!notes.delete(request.params.id)) {
    return response.status(404).json({ error: 'Note not found' });
  }
  response.status(204).end();
});

// wildcard example: echo back the matched path tail
app.get('/api/echo/*', (request, response) => {
  response.json({ youAskedFor: request.params.wildcard, query: request.query });
});

// --- static files ---
// serve the demo page at the root, and the same folder under /assets to show
// the prefix form too
const publicDir = path.join(__dirname, 'public');
app.static('/assets', publicDir);
app.static(publicDir);

// --- error handler ---
app.onError((error, request, response) => {
  console.error('Handler threw:', error);
  if (!response.headersSent) {
    response.status(500).json({ error: 'Something went wrong' });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Sprig demo running on http://localhost:${PORT}`);
  console.log(`Try: curl http://localhost:${PORT}/api/notes`);
});
