import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const CHUNK_SIZE = 1024 * 1024;
const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024;
const PBKDF2_ITERATIONS = 600000;
const APP_VERSION = '6.0';
// Ordinary chat text goes over the WebSocket inline (fast). Anything past
// this size (people pasting whole code files, huge logs, "100 million
// words"...) is instead sent through the same encrypted chunked-upload
// pipeline used for files, so there is no realistic length ceiling on a
// message - it's limited only by MAX_FILE_SIZE below.
const TEXT_INLINE_LIMIT = 6000; // bytes, UTF-8
// Videos longer than this never get the "decrypt the whole thing into memory
// and play it inline" treatment - fully buffering a long video as a Blob is
// exactly the kind of thing that stalls or crashes a phone browser. Past
// this length a video is download-only: it decrypts straight to disk via
// Chrome's normal download flow instead of into an in-memory Blob URL.
const VIDEO_INLINE_LIMIT_SECONDS = 5 * 60;
const HEIC_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];

const Icons = {
  lock: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12a1 1 0 0 1 1 1v9H5v-9a1 1 0 0 1 1-1Z"/><path d="M12 14v3"/></svg>,
  send: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="m3 20 18-8L3 4l2.5 7.2L14 12l-8.5.8L3 20Z"/></svg>,
  paperclip: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="m20.5 11.5-8.9 8.9a5 5 0 0 1-7.1-7.1l9.6-9.6a3.5 3.5 0 0 1 5 5l-9.7 9.7a2 2 0 0 1-2.8-2.8l8.9-8.9"/></svg>,
  smile: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><circle cx="12" cy="12" r="9"/><path d="M8 10h.01M16 10h.01M8.5 14.2a4.5 4.5 0 0 0 7 0"/></svg>,
  search: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/></svg>,
  more: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><circle cx="6" cy="12" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="18" cy="12" r="1.25"/></svg>,
  video: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg>,
  image: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 18 5-5 3.5 3 2.5-3 5 5"/></svg>,
  file: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M8 13h8M8 17h6"/></svg>,
  shield: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M12 3 20 6v5c0 5.1-3.2 8.6-8 10-4.8-1.4-8-4.9-8-10V6l8-3Z"/><path d="m8.5 12 2.2 2.2 4.9-5"/></svg>,
  close: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="m6 6 12 12M18 6 6 18"/></svg>,
  mic: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/></svg>,
  trash: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-9 0 1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/></svg>,
  download: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5"/><path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/></svg>,
  phone: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M5 4h3.3l1.7 4.7-2.3 1.9a13 13 0 0 0 5.7 5.7l1.9-2.3L20 15.7V19a1.5 1.5 0 0 1-1.6 1.5C10.6 20 4 13.4 3.5 5.6A1.5 1.5 0 0 1 5 4Z"/></svg>,
  flip: (p={}) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path d="M4 9a8 8 0 0 1 14-4M20 15a8 8 0 0 1-14 4"/><path d="M18 2v5h-5M6 22v-5h5"/></svg>
};

function toB64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s) {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function hex(bytes) { return [...bytes].map(x => x.toString(16).padStart(2, '0')).join(''); }
function shortTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dateLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(ts) === dayKey(now.getTime())) return 'TODAY';
  if (dayKey(ts) === dayKey(yesterday.getTime())) return 'YESTERDAY';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }).toUpperCase();
}
function formatSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function formatDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function wordCount(str) { return str.trim() ? str.trim().split(/\s+/).length : 0; }
function normalizeRoom(room) { return room.trim(); }

function looksLikeHeic(file) {
  return HEIC_TYPES.includes(file.type) || /\.(heic|heif)$/i.test(file.name || '');
}

// iPhones save camera photos as HEIC by default, and most non-Apple
// browsers (Chrome on Android, most desktop browsers) can't decode it at
// all - that's the actual cause of "photos from my iPhone look broken/bad
// on Android", not compression. Converting to a high-quality JPEG before
// encryption fixes it for every recipient regardless of platform. Every
// other image format is left completely untouched (sent byte-for-byte, at
// full original quality, exactly as it always was).
async function convertHeicIfNeeded(file) {
  if (!looksLikeHeic(file)) return file;
  try {
    const mod = await import('heic2any');
    const heic2any = mod.default || mod;
    const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.94 });
    const blob = Array.isArray(result) ? result[0] : result;
    const newName = file.name.replace(/\.(heic|heif)$/i, '') + '.jpg';
    return new File([blob], newName || 'photo.jpg', { type: 'image/jpeg' });
  } catch (e) {
    console.warn('HEIC conversion failed, sending the original file as-is', e);
    return file;
  }
}

// Reads a video's duration locally (client-side, before upload) by loading
// only its metadata into a throwaway <video> element - this never
// downloads/decrypts anything, just enough of the local file to know how
// long it runs, so the recipient can decide whether to offer inline
// playback or a download-only card before any bytes are even sent.
function probeVideoDuration(file) {
  return new Promise(resolve => {
    try {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.preload = 'metadata';
      const finish = value => { URL.revokeObjectURL(url); resolve(value); };
      video.onloadedmetadata = () => finish(Number.isFinite(video.duration) ? video.duration : null);
      video.onerror = () => finish(null);
      video.src = url;
    } catch (_) { resolve(null); }
  });
}

async function deriveRoomKey(password, room) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = enc.encode(`PrivateChatV6|${room}`);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, base, 256);
  const raw = new Uint8Array(bits);
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const fpBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const fingerprint = hex(fpBytes).slice(0, 24).match(/.{1,4}/g).join('-').toUpperCase();
  raw.fill(0);
  return { key, fingerprint };
}

