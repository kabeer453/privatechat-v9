# PrivateChat V6

PrivateChat V6 is a mobile-first, browser-based private room messenger built from the previous V5 project.

## V9 (this round)

- **No two people in the same room can use the same display name.** The server now checks, at join time, whether another currently-connected device in that room already has the name you're joining with (case/whitespace-insensitive). If so, the join is rejected and you're sent back to the join screen with a message asking you to pick a different name — so messages in the room can never be ambiguous about who actually sent them. Reopening/reloading with your *own* previous name still works fine, since that's recognized as the same device reconnecting, not a clash with someone else.
- **The chat header (and the composer at the bottom) now stay fixed in place while you scroll, like WhatsApp.** Previously the whole page grew taller as the message list grew, so scrolling the chat also scrolled the header off the top of the screen. The app shell is now locked to exactly one screen's height, and only the message list itself scrolls inside it — the header, the call strip, and the message box stay pinned. This also uses the newer "dynamic viewport height" unit where the browser supports it, so it doesn't jump around when a mobile browser's address bar shows/hides.

## V8

- **Video calling.** Each online user in the call strip now has two buttons: an audio call and a video call. Video calls open a full-screen view with the remote feed, a small mirrored local camera preview, and controls to mute the mic, turn the camera on/off, flip between front/back camera, and hang up. Uses the same WebRTC connection and encrypted signaling as audio calls — a call is just "add a camera track or don't" at the point it's started.
- A completely restyled visual design: gradient accents, frosted-glass panels, layered shadows, and micro-interactions throughout (see the CSS custom properties at the top of `style.css` to retheme).
- **iPhone photos no longer look broken/degraded on Android (or anywhere else).** The app never re-compresses images — it never did — but iPhones save camera photos as HEIC by default, and most non-Apple browsers (Chrome on Android included) simply can't decode HEIC at all, which is what actually causes "photos from my iPhone look bad/broken on Android". HEIC/HEIF photos are now converted to a high-quality JPEG (quality 0.94, effectively visually lossless) client-side, before encryption, so every recipient on every platform can open them. Every other image format (JPEG, PNG, WEBP, GIF, ...) is untouched and still sent byte-for-byte at full original quality, exactly as before. Needs the new `heic2any` dependency — run `npm install` after pulling this update. If it can't be loaded for some reason, the original HEIC file is sent as a safe fallback rather than failing the upload.
- **A browser that can't display a photo now says so, instead of just showing a broken image.** Any image that fails to decode in the viewer's browser shows a clear "preview not supported, download to view" card instead of a broken-image icon.
- **Long videos are download-only.** A video's length is checked before it's ever uploaded (read from the file's own metadata, on the sender's device, without touching the network). Anything over 5 minutes skips the "decrypt the whole thing into memory and play it" path entirely and appears as a compact card — tap it and Chrome decrypts and saves it straight to Downloads, the same way any file download works. This also avoids fully buffering a large video in a phone browser's memory just to preview it. Videos under 5 minutes (and any older video sent before this change, since its length isn't known) keep playing inline as before.

## V7 fixes

- **Video playback fixed.** The old player tried progressive `MediaSource` streaming and rejected almost every real upload, because `MediaSource.isTypeSupported()` fails for a bare mime type like `video/mp4` with no codec string (what most phones/browsers report). Video now decrypts fully in the browser and plays from a Blob URL, the same reliable approach already used for images and audio.
- **Audio calls fixed.** ICE candidates that arrived before `setRemoteDescription()` finished were passed straight to `addIceCandidate()`, which many browsers reject — calls would frequently just never connect. Candidates are now queued and flushed once the remote description is set. Calls also now ring with **Accept/Decline** instead of silently auto-answering, and a caller gets a "busy" notice if the other side is already on a call.
- **No more silent WebSocket disconnects on big messages.** The server's `maxPayload` was set to the exact same number as its message-size check, so a message near that limit could pass the check but still get killed by `ws` itself (the JSON envelope around the payload always adds a few more bytes). Fixed with headroom.
- **Effectively unlimited message length.** Long pasted text/code (people sending code back and forth, huge logs, etc.) no longer has to fit in a single WebSocket frame. Past ~6000 bytes, a message is automatically sent through the same encrypted chunked-upload pipeline as files, and renders as a scrollable, copyable code block with a word count. There's no practical length ceiling short of `MAX_FILE_SIZE` (4 GiB).
- **Voice messages.** New mic button records a voice note (MediaRecorder → encrypted chunked upload) and plays back in a dedicated voice-message bubble with duration.
- Removed a dead, unreachable `/api/upload` JSON route that only ever returned an error.
- Bubble tails, a nicer recording indicator, and a ringing/accept/decline call UI for a more authentic WhatsApp feel.

## Earlier V6 changes

- Realtime WebSocket chat for internet/LAN deployment.
- AES-256-GCM room-key encryption in the browser.
- Encrypted JSONL message history with paginated loading instead of a 500-message server cap.
- Encrypted media stored as raw binary chunks instead of Base64 JSON WebSocket messages.
- 1 MiB encrypted media chunks, suitable for long videos and large files.
- WebRTC one-to-one audio calling with WebSocket signaling and a public STUN server. A TURN service is required for some restrictive networks.
- Mobile-first WhatsApp-inspired UI.
- Per-WebSocket random media access token so media endpoints are not openly accessible without a live room session.
- HTTPS/WSS-ready production behavior.

## Local development

```bat
npm install
npm run dev
```

Open `http://localhost:5173`.

For another device on the same LAN, use the host PC's LAN address, for example `http://192.168.x.x:5173`. Browser secure APIs such as microphone access generally require HTTPS on non-localhost origins.

## Production

Build the frontend:

```bat
npm run build
```

Then run the Node server:

```bat
set NODE_ENV=production
npm start
```

Put an HTTPS reverse proxy in front of the Node server and proxy WebSocket traffic for `/ws`. The browser will then automatically use `wss://` when the page is HTTPS.

## Important security note

This project uses a shared room passphrase converted into an AES-256-GCM key in each browser. The server stores ciphertext only. This is private client-side encryption, but it is **not a Signal-protocol implementation and has not been independently cryptographically audited**. Users should exchange the room passphrase and displayed security fingerprint through a trusted channel.

## Audio & video calls

Both use WebRTC with the same WebSocket signaling. STUN is configured without an API key. Some mobile/carrier/corporate networks require a TURN relay for calls to connect reliably; adding TURN is the next production-hardening step. Video calls request camera + microphone; declining camera access (or a device with no camera) will fail that call the same way declining microphone access fails an audio call — the person just needs to pick "audio call" instead.

## Media

Videos, images, audio and voice notes are all encrypted before upload. The server receives encrypted binary chunks and never receives plaintext media. The player decrypts a file's chunks fully in-browser and plays it back from a Blob URL, so it works consistently across browsers regardless of whether the file's exact codec is one the browser can stream progressively.
