/* stub.js — mock backend used when running in a plain browser (no Tauri).
 * Implements the same interface as real-backend.js so the UI is identical
 * against either. `Backend` is assigned in backend.js.
 */

const StubBackend = (() => {
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  const state = {
    loadedModel: null,
    models: [
      { id: "Qwen2.5-VL-7B-Instruct-GGUF", labels: ["vision"] },
      { id: "Qwen3-VL-8B-Instruct-GGUF", labels: ["vision", "reasoning"] },
      { id: "user.InternVL3-8B-GGUF", labels: ["vision"] },
      { id: "Gemma-3-4b-it-GGUF", labels: ["vision"] },
    ],
  };

  // --- PDF → PNG (mock): fabricate page count + placeholder page data ---
  async function convertPdf(file, targetPx) {
    await delay(600); // pretend conversion time
    const name = typeof file === "string" ? file : file.name;
    // 6–12 pages, stable per file name so re-renders keep the same page count
    const count = 6 + [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 7;
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      label: `${name} · page ${i + 1}`,
      dpi: Math.round(72 * Math.sqrt(targetPx / (612 * 792))),
      full: null,   // real backend fills these with data URLs
      thumb: null,
    }));
  }

  // --- GET /v1/health ---
  async function health(baseUrl, apiKey) {
    await delay(250);
    return {
      status: "ok",
      model_loaded: state.loadedModel,
      all_models_loaded: state.loadedModel
        ? [{ model_name: state.loadedModel, device: "gpu" }]
        : [],
    };
  }

  // --- GET /v1/models ---
  async function listModels(baseUrl, apiKey) {
    await delay(300);
    return state.models.map(m => m.id);
  }

  // --- POST /v1/load ---
  async function loadModel(modelName, opts = {}) {
    if (!modelName) throw new Error("no model selected");
    await delay(1200); // loading a VLM takes a moment
    state.loadedModel = modelName;
    return { status: "success", message: `Loaded model: ${modelName}` };
  }

  // --- POST /v1/unload ---
  async function unloadModel() {
    await delay(400);
    state.loadedModel = null;
    return { status: "success", message: "Model unloaded successfully" };
  }

  // --- GET /v1/system-stats (mock, with gentle drift so polling looks alive) ---
  const sys = { ram: 9.2, vram: 3.4, gpu: 12 };
  async function systemStats(baseUrl, apiKey) {
    await delay(120);
    const drift = (v, lo, hi, step) => Math.min(hi, Math.max(lo, v + (Math.random() - 0.5) * step));
    sys.ram = drift(sys.ram, 6, 28, 0.6);
    sys.vram = drift(sys.vram, state.loadedModel ? 2.5 : 0.4, 14, 0.4);
    sys.gpu = drift(sys.gpu, 2, 98, 6);
    return {
      cpu_percent: Math.round(drift(15, 2, 90, 8) * 10) / 10,
      memory_gb: Math.round(sys.ram * 10) / 10,
      gpu_percent: Math.round(sys.gpu * 10) / 10,
      vram_gb: Math.round(sys.vram * 10) / 10,
      npu_percent: null,
    };
  }

  // --- POST /v1/chat/completions (mock streaming) ---
  // Calls onEvent({type:'thinking'|'output'|'stats', text?}) as tokens arrive.
  // Honors AbortSignal; resolves with final text on completion.
  async function* streamBatch({ batch, instruction, params, signal }) {
    const pages = batch.map(p => p.index + 1);
    const pageRange = pages.length > 1
      ? `pages ${pages[0]}–${pages[pages.length - 1]}`
      : `page ${pages[0]}`;

    const thinkingText =
      `Let me examine ${pageRange} carefully. ` +
      `The instruction says: "${instruction.slice(0, 60)}${instruction.length > 60 ? "…" : ""}" ` +
      `I should first identify the document structure, then transcribe each region in reading order, ` +
      `watching for tables, figures, and footnotes. Header rows appear consistent across these pages. `;

    const outputText =
      `# Transcription — ${pageRange}\n\n` +
      `## Page ${pages[0]}\n\n` +
      `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor ` +
      `incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud ` +
      `exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.\n\n` +
      pages.slice(1).map(p =>
        `## Page ${p}\n\nDuis aute irure dolor in reprehenderit in voluptate velit esse ` +
        `cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident.\n`
      ).join("\n");

    // phase 1: "model thinking"
    await delay(500); // TTFT
    const t0 = performance.now();
    let tokens = 0;
    if (params.extra?.chat_template_kwargs?.enable_thinking !== false) {
      for (const word of thinkingText.split(" ")) {
        if (signal.aborted) throw new DOMException("cancelled", "AbortError");
        yield { type: "thinking", text: word + " " };
        tokens++;
        await delay(18);
      }
    }

    // phase 2: answer
    for (const word of outputText.split(" ")) {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      yield { type: "output", text: word + " " };
      tokens++;
      await delay(14);
    }

    // phase 3: stats (mock GET /v1/stats)
    const elapsed = (performance.now() - t0) / 1000;
    yield {
      type: "stats",
      stats: {
        tokens,
        tokPerSec: (tokens / Math.max(elapsed, 0.1)).toFixed(1),
        ttftMs: 500,
        promptTokens: batch.length * 4096 + 40,
        prefillPerSec: ((batch.length * 4096 + 40) / 0.5).toFixed(1),
      },
    };
  }

  // --- prompt-token count (mock): behaves like a Qwen3-VL server —
  // 32×32 px per image token, capped at 4096 tokens, 20 text tokens ---
  async function promptTokens(model, content) {
    await delay(300);
    let tokens = 20;
    for (const part of content) {
      if (part.type !== "image_url") continue;
      const img = new Image();
      img.src = part.image_url.url;
      await img.decode();
      tokens += Math.min(4096, Math.round((img.naturalWidth * img.naturalHeight) / 1024)) + 2;
    }
    return tokens;
  }

  // --- persistence (localStorage in browser mode) ---
  const SETTINGS_KEY = "docproc4.settings";
  const INSTR_KEY = "docproc4.instructions";
  async function loadPersisted() {
    return {
      settings: JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"),
      instructions: JSON.parse(localStorage.getItem(INSTR_KEY) || "null"),
    };
  }
  async function persistSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
  async function persistInstructions(i) { localStorage.setItem(INSTR_KEY, JSON.stringify(i)); }

  // --- save outputs: browser download fallback ---
  async function saveOutputs(merged, files) {
    for (const f of files) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([f.content], { type: "text/markdown" }));
      a.download = f.name;
      a.click();
      URL.revokeObjectURL(a.href);
      await delay(200); // let the browser register each download
    }
    return { saved: files.map(f => f.name) };
  }

  function configure() { /* no-op in stub */ }

  return { convertPdf, promptTokens, health, listModels, loadModel, unloadModel, systemStats, streamBatch,
           loadPersisted, persistSettings, persistInstructions, saveOutputs, configure, _state: state };
})();