async function encryptPayload(key, value, aadLabel) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(aadLabel);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, new TextEncoder().encode(value));
  return { v: APP_VERSION, iv: toB64(iv), data: toB64(data) };
}
async function decryptPayload(key, payload, aadLabel) {
  if (!payload || payload.v !== APP_VERSION) throw new Error('Unsupported encrypted payload');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(payload.iv), additionalData: new TextEncoder().encode(aadLabel) }, key, fromB64(payload.data));
  return new TextDecoder().decode(plain);
}


const HISTORY_DB = 'PrivateChatV6History';
const HISTORY_STORE = 'sessions';
const HISTORY_KEY = 'last-session';
const LOCAL_HISTORY_LIMIT = 5000;

function openHistoryDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(HISTORY_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HISTORY_STORE)) req.result.createObjectStore(HISTORY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

async function readSavedSession() {
  const db = await openHistoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, 'readonly');
    const req = tx.objectStore(HISTORY_STORE).get(HISTORY_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error || new Error('IndexedDB transaction failed')); };
  });
}

async function saveSession(session) {
  const db = await openHistoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, 'readwrite');
    tx.objectStore(HISTORY_STORE).put({ ...session, id: HISTORY_KEY, updatedAt: Date.now() }, HISTORY_KEY);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('IndexedDB write failed')); };
  });
}

async function clearSavedSession() {
  try {
    const db = await openHistoryDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_STORE, 'readwrite');
      tx.objectStore(HISTORY_STORE).delete(HISTORY_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
    });
    db.close();
  } catch (_) {}
}

function messageId(msg) {
  return String(msg?.id || `${msg?.userId || 'u'}-${msg?.ts || 0}-${msg?.payload?.iv || ''}`);
}

function dedupeMessages(list) {
  const map = new Map();
  for (const msg of list || []) {
    if (!msg || msg.type !== 'chat' || !msg.payload) continue;
    map.set(messageId(msg), msg);
  }
  return [...map.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)).slice(-LOCAL_HISTORY_LIMIT);
}

