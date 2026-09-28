const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const CLIENT_DIST = path.join(__dirname, '..', 'dist');
const MAX_CHUNK_BYTES = 1024 * 1024 + 64;
const MAX_UPLOAD_CHUNKS = 10000;
const MAX_HISTORY_PAGE = 100;
// Ceiling for an inline chat payload (base64 ciphertext). The client keeps
// ordinary chat text well under this and routes anything larger through the
// chunked /api/upload-binary pipeline instead (see client: TEXT_INLINE_LIMIT).
const MAX_MESSAGE_BYTES = 900 * 1024;

for (const dir of [DATA_DIR, HISTORY_DIR, MEDIA_DIR]) fs.mkdirSync(dir, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1.2mb' }));

if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (forwarded === 'http') return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
    next();
  });
}

app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'PrivateChat V6', e2ee: true, realtime: true, time: new Date().toISOString() });
});

function safePart(value) { return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); }
function validId(value) { const s = safePart(value); return s && s === value; }
function roomHistoryFile(room) { return path.join(HISTORY_DIR, `${safePart(room)}.jsonl`); }
function roomMediaDir(room) { const dir = path.join(MEDIA_DIR, safePart(room)); fs.mkdirSync(dir, { recursive: true }); return dir; }
function mediaFile(room, id, index) { return path.join(roomMediaDir(room), `${safePart(id)}_${index}.bin`); }

function appendHistory(room, envelope) {
  const file = roomHistoryFile(room);
  fs.appendFileSync(file, JSON.stringify(envelope) + '\n', 'utf8');
}

function readHistoryPage(room, beforeTs = Number.MAX_SAFE_INTEGER, limit = MAX_HISTORY_PAGE) {
  const file = roomHistoryFile(room);
  if (!fs.existsSync(file)) return [];
  const fd = fs.openSync(file, 'r');
  const stat = fs.fstatSync(fd);
  const out = [];
  let position = stat.size;
  let carry = '';
  const blockSize = 64 * 1024;
  try {
    while (position > 0 && out.length < limit) {
      const size = Math.min(blockSize, position);
      position -= size;
      const buf = Buffer.allocUnsafe(size);
      fs.readSync(fd, buf, 0, size, position);
      const text = buf.toString('utf8') + carry;
      const lines = text.split('\n');
      carry = lines.shift() || '';
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        if (!lines[i]) continue;
        try { const item = JSON.parse(lines[i]); if (Number(item.ts || 0) < beforeTs) out.unshift(item); } catch (_) {}
      }
    }
    if (position === 0 && carry && out.length < limit) {
      try { const item = JSON.parse(carry); if (Number(item.ts || 0) < beforeTs) out.unshift(item); } catch (_) {}
    }
  } finally { fs.closeSync(fd); }
  return out.slice(-limit);
}

// Uploads are raw encrypted binary chunks. The server never sees plaintext media,
// voice notes, or long text/code snippets (those are all chunked through this
// same route on the client).
app.post('/api/upload-binary', express.raw({ type: 'application/octet-stream', limit: '1.2mb' }), (req, res) => {
  try {
    const room = String(req.headers['x-chat-room'] || '');
    const id = String(req.headers['x-file-id'] || '');
    const index = Number(req.headers['x-file-index']);
    const total = Number(req.headers['x-file-total']);
    const iv = Buffer.from(String(req.headers['x-file-iv'] || ''), 'base64');
    const token = String(req.headers['x-chat-token'] || '');
    const session = sessions.get(token);
    if (!session || session.room !== room) return res.status(401).end();
    if (!validId(room) || !validId(id) || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || index >= total || total < 1 || total > MAX_UPLOAD_CHUNKS) return res.status(400).end();
    if (iv.length !== 12 || !Buffer.isBuffer(req.body) || req.body.length < 17 || req.body.length > MAX_CHUNK_BYTES) return res.status(400).end();
    const file = mediaFile(room, id, index);
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(12, 0);
    fs.writeFileSync(file, Buffer.concat([prefix, iv, req.body]), { flag: 'w' });
    res.json({ ok: true, index });
  } catch (e) { console.error('binary upload failed', e); res.status(500).end(); }
});

app.get('/api/download/:room/:id/:index', (req, res) => {
  try {
    const room = String(req.params.room), id = String(req.params.id), index = Number(req.params.index);
    const token = String(req.headers['x-chat-token'] || '');
    const session = sessions.get(token);
    if (!session || session.room !== room) return res.status(401).end();
    if (!validId(room) || !validId(id) || !Number.isInteger(index) || index < 0 || index >= MAX_UPLOAD_CHUNKS) return res.status(400).end();
    const file = mediaFile(room, id, index);
    if (!fs.existsSync(file)) return res.status(404).end();
    const raw = fs.readFileSync(file);
    if (raw.length < 20 || raw.readUInt32BE(0) !== 12) return res.status(500).end();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('x-file-iv', raw.subarray(4, 16).toString('base64'));
    res.end(raw.subarray(16));
  } catch (e) { console.error('download failed', e); res.status(500).end(); }
});

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { index: false, immutable: true, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
  app.get('*', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

const useTLS = Boolean(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE);
const server = useTLS ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT_FILE), key: fs.readFileSync(process.env.TLS_KEY_FILE), minVersion: 'TLSv1.2' }, app) : http.createServer(app);
// maxPayload must have headroom above MAX_MESSAGE_BYTES: a chat frame is the
// JSON envelope (type/id/name/userId/ts) wrapped around the payload, so it is
// always a bit bigger than payload.data alone. Without this headroom a
// message near the size limit would pass the application-level check below
// but still get silently killed by ws itself (close code 1009, "message too
// big"), dropping the connection.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES + 32 * 1024 });
const rooms = new Map();
const sessions = new Map();

