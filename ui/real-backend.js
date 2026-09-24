/* real-backend.js — Tauri-backed implementation of the Backend interface.
 * Talks to a local OpenAI-compatible server through Rust commands, persists
 * settings, opens save dialogs, and renders PDFs to PNGs locally.
 * Selected by backend.js only when running inside Tauri.
 */

const TauriBackend = (() => {
  const tauri = window.__TAURI__ || {};
  const invoke = tauri.core?.invoke;
  const listen = tauri.event?.listen;

  const cfg = { baseUrl: "http://localhost:13305", apiKey: "", efficient: false };
  function configure(c) {
    if (c.baseUrl != null) cfg.baseUrl = c.baseUrl;
    if (c.apiKey != null) cfg.apiKey = c.apiKey;
    if (c.efficient != null) cfg.efficient = !!c.efficient;
  }

  // ------------------------------------------------------------------
  // PDF → PNG via vendored pdf.js
  // ------------------------------------------------------------------
  let pdfjs = null;
  async function ensurePdfjs() {
    if (!pdfjs) {
      pdfjs = await import("./vendor/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";
    }
    return pdfjs;
  }

  function renderPage(page, scale) {
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    return page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise.then(() => canvas);
  }
  // PNG bytes go to Rust as a raw IPC body: no base64 strings in the webview heap.
  function canvasPng(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob
      ? blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)), reject)
      : reject(new Error("PNG encoding failed")), "image/png"));
  }
  function releaseCanvas(canvas) { canvas.width = 0; canvas.height = 0; }
  const utf8Base64 = (text) => btoa(Array.from(new TextEncoder().encode(text), b => String.fromCharCode(b)).join(""));
  const storePng = (sessionId, index, kind, bytes) =>
    invoke("store_page_png", bytes, { headers: { "x-session": sessionId, "x-index": String(index), "x-kind": kind } });

  async function renderAndStore(page, sessionId, index, kind, scale) {
    const canvas = await renderPage(page, scale);
    try { await storePng(sessionId, index, kind, await canvasPng(canvas)); }
    finally { releaseCanvas(canvas); }
  }

  // pdf.js sessions keep the source File (a disk-backed blob) so Efficient mode
  // can render full-size pages later, just before they are sent.
  let pdfSource = null; // { sessionId, file, targetPx }

  // Scale (pdf.js units: 1 = 72 DPI) at which a page renders to about targetPx
  // pixels; mirrors dpi_for_target in main.rs, including its 30–600 DPI bounds.
  function scaleForTarget(page, targetPx) {
    const vp = page.getViewport({ scale: 1 });
    const scale = Math.sqrt(targetPx / Math.max(vp.width * vp.height, 1));
    return Math.min(600 / 72, Math.max(30 / 72, scale));
  }

  // targetPx: pixels per full-size page (the model's measured image budget).
  async function convertPdf(file, targetPx) {
    const efficient = cfg.efficient;
    try {
      const native = await invoke("render_pdf_mupdf", new Uint8Array(await file.arrayBuffer()), {
        headers: { "x-file-name": utf8Base64(file.name), "x-target-px": String(Math.round(targetPx)), "x-efficient": efficient ? "1" : "0" },
      });
      if (Array.isArray(native?.pages) && native.pages.length) {
        pdfSource = null;
        return native.pages.map(page => ({ ...page, sessionId: page.session_id }));
      }
    } catch (err) { console.info("MuPDF couldn't render this PDF; using pdf.js:", err); }
    const lib = await ensurePdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const { session_id } = await invoke("begin_pdf_render", { fileName: file.name, targetPx: Math.round(targetPx), efficient });
    pdfSource = { sessionId: session_id, file, targetPx };
    const pages = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const scale = scaleForTarget(page, targetPx);
        try {
          // Efficient mode stores thumbnails only; full pages render on demand.
          if (!efficient) await renderAndStore(page, session_id, i - 1, "full", scale);
          await renderAndStore(page, session_id, i - 1, "thumb", 220 / page.getViewport({ scale: 1 }).width);
        } finally { page.cleanup?.(); }
        pages.push({ index: i - 1, label: `${file.name} · page ${i}`, dpi: Math.round(scale * 72), sessionId: session_id });
      }
      return pages;
    } catch (err) { await invoke("clear_pdf_render", { sessionId: session_id }).catch(() => {}); throw err; }
    finally { await doc.destroy(); }
  }

  // Full-size pages render one at a time across all concurrent batches, so at
  // most one large canvas exists at once.
  let renderQueue = Promise.resolve();
  function ensureFullPages(pages) {
    const job = renderQueue.then(async () => {
      if (!pages.length) return;
      const sessionId = pages[0].sessionId;
      const missing = await invoke("ensure_full_pages", { sessionId, indices: pages.map(p => p.index) });
      if (!missing.length) return; // already on disk, or rendered by MuPDF
      if (pdfSource?.sessionId !== sessionId) throw new Error("PDF source is no longer available — reload the PDF");
      const lib = await ensurePdfjs();
      const doc = await lib.getDocument({ data: new Uint8Array(await pdfSource.file.arrayBuffer()) }).promise;
      try {
        for (const index of missing) {
          const page = await doc.getPage(index + 1);
          try { await renderAndStore(page, sessionId, index, "full", scaleForTarget(page, pdfSource.targetPx)); }
          finally { page.cleanup?.(); }
        }
      } finally { await doc.destroy(); }
    });
    renderQueue = job.catch(() => {});
    return job;
  }

  const thumbnail = (page) => invoke("page_thumbnail", { sessionId: page.sessionId, index: page.index });
  async function preview(page) {
    // Efficient mode may delete a page right after sending it; render again if so.
    for (let attempt = 0; ; attempt++) {
      await ensureFullPages([page]);
      try { return await invoke("page_preview", { sessionId: page.sessionId, index: page.index }); }
      catch (err) { if (attempt > 0) throw err; }
    }
  }
  const clearPdf = (sessionId) => invoke("clear_pdf_render", { sessionId: sessionId ?? null }).catch(() => {});

  // ------------------------------------------------------------------
  // OpenAI-compatible server endpoints (via Rust commands)
  // ------------------------------------------------------------------
  const call = (cmd, args) => invoke(cmd, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, ...args });

  const _state = { loadedModel: null };

  async function health() {
    const h = await call("health", {});
    _state.loadedModel = h.model_loaded ?? _state.loadedModel ?? null;
    return h;
  }

  async function listModels() {
    const rows = await call("list_models", {});
    return rows.map(r => (typeof r === "string" ? r : r.id)).filter(Boolean);
  }

  async function loadModel(modelName, opts = {}) {
    // opts: { ctx_size, llamacpp_backend, llamacpp_args, merge_args, save_options }
    const { ctx_size, ...options } = opts;
    const r = await call("load_model", { modelName, ctxSize: ctx_size ?? null, options });
    if (r.status === "error") throw new Error(r.message || "load failed");
    _state.loadedModel = modelName;
    return r;
  }

  async function unloadModel() {
    const r = await call("unload_model", {});
    _state.loadedModel = null;
    return r;
  }

  // Prompt tokens the server counts for one message (non-streaming, 1 output
  // token). Used to measure the loaded model's image token budget.
  const promptTokens = (model, content) => call("measure_prompt_tokens", {
    payload: { model, stream: false, max_tokens: 1, messages: [{ role: "user", content }] },
  });

  // Local Tauri telemetry; no inference-server endpoint is required.
  const systemStats = () => invoke("system_stats");

  // ------------------------------------------------------------------
  // Streaming chat — Rust emits "chat-stream" events per token
  // ------------------------------------------------------------------
  async function* streamBatch({ batch, instruction, params, signal }) {
    // Efficient mode renders this batch's full-size pages now (no-op when cached).
    await ensureFullPages(batch);
    if (signal.aborted) throw new DOMException("cancelled", "AbortError");
    const id = crypto.randomUUID();
    const queue = [];
    let notify = null;
    const push = (ev) => { queue.push(ev); if (notify) { notify(); notify = null; } };

    const unlisten = await listen("chat-stream", (e) => {
      const p = e.payload;
      if (!p || p.id !== id) return;
      if (p.kind === "thinking" || p.kind === "output") {
        push({ type: p.kind, text: p.text });
      } else if (p.kind === "stats") {
        const s = p.stats || {};
        // llama.cpp per-request timings (preferred) or Lemonade /v1/stats shape
        const tokens = s.predicted_n ?? s.output_tokens ?? 0;
        const tps = s.predicted_per_second ?? s.tokens_per_second;
        const ttftMs = s.prompt_ms ?? (s.time_to_first_token != null ? s.time_to_first_token * 1000 : null);
        // Prefill: prompt tokens processed (images included) and their speed.
        const promptTokens = s.prompt_n ?? s.input_tokens ?? s.prompt_tokens ?? null;
        const prefill = s.prompt_per_second
          ?? (promptTokens && ttftMs ? promptTokens / (ttftMs / 1000) : null);
        push({ type: "stats", stats: {
          tokens,
          tokPerSec: tps != null ? Number(tps).toFixed(1) : "?",
          ttftMs: ttftMs != null ? Math.round(ttftMs) : "?",
          promptTokens,
          prefillPerSec: prefill != null ? Number(prefill).toFixed(1) : null,
        }});
      } else if (p.kind === "done") {
        push({ type: "end" });
      } else if (p.kind === "error") {
        push({ type: "error", message: p.message || "unknown error" });
      }
    });

    const messages = [{
      role: "user",
      content: [
        { type: "text", text: instruction },
        
      ],
    }];
    // Sampling overrides are opt-in. With the toggle off and thinking effort
    // at "Model default", requests contain only model, messages/images, and
    // stream (plus app-local session_id).
    const payload = {
      model: params.model,
      messages,
      stream: true,
      session_id: batch[0]?.sessionId,
      ...params.extra, // thinking-effort fields (reasoning_effort / chat_template_kwargs)
    };
    if (params.sendParams) {
      Object.assign(payload, {
        temperature: params.temperature,
        top_p: params.top_p,
        top_k: params.top_k,
        min_p: params.min_p,
        repeat_penalty: params.repeat_penalty,
        presence_penalty: params.presence_penalty,
        ...(params.seed != null && { seed: params.seed }),
      });
    }

    signal.addEventListener("abort", () => {
      invoke("chat_cancel", { id }).catch(() => {});
      push({ type: "aborted" });
    }, { once: true });

    try {
      await call("chat_stream", { id, payload, pageIndices: batch.map(p => p.index) });
      for (;;) {
        while (queue.length === 0) await new Promise(r => (notify = r));
        const ev = queue.shift();
        if (ev.type === "end") return;
        if (ev.type === "aborted") throw new DOMException("cancelled", "AbortError");
        if (ev.type === "error") throw new Error(ev.message);
        yield ev;
      }
    } finally {
      unlisten();
    }
  }

  // ------------------------------------------------------------------
  // Persistence + saving (Rust: app-data dir, native dialogs)
  // ------------------------------------------------------------------
  async function loadPersisted() {
    const p = await invoke("read_persisted");
    return {
      settings: p.settings && typeof p.settings === "object" ? p.settings : null,
      instructions: p.instructions && typeof p.instructions === "object" ? p.instructions : null,
    };
  }
  const persistSettings = (s) => invoke("write_settings", { data: s }).catch(() => {});
  const persistInstructions = (i) => invoke("write_instructions", { data: i }).catch(() => {});
  const saveOutputs = (merged, files) => invoke("save_outputs", { merged, files });

  return { convertPdf, thumbnail, preview, clearPdf, health, listModels, loadModel, unloadModel, systemStats, streamBatch, promptTokens,
           loadPersisted, persistSettings, persistInstructions, saveOutputs, configure, _state };
})();