function App() {
  const [joined, setJoined] = useState(false);
  const [name, setName] = useState(localStorage.getItem('pc_name') || '');
  const [room, setRoom] = useState('');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState(null);
  const [fingerprint, setFingerprint] = useState('');
  const [status, setStatus] = useState('Offline');
  const [online, setOnline] = useState(0);
  const [users, setUsers] = useState([]);
  const [accessToken, setAccessToken] = useState('');
  const [callPeer, setCallPeer] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const ws = useRef(null);
  const bottom = useRef(null);
  // Single element that receives whatever the peer sends: for an audio call
  // it's rendered invisible (a <video> tag plays an audio-only stream fine),
  // for a video call it's the big visible remote feed - so there's one path
  // for attaching incoming tracks regardless of call type.
  const remoteMediaRef = useRef(null);
  const localVideoRef = useRef(null);
  const facingModeRef = useRef('user');
  const userId = useMemo(() => {
    const saved = localStorage.getItem('pc_device_id');
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem('pc_device_id', id);
    return id;
  }, []);
  const [restoring, setRestoring] = useState(true);
  // pendingCandidates buffers ICE candidates that arrive before
  // setRemoteDescription has resolved - addIceCandidate() rejects if called
  // too early, and candidates commonly arrive on this fast a timeline.
  const callRef = useRef({ pc: null, stream: null, peerId: '', incoming: false, pendingCandidates: [], video: false });
  const recorderRef = useRef(null);
  const recordStartRef = useRef(0);
  const recordCancelledRef = useRef(false);
  const recordTimerRef = useRef(null);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  // The local camera preview element only exists once the video-call overlay
  // is mounted (after setCallPeer causes a re-render), so it can't be wired
  // up synchronously inside startCall/acceptIncomingCall - this effect
  // attaches it as soon as it's actually in the DOM.
  useEffect(() => {
    if (callPeer?.video && localVideoRef.current && callRef.current.stream) {
      localVideoRef.current.srcObject = callRef.current.stream;
    }
  }, [callPeer]);
  useEffect(() => () => ws.current?.close(), []);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const saved = await readSavedSession();
        if (!saved || cancelled || !saved.key || !saved.room) {
          if (!cancelled) setRestoring(false);
          return;
        }
        setName(saved.name || localStorage.getItem('pc_name') || '');
        setRoom(saved.room);
        setFingerprint(saved.fingerprint || '');
        setKey(saved.key);
        const restored = [];
        for (const msg of saved.messages || []) {
          try {
            const plain = await decryptPayload(saved.key, msg.payload, 'pc6:message');
            restored.push({ ...msg, text: plain, self: msg.userId === userId });
          } catch (_) {}
        }
        if (cancelled) return;
        setMessages(restored);
        setJoined(true);
        connect(saved.key, saved.name || 'Anonymous', saved.room, saved.fingerprint || '');
      } catch (err) {
        console.warn('Saved private chat session could not be restored', err);
      } finally {
        if (!cancelled) setRestoring(false);
      }
    }
    restore();
    return () => { cancelled = true; };
  }, []);

  async function persistMessages(nextMessages, sessionOverride = {}) {
    const encryptedMessages = dedupeMessages(nextMessages).map(m => ({
      id: m.id, name: m.name, userId: m.userId, payload: m.payload, ts: Number(m.ts || Date.now())
    }));
    try {
      await saveSession({
        room: sessionOverride.room || room,
        name: sessionOverride.name || name,
        fingerprint: sessionOverride.fingerprint || fingerprint,
        key: sessionOverride.key || key,
        messages: encryptedMessages
      });
    } catch (err) {
      console.warn('Encrypted local chat history could not be saved', err);
    }
  }

  async function handleJoin(e) {
    e?.preventDefault();
    if (!window.isSecureContext) {
      alert('PrivateChat needs a secure HTTPS page on non-localhost devices. Deploy the app with HTTPS before using it on the internet.');
      return;
    }
    if (!name.trim() || !room.trim() || password.length < 12) {
      alert('Enter your name, room code, and a passphrase of at least 12 characters. Use a strong private passphrase and share it only with the people you trust.');
      return;
    }
    try {
      const cleanRoom = normalizeRoom(room);
      setStatus('Generating security key…');
      const result = await deriveRoomKey(password, cleanRoom);
      localStorage.setItem('pc_name', name.trim());
      setKey(result.key);
      setFingerprint(result.fingerprint);
      setRoom(cleanRoom);
      setJoined(true);
      await saveSession({ room: cleanRoom, name: name.trim(), fingerprint: result.fingerprint, key: result.key, messages: [] });
      connect(result.key, name.trim(), cleanRoom, result.fingerprint);
    } catch (err) {
      console.error(err);
      alert('Could not create the encryption key on this device.');
      setStatus('Offline');
    }
  }

  function connect(k, n, r, fp = '') {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws?room=${encodeURIComponent(r)}`);
    ws.current = socket;
    setStatus('Connecting…');
    socket.onopen = () => {
      setStatus('Online');
      socket.send(JSON.stringify({ type: 'join', name: n, userId }));
    };
    socket.onmessage = async event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'session') { setAccessToken(msg.token || ''); return; }
        if (msg.type === 'nameTaken') {
          alert(`"${msg.name || n}" is already in use by someone else in this room. Please pick a different display name.`);
          setJoined(false);
          setStatus('Offline');
          setAccessToken('');
          socket.close();
          if (ws.current === socket) ws.current = null;
          return;
        }
        if (msg.type === 'presence') { setOnline(Number(msg.count || 0)); setUsers(Array.isArray(msg.users) ? msg.users : []); return; }
        if (msg.type === 'signal') { handleSignal(msg); return; }
        if (msg.type === 'history') {
          const history = [];
          for (const item of Array.isArray(msg.messages) ? msg.messages : []) {
            try { const plain = await decryptPayload(k, item.payload, 'pc6:message'); history.push({ ...item, type: 'chat', text: plain, self: item.userId === userId }); } catch (_) {}
          }
          setMessages(v => {
            const merged = dedupeMessages([...v.filter(x => x.type === 'chat'), ...history]);
            const withSelf = merged.map(x => ({ ...x, text: x.text || '', self: x.userId === userId }));
            queueMicrotask(() => persistMessages(withSelf, { key: k, room: r, name: n, fingerprint: fp }));
            return withSelf;
          });
          return;
        }
        if (msg.type === 'system') return;
        if (msg.type === 'chat') {
          const plain = await decryptPayload(k, msg.payload, 'pc6:message');
          setMessages(v => {
            const merged = dedupeMessages([...v.filter(x => x.type === 'chat'), { ...msg, text: plain, self: msg.userId === userId }]);
            const withSelf = merged.map(x => ({ ...x, self: x.userId === userId }));
            queueMicrotask(() => persistMessages(withSelf, { key: k, room: r, name: n, fingerprint: fp }));
            return withSelf;
          });
        }
      } catch (err) { console.warn('Incoming event rejected', err); }
    };
    socket.onclose = () => { setStatus('Disconnected'); setOnline(0); setUsers([]); setAccessToken(''); setIncomingCall(null); endCall(false); };
    socket.onerror = () => setStatus('Connection error');
  }

  async function sendSignal(to, signal) {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: 'signal', to, signal }));
  }

  function createPeerConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.onicecandidate = e => { if (e.candidate) sendSignal(peerId, { type: 'ice', candidate: e.candidate }); };
    pc.onconnectionstatechange = () => { if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) endCall(false); };
    pc.ontrack = e => {
      const el = remoteMediaRef.current;
      if (el) { el.srcObject = e.streams[0]; el.play().catch(() => {}); }
    };
    return pc;
  }

  async function flushPendingCandidates() {
    const c = callRef.current;
    if (!c.pc || !c.pendingCandidates?.length) return;
    const pending = c.pendingCandidates;
    c.pendingCandidates = [];
    for (const candidate of pending) {
      try { await c.pc.addIceCandidate(candidate); } catch (e) { console.warn('Queued ICE candidate rejected', e); }
    }
  }

  async function startCall(peer, video = false) {
    if (!peer || peer.id === userId || callRef.current.pc || callPeer || incomingCall) return;
    try {
      facingModeRef.current = 'user';
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: 'user' } : false });
      const pc = createPeerConnection(peer.id);
      callRef.current = { pc, stream, peerId: peer.id, incoming: false, pendingCandidates: [], video };
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      setMicOn(true); setCamOn(video);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal(peer.id, { type: 'offer', sdp: offer, name, video });
      setCallPeer({ id: peer.id, name: peer.name, state: 'calling', video });
    } catch (e) {
      console.error(e);
      alert(video ? 'Camera and microphone access are required for a video call.' : 'Microphone access is required for an audio call.');
      endCall(false);
    }
  }

  async function handleSignal(msg) {
    const s = msg.signal || {};
    try {
      if (s.type === 'offer') {
        if (callRef.current.pc || callPeer || incomingCall) { sendSignal(msg.from, { type: 'busy' }); return; }
        setIncomingCall({ id: msg.from, name: msg.name || s.name || 'PrivateChat user', sdp: s.sdp, video: !!s.video });
        return;
      }
      if (s.type === 'answer' && callRef.current.pc) {
        await callRef.current.pc.setRemoteDescription(s.sdp);
        await flushPendingCandidates();
        setCallPeer(v => v ? { ...v, state: 'connected' } : v);
        return;
      }
      if (s.type === 'ice') {
        const c = callRef.current;
        if (c.pc && c.pc.remoteDescription) await c.pc.addIceCandidate(s.candidate);
        else c.pendingCandidates.push(s.candidate);
        return;
      }
      if (s.type === 'hangup') {
        setIncomingCall(v => (v && v.id === msg.from) ? null : v);
        if (callRef.current.peerId === msg.from || callPeer?.id === msg.from) endCall(false);
        return;
      }
      if (s.type === 'busy') {
        alert(`${callPeer?.name || 'They'} are on another call right now.`);
        endCall(false);
        return;
      }
    } catch (e) { console.warn('Call signal failed', e); endCall(false); }
  }

  async function acceptIncomingCall() {
    const call = incomingCall;
    if (!call) return;
    setIncomingCall(null);
    try {
      facingModeRef.current = 'user';
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.video ? { facingMode: 'user' } : false });
      const pc = createPeerConnection(call.id);
      callRef.current = { pc, stream, peerId: call.id, incoming: true, pendingCandidates: [], video: call.video };
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      setMicOn(true); setCamOn(call.video);
      await pc.setRemoteDescription(call.sdp);
      await flushPendingCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(call.id, { type: 'answer', sdp: answer });
      setCallPeer({ id: call.id, name: call.name, state: 'connected', video: call.video });
    } catch (e) {
      console.error(e);
      alert(call.video ? 'Camera and microphone access are required for a video call.' : 'Microphone access is required for an audio call.');
      sendSignal(call.id, { type: 'hangup' });
      endCall(false);
    }
  }

  function toggleMic() {
    const track = callRef.current.stream?.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; setMicOn(track.enabled); }
  }

  function toggleCamera() {
    const track = callRef.current.stream?.getVideoTracks()[0];
    if (track) { track.enabled = !track.enabled; setCamOn(track.enabled); }
  }

  async function switchCamera() {
    const c = callRef.current;
    if (!c.pc || !c.video || !c.stream) return;
    try {
      facingModeRef.current = facingModeRef.current === 'user' ? 'environment' : 'user';
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facingModeRef.current } });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;
      const sender = c.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
      const oldTrack = c.stream.getVideoTracks()[0];
      if (oldTrack) { c.stream.removeTrack(oldTrack); oldTrack.stop(); }
      newTrack.enabled = camOn;
      c.stream.addTrack(newTrack);
      if (localVideoRef.current) localVideoRef.current.srcObject = c.stream;
    } catch (e) { console.warn('Switching camera failed (device may only have one camera)', e); }
  }

  function declineIncomingCall() {
    if (!incomingCall) return;
    sendSignal(incomingCall.id, { type: 'hangup' });
    setIncomingCall(null);
  }

  function endCall(notify = true) {
    const c = callRef.current;
    if (notify && c.peerId) sendSignal(c.peerId, { type: 'hangup' });
    try { c.stream?.getTracks().forEach(t => t.stop()); c.pc?.close(); } catch (_) {}
    callRef.current = { pc: null, stream: null, peerId: '', incoming: false, pendingCandidates: [], video: false };
    if (remoteMediaRef.current) remoteMediaRef.current.srcObject = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    setMicOn(true); setCamOn(true);
    setCallPeer(null);
  }

  // Shared upload path for file attachments, long text/code "snippets", and
  // voice notes: encrypts CHUNK_SIZE pieces client-side and streams them to
  // /api/upload-binary, then sends one small encrypted metadata envelope over
  // the WebSocket pointing at the uploaded chunks. Nothing about message size
  // here is bounded by the WebSocket frame limit.
  async function encryptAndUploadBlob(blob, { fileName, mime, kind, extra = {} }) {
    if (!blob || !key || uploading || !ws.current || ws.current.readyState !== WebSocket.OPEN || !accessToken) return false;
    if (blob.size > MAX_FILE_SIZE) { alert(`Maximum size is ${formatSize(MAX_FILE_SIZE)}.`); return false; }
    setUploading(true);
    try {
      const fileId = crypto.randomUUID();
      const total = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE));
      for (let i = 0; i < total; i++) {
        const chunk = await blob.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, blob.size)).arrayBuffer();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`pc6:file:${fileId}:${i}`) }, key, chunk);
        const res = await fetch('/api/upload-binary', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Chat-Room': room,
            'X-Chat-Token': accessToken,
            'X-File-Id': fileId,
            'X-File-Index': String(i),
            'X-File-Total': String(total),
            'X-File-IV': toB64(iv)
          },
          body: encrypted
        });
        if (!res.ok) throw new Error(`upload ${res.status}`);
        setStatus(`Uploading ${Math.round(((i + 1) / total) * 100)}%`);
      }
      setStatus('Online');
      const metadata = JSON.stringify({ kind, id: fileId, name: fileName, mime, size: blob.size, total, version: 1, ...extra });
      const payload = await encryptPayload(key, metadata, `pc6:file-meta:${fileId}`);
      ws.current.send(JSON.stringify({ type: 'chat', id: crypto.randomUUID(), name, userId, payload, ts: Date.now() }));
      return true;
    } catch (err) {
      console.error(err);
      alert('The encrypted upload failed. Check the connection and try again.');
      setStatus('Online');
      return false;
    } finally { setUploading(false); }
  }

  async function sendMessage() {
    const value = text.trim();
    if (!value || !key || !ws.current || ws.current.readyState !== WebSocket.OPEN) return;
    const byteLength = new TextEncoder().encode(value).length;
    if (byteLength > TEXT_INLINE_LIMIT) {
      // Very long message (a big paste of code, etc.) - send it as an
      // encrypted "snippet" through the chunked upload pipeline instead of
      // trying to cram it into a single WebSocket frame.
      setText('');
      const blob = new Blob([value], { type: 'text/plain' });
      await encryptAndUploadBlob(blob, { fileName: 'Message.txt', mime: 'text/plain', kind: 'snippet', extra: { words: wordCount(value), chars: value.length } });
      return;
    }
    const ts = Date.now();
    const payload = await encryptPayload(key, value, 'pc6:message');
    ws.current.send(JSON.stringify({ type: 'chat', id: crypto.randomUUID(), name, userId, payload, ts }));
    setText('');
  }

  async function sendFile(file) {
    if (!file) return;
    let toSend = file;
    if (looksLikeHeic(file)) {
      setStatus('Converting photo…');
      toSend = await convertHeicIfNeeded(file);
      setStatus('Online');
    }
    let extra = {};
    if (toSend.type?.startsWith('video/')) {
      const duration = await probeVideoDuration(toSend);
      if (duration) extra = { duration };
    }
    await encryptAndUploadBlob(toSend, { fileName: toSend.name, mime: toSend.type || 'application/octet-stream', kind: 'file', extra });
  }

  async function sendVoiceNote(blob, durationSec) {
    const mime = blob.type || 'audio/webm';
    const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
    await encryptAndUploadBlob(blob, { fileName: `Voice message.${ext}`, mime, kind: 'voice', extra: { duration: durationSec } });
  }

  async function startRecording() {
    if (recording || uploading) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      const mimeType = mimeCandidates.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported?.(t)) || '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(recordTimerRef.current);
        const elapsed = (Date.now() - recordStartRef.current) / 1000;
        setRecording(false); setRecordSeconds(0);
        const cancelled = recordCancelledRef.current; recordCancelledRef.current = false;
        if (cancelled || !chunks.length || elapsed < 1) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
        await sendVoiceNote(blob, elapsed);
      };
      recorderRef.current = recorder;
      recordStartRef.current = Date.now();
      recordCancelledRef.current = false;
      recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds(s => s + 1), 1000);
    } catch (e) {
      console.error(e);
      alert('Microphone access is required to record a voice message.');
    }
  }

  function stopRecording(cancel = false) {
    if (!recorderRef.current || recorderRef.current.state === 'inactive') return;
    recordCancelledRef.current = cancel;
    recorderRef.current.stop();
  }

  async function leaveRoom() {
    ws.current?.close();
    await clearSavedSession();
    setJoined(false);
    setKey(null);
    setFingerprint('');
    setMessages([]);
    setOnline(0);
    setUsers([]);
    setAccessToken('');
    endCall(false);
    setIncomingCall(null);
    setPassword('');
    setRoom('');
  }

  if (restoring) {
    return <div className="restore-page"><div className="restore-card"><div className="brand-lock"><Icons.lock /></div><strong>Opening your private chats…</strong><span>Restoring encrypted history on this device.</span></div></div>;
  }

  if (!joined) {
    return <SetupScreen name={name} setName={setName} room={room} setRoom={setRoom} password={password} setPassword={setPassword} onJoin={handleJoin} />;
  }

  const visibleMessages = search.trim()
    ? messages.filter(m => String(m.text || '').toLowerCase().includes(search.toLowerCase()))
    : messages;
  let previousDay = '';
  const renderedMessages = visibleMessages.map((m, i) => {
    const currentDay = dayKey(m.ts);
    const showDay = currentDay !== previousDay;
    previousDay = currentDay;
    return <React.Fragment key={`${messageId(m)}-${i}`}>
      {showDay && <div className="date-chip">{dateLabel(m.ts)}</div>}
      <div className={`message-row ${m.self ? 'outgoing' : 'incoming'}`}>
        <div className="message-bubble">
          {!m.self && <div className="sender-name">{m.name}</div>}
          <MessageContent encryptedText={m.text} room={room} keyObj={key} accessToken={accessToken} />
          <div className="message-time">{shortTime(m.ts)} {m.self && <span className="ticks">✓✓</span>}</div>
        </div>
      </div>
    </React.Fragment>;
  });

  return <div className="wa-app">
    <aside className="wa-sidebar">
      <div className="sidebar-top">
        <div className="avatar self-avatar">{(name[0] || 'P').toUpperCase()}</div>
        <div className="sidebar-title">PrivateChat</div>
        <button className="icon-btn" onClick={() => setSecurityOpen(true)} aria-label="Security"><Icons.lock /></button>
        <button className="icon-btn" onClick={leaveRoom} aria-label="Leave room"><Icons.more /></button>
      </div>
      <div className="security-card">
        <Icons.shield />
        <div><strong>End-to-end encrypted</strong><span>Messages and media are encrypted before they leave your device. Encrypted history is saved for reopening.</span></div>
      </div>
      <div className="search-box"><Icons.search /><span>Private room</span></div>
      <div className="room-list"><div className="room-item active"><div className="avatar room-avatar">🔒</div><div><strong>Private room</strong><span>{room}</span></div><em>{online} online</em></div></div>
    </aside>

    <section className="wa-chat">
      <header className="chat-header">
        <div className="mobile-avatar"><div className="avatar room-avatar">🔒</div></div>
        <div className="chat-contact"><strong>Private room</strong><span><b className={status === 'Online' ? 'online-dot' : ''}></b>{online} online · End-to-end encrypted</span></div>
        <div className="chat-actions">
          {searchOpen && <input autoFocus className="mini-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search" />}
          <button className="icon-btn" onClick={() => setSearchOpen(v => !v)} aria-label="Search"><Icons.search /></button>
          <button className="icon-btn" onClick={() => setSecurityOpen(true)} aria-label="Security"><Icons.lock /></button>
        </div>
      </header>

      <div className="call-strip">
        <span className="call-strip-label">{online} online</span>
        {users.filter(u => u.id !== userId).slice(0, 6).map(u => (
          <div className="call-chip" key={u.id}>
            <span className="call-chip-name">{u.name}</span>
            <button className="call-chip-btn" onClick={() => startCall(u, false)} disabled={!!callPeer || !!incomingCall} aria-label={`Audio call ${u.name}`} title="Audio call"><Icons.phone /></button>
            <button className="call-chip-btn" onClick={() => startCall(u, true)} disabled={!!callPeer || !!incomingCall} aria-label={`Video call ${u.name}`} title="Video call"><Icons.video /></button>
          </div>
        ))}
      </div>
      <main className="chat-body">
        {messages.length >= LOCAL_HISTORY_LIMIT && <button className="load-more" onClick={() => { const oldest = messages.filter(m => m.type === 'chat').sort((a,b)=>a.ts-b.ts)[0]; if (oldest && ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: 'historyMore', before: oldest.ts })); }}>Load older encrypted messages</button>}
        <div className="encryption-note"><span className="note-lock"><Icons.lock /></span><div><strong>Messages and calls are end-to-end encrypted.</strong><span>Only people in this room with the same passphrase can decrypt the content.</span></div></div>
        {visibleMessages.length === 0 && <div className="empty-chat"><div className="empty-icon"><Icons.shield /></div><strong>{search.trim() ? 'No matching messages' : 'Your private room is ready'}</strong><span>{search.trim() ? 'Try another search term.' : 'Send a message, a voice note, or attach a video. Your encrypted history will remain available when you reopen the app.'}</span></div>}
        {renderedMessages}
        <div ref={bottom} />
      </main>

      <div className="composer-wrap">
        {uploading && <div className="upload-progress"><span className="spinner"></span>Encrypting and uploading securely…</div>}
        {recording ? (
          <div className="composer recording">
            <button className="icon-btn composer-icon cancel-record" onClick={() => stopRecording(true)} aria-label="Cancel recording"><Icons.trash /></button>
            <div className="record-indicator"><span className="record-dot"></span>Recording {formatDuration(recordSeconds)}</div>
            <button className="send-btn" onClick={() => stopRecording(false)} aria-label="Send voice message"><Icons.send /></button>
          </div>
        ) : (
          <div className="composer">
            <button className="icon-btn composer-icon" aria-label="Emoji"><Icons.smile /></button>
            <label className="icon-btn composer-icon" aria-label="Attach file"><Icons.paperclip /><input type="file" accept="video/*,image/*,audio/*,.pdf,.doc,.docx,.txt" disabled={uploading} onChange={e => { sendFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
            <input className="message-input" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }} placeholder="Type a message" />
            {text.trim()
              ? <button className="send-btn" onClick={sendMessage} disabled={status !== 'Online'} aria-label="Send"><Icons.send /></button>
              : <button className="send-btn mic-btn" onClick={startRecording} disabled={status !== 'Online' || uploading} aria-label="Record voice message"><Icons.mic /></button>}
          </div>
        )}
      </div>
    </section>

    {callPeer && callPeer.video ? (
      <div className="video-call-overlay">
        <video ref={remoteMediaRef} className="remote-video" autoPlay playsInline />
        <div className="video-call-topbar"><strong>{callPeer.name}</strong><span>{callPeer.state === 'calling' ? 'Calling…' : 'Video call · End-to-end encrypted'}</span></div>
        <video ref={localVideoRef} className={`local-preview ${camOn ? '' : 'cam-off'}`} autoPlay playsInline muted />
        <div className="video-call-controls">
          <button className={`call-ctrl ${!micOn ? 'off' : ''}`} onClick={toggleMic} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'} title="Microphone"><Icons.mic /></button>
          <button className={`call-ctrl ${!camOn ? 'off' : ''}`} onClick={toggleCamera} aria-label={camOn ? 'Turn camera off' : 'Turn camera on'} title="Camera"><Icons.video /></button>
          <button className="call-ctrl" onClick={switchCamera} aria-label="Switch camera" title="Switch camera"><Icons.flip /></button>
          <button className="call-ctrl end" onClick={() => endCall(true)} aria-label="End call" title="End call"><Icons.close /></button>
        </div>
      </div>
    ) : callPeer ? (
      <div className="call-overlay"><div className="call-card">
        <video ref={remoteMediaRef} className="remote-audio-hidden" autoPlay playsInline />
        <div className="call-avatar">{(callPeer.name?.[0] || '?').toUpperCase()}</div>
        <strong>{callPeer.name}</strong>
        <span>{callPeer.state === 'calling' ? 'Calling…' : 'Audio call connected'}</span>
        <button className="hangup-btn" onClick={() => endCall(true)}>End call</button>
      </div></div>
    ) : null}
    {incomingCall && <div className="call-overlay"><div className="call-card incoming"><div className="call-avatar">{(incomingCall.name?.[0] || '?').toUpperCase()}</div><strong>{incomingCall.name}</strong><span>Incoming {incomingCall.video ? 'video' : 'audio'} call…</span><div className="call-actions"><button className="decline-btn" onClick={declineIncomingCall} aria-label="Decline"><Icons.close /></button><button className="accept-btn" onClick={acceptIncomingCall} aria-label="Accept">{incomingCall.video ? <Icons.video /> : <Icons.mic />}</button></div></div></div>}
    {securityOpen && <SecurityModal fingerprint={fingerprint} room={room} onClose={() => setSecurityOpen(false)} />}
  </div>;
}

function SetupScreen({ name, setName, room, setRoom, password, setPassword, onJoin }) {
  const secure = window.isSecureContext;
  return <div className="setup-page">
    <div className="setup-glow glow-one"></div><div className="setup-glow glow-two"></div>
    <div className="setup-card">
      <div className="brand-lock"><Icons.shield /></div>
      <div className="brand-name">Private<span>Chat</span></div>
      <h1>Private conversations,<br /><em>built for privacy.</em></h1>
      <p className="setup-copy">WhatsApp-inspired private messaging with encrypted text, media, voice notes and encrypted chat history.</p>
      <div className={`secure-status ${secure ? 'secure' : 'insecure'}`}><span></span>{secure ? 'Secure browser context' : 'HTTPS is required on network/internet addresses'}</div>
      <form onSubmit={onJoin}>
        <label>Your name<input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Abdul" autoComplete="name" /></label>
        <label>Private room code<input value={room} onChange={e => setRoom(e.target.value)} placeholder="family-2026" autoCapitalize="none" /></label>
        <label>Shared encryption passphrase<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="12+ characters" autoComplete="new-password" /></label>
        <button className="join-btn" type="submit"><Icons.lock /> Enter encrypted room</button>
      </form>
      <div className="setup-note"><Icons.lock /><span>Your passphrase stays on your device. This browser can remember an encrypted session so your chat history can reappear when you reopen PrivateChat.</span></div>
    </div>
  </div>;
}

function SecurityModal({ fingerprint, room, onClose }) {
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="security-modal" onMouseDown={e => e.stopPropagation()}>
      <div className="modal-head"><div><Icons.shield /><strong>Security information</strong></div><button className="icon-btn" onClick={onClose} aria-label="Close"><Icons.close /></button></div>
      <div className="secure-big"><span></span>End-to-end encrypted</div>
      <p>PrivateChat encrypts message text, voice notes, file chunks, long text/code snippets, and metadata in the browser before they leave your device.</p>
      <div className="security-row"><span>Room</span><strong>{room}</strong></div>
      <div className="security-row"><span>Security code</span><strong className="fingerprint">{fingerprint}</strong></div>
      <div className="security-row"><span>Content cipher</span><strong>AES-256-GCM</strong></div>
      <div className="security-row"><span>Key derivation</span><strong>PBKDF2 · SHA-256 · 600,000 iterations</strong></div>
      <div className="security-warning">This is a private-messaging application design, not a cryptographically audited WhatsApp replacement. Always verify the security code with the other participant through a trusted channel.</div>
      <button className="close-btn" onClick={onClose}>Done</button>
    </div>
  </div>;
}

function MessageContent({ encryptedText, room, keyObj, accessToken }) {
  const [data, setData] = useState(null);
  const [mediaUrl, setMediaUrl] = useState('');
  const [snippetText, setSnippetText] = useState('');
  const [state, setState] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const objectUrlRef = useRef('');

  useEffect(() => {
    let parsed = null;
    try { const x = JSON.parse(encryptedText); if (x && (x.kind === 'file' || x.kind === 'voice' || x.kind === 'snippet')) parsed = x; } catch (_) {}
    setData(parsed); setMediaUrl(''); setSnippetText(''); setState(''); setCopied(false); setImgFailed(false);
  }, [encryptedText]);
  useEffect(() => () => { if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current); }, []);

  async function fetchChunk(i) {
    const res = await fetch(`/api/download/${encodeURIComponent(room)}/${encodeURIComponent(data.id)}/${i}`, { cache: 'no-store', headers: { 'X-Chat-Token': accessToken } });
    if (!res.ok) throw new Error(`media ${res.status}`);
    const iv64 = res.headers.get('x-file-iv'); if (!iv64) throw new Error('missing iv');
    const encrypted = await res.arrayBuffer();
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv64), additionalData: new TextEncoder().encode(`pc6:file:${data.id}:${i}`) }, keyObj, encrypted);
  }

  // Media (video/image/audio/voice) is fully decrypted into memory and played
  // back from a Blob URL, exactly like images and audio already did. An
  // earlier version tried progressive MediaSource streaming for video, but
  // MediaSource.isTypeSupported() rejects plain mime types with no codec
  // string (e.g. the bare "video/mp4" reported by most browsers/phones for an
  // uploaded file), so nearly every video failed with "Unable to decrypt or
  // stream this media" even though the decrypted bytes were perfectly valid.
  // Buffering the whole file, like the working image/audio paths, is what
  // actually plays reliably.
  async function prepare() {
    if (!data || !keyObj || loading || mediaUrl || snippetText) return;
    setLoading(true); setState('Decrypting…');
    try {
      const parts = [];
      for (let i = 0; i < data.total; i++) {
        parts.push(await fetchChunk(i));
        setState(`Decrypting ${Math.round(((i + 1) / data.total) * 100)}%`);
      }
      if (data.kind === 'snippet') {
        const totalBytes = parts.reduce((n, p) => n + p.byteLength, 0);
        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const p of parts) { bytes.set(new Uint8Array(p), offset); offset += p.byteLength; }
        setSnippetText(new TextDecoder().decode(bytes));
      } else {
        const url = URL.createObjectURL(new Blob(parts, { type: data.mime || 'application/octet-stream' }));
        objectUrlRef.current = url;
        setMediaUrl(url);
      }
      setState('ready');
    } catch (e) {
      console.error(e);
      if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = ''; }
      setMediaUrl(''); setSnippetText('');
      setState('Unable to decrypt this content.');
    } finally { setLoading(false); }
  }

  function copySnippet() {
    navigator.clipboard?.writeText(snippetText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  }

  // Decrypts the media first if needed, then hands the plain Blob URL to a
  // throwaway <a download> and clicks it - this is what makes Chrome save the
  // file to the Downloads folder, same as any ordinary file download. The
  // server and the wire never see the plaintext; only this browser tab does,
  // for exactly as long as it takes to write it to disk.
  async function downloadMedia() {
    if (!data || downloading) return;
    setDownloading(true);
    try {
      if (!objectUrlRef.current) await prepare();
      const url = objectUrlRef.current;
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.download = data.name || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally { setDownloading(false); }
  }

  // Videos over VIDEO_INLINE_LIMIT_SECONDS never go through prepare()/mediaUrl
  // at all - they decrypt straight into a download instead of an in-memory
  // Blob that would sit around for inline <video> playback. That keeps a
  // long video from being fully buffered in the tab's memory just because
  // someone tapped it (the way short videos/images/audio still work).
  async function downloadLongVideo() {
    if (!data || downloading) return;
    setDownloading(true); setState('Decrypting…');
    try {
      const parts = [];
      for (let i = 0; i < data.total; i++) {
        parts.push(await fetchChunk(i));
        setState(`Decrypting ${Math.round(((i + 1) / data.total) * 100)}%`);
      }
      const blob = new Blob(parts, { type: data.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.name || 'video';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a moment to actually pick up the download before
      // freeing the memory backing it.
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      console.error(e);
      alert('Unable to decrypt this video for download.');
    } finally { setDownloading(false); setState(''); }
  }

  if (!data) return <div className="message-text">{encryptedText}</div>;

  if (data.kind === 'snippet') {
    return <div className="media-message snippet-message">
      {snippetText ? <>
        <div className="snippet-toolbar"><span>{(data.words || wordCount(snippetText)).toLocaleString()} words · {formatSize(data.size)}</span><button onClick={copySnippet}>{copied ? 'Copied' : 'Copy'}</button></div>
        <pre className="snippet-block">{snippetText}</pre>
      </> : <button className={`media-load-card ${loading ? 'loading' : ''}`} onClick={prepare} disabled={loading}>
        <span className="media-load-icon"><Icons.file /></span>
        <span><strong>{loading ? state : 'Tap to view long message'}</strong><small>{formatSize(data.size)} · {(data.words || 0).toLocaleString()} words · Encrypted</small></span>
        <span className="media-load-arrow">›</span>
      </button>}
    </div>;
  }

  const isVideo = data.mime?.startsWith('video/'), isImage = data.mime?.startsWith('image/'), isVoice = data.kind === 'voice', isAudio = isVoice || data.mime?.startsWith('audio/');
  const isLongVideo = isVideo && Number(data.duration) > VIDEO_INLINE_LIMIT_SECONDS;
  const downloadBtn = <button className="download-btn" onClick={downloadMedia} disabled={downloading} aria-label="Download to your computer" title="Download">{downloading ? <span className="spinner"></span> : <Icons.download />}</button>;

  if (isLongVideo) {
    return <div className="media-message">
      <button className={`media-load-card ${downloading ? 'loading' : ''}`} onClick={downloadLongVideo} disabled={downloading}>
        <span className="media-load-icon"><Icons.video /></span>
        <span><strong>{downloading ? (state || 'Decrypting…') : data.name}</strong><small>{formatSize(data.size)} · {formatDuration(data.duration)} · too long to preview here, tap to download</small></span>
        <span className="media-load-arrow"><Icons.download /></span>
      </button>
    </div>;
  }

  return <div className="media-message">
    {isVideo && mediaUrl ? <div className="video-frame"><video src={mediaUrl} controls playsInline preload="metadata" onContextMenu={e => e.preventDefault()} />{downloadBtn}</div> : null}
    {isImage && mediaUrl && !imgFailed ? <div className="image-frame"><img className="image-preview" src={mediaUrl} alt={data.name} onError={() => setImgFailed(true)} />{downloadBtn}</div> : null}
    {isImage && mediaUrl && imgFailed ? <div className="media-load-card unsupported">
      <span className="media-load-icon"><Icons.image /></span>
      <span><strong>Preview not supported</strong><small>This browser can't display {data.name} - download it to view at full quality</small></span>
      {downloadBtn}
    </div> : null}
    {isAudio && mediaUrl ? <div className="voice-player"><span className="voice-icon"><Icons.mic /></span><audio className="audio-preview" src={mediaUrl} controls />{data.duration ? <span className="voice-duration">{formatDuration(data.duration)}</span> : null}{downloadBtn}</div> : null}
    {!mediaUrl && <button className={`media-load-card ${loading ? 'loading' : ''}`} onClick={prepare} disabled={loading}>
      <span className="media-load-icon">{isVideo ? <Icons.video /> : isImage ? <Icons.image /> : <Icons.mic />}</span>
      <span><strong>{loading ? state : (isVideo ? 'Tap to play video' : isImage ? 'Tap to view image' : isVoice ? 'Tap to play voice message' : 'Tap to play audio')}</strong><small>{formatSize(data.size)}{data.duration ? ` · ${formatDuration(data.duration)}` : ''} · Encrypted on this device</small></span>
      <span className="media-load-arrow">›</span>
    </button>}
    {!isVoice && <div className="media-caption"><div className="media-type-icon">{isVideo ? <Icons.video /> : isImage ? <Icons.image /> : <Icons.file />}</div><div><strong>{data.name}</strong><span>{formatSize(data.size)} · Encrypted media</span></div>{!mediaUrl && <button className="download-btn caption-download" onClick={downloadMedia} disabled={downloading || loading} aria-label="Download to your computer" title="Download">{downloading ? <span className="spinner"></span> : <Icons.download />}</button>}</div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