function broadcast(room, obj, except = null) {
  const set = rooms.get(room); if (!set) return;
  const data = JSON.stringify(obj);
  for (const client of set) if (client !== except && client.readyState === 1) client.send(data);
}
function presence(room) {
  const set = rooms.get(room) || new Set();
  return [...set].filter(x => x.userId).map(x => ({ id: x.userId, name: x.name }));
}
function broadcastPresence(room) { broadcast(room, { type: 'presence', count: presence(room).length, users: presence(room) }); }

wss.on('connection', (socket, req) => {
  try {
    const url = new URL(req.url || '', 'http://localhost');
    const roomRaw = url.searchParams.get('room') || '';
    const room = safePart(roomRaw);
    if (!room || room !== roomRaw) return socket.close(1008, 'invalid room');
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { room, socket, createdAt: Date.now() });
    socket.accessToken = token; socket.room = room; socket.userId = ''; socket.name = 'Anonymous';
    if (!rooms.has(room)) rooms.set(room, new Set()); rooms.get(room).add(socket);
    socket.send(JSON.stringify({ type: 'session', token }));

    socket.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'join') {
          const wantedName = String(msg.name || 'Anonymous').slice(0, 80);
          const wantedUserId = String(msg.userId || '').slice(0, 80);
          const normalized = wantedName.trim().toLowerCase();
          // Two different devices/users in the same room may not share a display
          // name (it makes messages ambiguous about who actually sent them).
          // A device reconnecting/reloading with its own previous name is fine -
          // that's the same persistent userId, not a clash with someone else.
          const set = rooms.get(room);
          const clash = normalized && set && [...set].some(x => x !== socket && x.userId && x.userId !== wantedUserId && String(x.name || '').trim().toLowerCase() === normalized);
          if (clash) {
            socket.send(JSON.stringify({ type: 'nameTaken', name: wantedName }));
            return;
          }
          socket.name = wantedName;
          socket.userId = wantedUserId;
          const before = Number.isFinite(Number(msg.before)) ? Number(msg.before) : Number.MAX_SAFE_INTEGER;
          socket.send(JSON.stringify({ type: 'history', messages: readHistoryPage(room, before, MAX_HISTORY_PAGE), before }));
          broadcast(room, { type: 'system', text: `${socket.name} joined the room.`, ts: Date.now() });
          broadcastPresence(room);
          return;
        }
        if (msg.type === 'historyMore') {
          const before = Number(msg.before);
          if (Number.isFinite(before)) socket.send(JSON.stringify({ type: 'history', messages: readHistoryPage(room, before, MAX_HISTORY_PAGE), before }));
          return;
        }
        if (msg.type === 'chat') {
          const p = msg.payload;
          if (!p || p.v !== '6.0' || typeof p.iv !== 'string' || typeof p.data !== 'string' || p.data.length > MAX_MESSAGE_BYTES) return;
          const envelope = { type: 'chat', id: String(msg.id || crypto.randomUUID()).slice(0, 120), name: socket.name, userId: socket.userId, payload: p, ts: Number.isFinite(Number(msg.ts)) ? Number(msg.ts) : Date.now() };
          appendHistory(room, envelope); broadcast(room, envelope);
          return;
        }
        if (msg.type === 'signal') {
          const target = String(msg.to || '');
          const recipient = [...(rooms.get(room) || [])].find(x => x.userId === target);
          if (recipient && recipient.readyState === 1) recipient.send(JSON.stringify({ type: 'signal', from: socket.userId, name: socket.name, signal: msg.signal }));
          return;
        }
      } catch (_) {}
    });

    socket.on('close', () => {
      sessions.delete(token);
      const set = rooms.get(room); if (!set) return;
      set.delete(socket); if (set.size) broadcastPresence(room); else rooms.delete(room);
    });
  } catch (_) { socket.close(1011, 'server error'); }
});

setInterval(() => { const cutoff = Date.now() - 24 * 60 * 60 * 1000; for (const [token, s] of sessions) if (s.createdAt < cutoff) sessions.delete(token); }, 60 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  const scheme = useTLS ? 'https' : 'http';
  console.log(`PrivateChat V6 server running on ${scheme}://${HOST}:${PORT}`);
  console.log('E2EE mode: room-key AES-GCM; server stores encrypted envelopes/chunks only.');
});
