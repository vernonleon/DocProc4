/* backend.js — pick the real Tauri backend inside the app,
 * the localStorage/mock stub in a plain browser. */
const Backend = (window.__TAURI__ && window.__TAURI__.core) ? TauriBackend : StubBackend;
