// Minimal client for the demo page. It talks to the route handlers in
// examples/server.js using the browser's fetch — proving the raw-TCP server
// behaves like any ordinary HTTP server from the outside.

const notesList = document.getElementById('notes');
const form = document.getElementById('add-note');
const titleInput = document.getElementById('title');

async function refreshNotes() {
  const response = await fetch('/api/notes');
  const { notes } = await response.json();
  notesList.innerHTML = notes.length
    ? notes.map((note) => `<li><strong>${escapeHtml(note.title)}</strong> — ${escapeHtml(note.body)}</li>`).join('')
    : '<li><em>No notes yet.</em></li>';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = titleInput.value.trim();
  if (!title) return;

  await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body: 'Added from the browser.' })
  });

  titleInput.value = '';
  refreshNotes();
});

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

refreshNotes();
