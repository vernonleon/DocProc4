/* app.js — DocProc4 frontend (mock backend via stub.js) */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ================= State ================= */

const state = {
  pdfName: null,          // e.g. "report.pdf"
  pages: [],              // [{index, label, dpi}]
  batchMode: "fixed",     // 'fixed' | 'visual'
  fixedN: 3,
  visualBatches: [[]],    // array of arrays of page indices; last one is "open"
  runs: [],               // ephemeral per-run panel state
  conversionVersion: 0,   // invalidates an older PDF conversion when file/mode/budget changes
  renderTargetPx: null,   // pixels per full page used by the current render
  converting: false,
  server: "unknown",      // 'unknown' | 'online' | 'offline' (last health check)
  running: false,
};

const SETTINGS_DEFAULTS = {
  theme: "cyberpunk",
  baseUrl: "http://localhost:13305",
  apiKey: "",
  model: "",
  temp: 0.7, topp: 0.9, topk: 40, minp: 0.05,
  repeatPenalty: 1.1, presencePenalty: 0,
  seed: "", // "" = random (not sent)
  batchZoom: 165,
  conc: 2, sendParams: false,
  saveMode: "merged",
  efficientMode: false,
  // llama.cpp load options (Lemonade /v1/load); opt-in like sampling params
  lcEnabled: false, lcCtx: "", lcBackend: "", lcArgs: "", lcMerge: true, lcSave: false,
  thinkingEffort: "", // "" = model default (nothing sent); see THINKING
  loadPresets: {}, paramPresets: {},
  outputView: "rendered", // 'rendered' | 'raw'
  collapsed: {},          // collapsed Tab 3 cards, by data-card key
  imageBudgets: {},       // measured per-model image budgets, keyed by server + model
  lastTargetPx: null,     // most recent measured budget, used before a model is known
};
const LEGACY_SETTINGS = ["thinking", "avoidRepetition", "dpi"]; // removed options
const LOAD_PRESET_KEYS = ["conc", "thinkingEffort", "lcEnabled", "lcCtx", "lcBackend", "lcArgs", "lcMerge", "lcSave"];
const PARAM_PRESET_KEYS = ["sendParams", "temp", "topk", "topp", "minp", "repeatPenalty", "presencePenalty", "seed"];

/* populated from Backend.loadPersisted() during init */
const settings = { ...SETTINGS_DEFAULTS };
const instructionSets = {};
// Native rendering owns one active disk cache. Serialize conversions so an
// older render can never replace the cache selected by a newer file/mode/budget.
let pdfConversionQueue = Promise.resolve();
function convertPdfSerialized(file, targetPx) {
  const job = pdfConversionQueue.then(() => Backend.convertPdf(file, targetPx));
  pdfConversionQueue = job.catch(() => {});
  return job;
}

// Every settings change also refreshes the step summaries and card summaries.
const saveSettings = () => { refreshDerivedUI(); return Backend.persistSettings(settings); };
const saveInstr = () => Backend.persistInstructions(instructionSets);

/* distinct per-batch colors (pills + thumbnail badges), Blade Runner friendly */
const BATCH_COLORS = [
  "#35c4d8", "#d8a848", "#e6457a", "#4ec96f", "#e07a3a",
  "#9a6ee8", "#4d8fe0", "#e04848", "#3ad8a8", "#d8d848",
];
const batchColor = (i) => BATCH_COLORS[i % BATCH_COLORS.length];

/* ================= Toasts ================= */

function toast(message, kind = "info", ms = kind === "error" ? 6500 : 3500) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  const icon = document.createElement("span");
  icon.className = "t-icon";
  icon.textContent = kind === "success" ? "✓" : kind === "error" ? "!" : "i";
  const text = document.createElement("span");
  text.textContent = message;
  el.append(icon, text);
  const close = () => {
    if (el.classList.contains("leaving")) return;
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  };
  el.addEventListener("click", close);
  setTimeout(close, ms);
  $("#toasts").appendChild(el);
  const all = $$("#toasts .toast");
  if (all.length > 4) all[0].remove();
}

/* ================= Tabs, steps & theme ================= */

function selectTab(id) {
  $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  $$(".tab-panel").forEach(p => p.classList.toggle("active", p.id === id));
  if (id === "tab3" || id === "tab4") pollSystemStats(); // refresh immediately on view
}

$$(".tab-btn").forEach(btn => btn.addEventListener("click", () => selectTab(btn.dataset.tab)));
// "Go to step" buttons in empty states and the readiness checklist
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (go) selectTab(go.dataset.goto);
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("#theme-select").value = theme;
  settings.theme = theme;
  saveSettings();
}
$("#theme-select").addEventListener("change", e => applyTheme(e.target.value));

const plural = (n, word, many = word + "s") => `${n} ${n === 1 ? word : many}`;
const currentModel = () => Backend._state.loadedModel || settings.model || "";

/** Stepper status (✓ / running / warning) and one-line summaries, plus the
 *  readiness checklist shown before the first run. */
function updateSteps() {
  const setStep = (n, status, sub) => {
    const btn = $(`.tab-btn[data-tab="tab${n}"]`);
    btn.classList.remove("done", "running", "warn");
    if (status) btn.classList.add(status);
    $(`#step${n}-sub`).textContent = sub;
    btn.title = sub;
  };
  const hasPdf = state.pages.length > 0;
  const hasInstr = $("#instruction-editor").value.trim().length > 0;
  if (state.converting) setStep(1, "running", "converting…");
  else if (!hasPdf) setStep(1, "", "no PDF yet");
  else setStep(1, hasInstr ? "done" : "", hasInstr ? `${state.pdfName} · ${state.pages.length} pp` : "add instructions");

  const batches = hasPdf ? getBatches() : [];
  const batchPages = batches.reduce((n, b) => n + b.length, 0);
  if (batches.length) setStep(2, "done", `${plural(batches.length, "batch", "batches")} · ${batchPages} pp`);
  else setStep(2, "", hasPdf ? "no batches yet" : "—");

  const model = currentModel();
  if (state.server === "offline") setStep(3, "warn", "server offline");
  else if (state.server === "online") setStep(3, model ? "done" : "", model || "pick a model");
  else setStep(3, "", model ? `${model} · not checked` : "not checked");

  const run = state.currentRun;
  if (!run) setStep(4, "", "idle");
  else {
    const total = run.batches?.length ?? 0;
    const done = run.done.filter(Boolean).length;
    const failed = failedIndices(run).length;
    if (state.running) setStep(4, "running", `running · ${done}/${total}`);
    else if (failed) setStep(4, "warn", `${failed} failed · ${done}/${total} done`);
    else if (done) setStep(4, "done", `done · ${done}/${total}`);
    else setStep(4, "", "cancelled");
  }

  const checks = [
    [hasPdf, "PDF loaded", "tab1"],
    [hasInstr, "Instructions written", "tab1"],
    [batches.length > 0, "Batches defined", "tab2"],
    [!!model, "Model selected", "tab3"],
  ];
  const list = $("#readiness");
  list.innerHTML = "";
  checks.forEach(([ok, label, tab]) => {
    const li = document.createElement("li");
    li.className = ok ? "ok" : "";
    li.append(label);
    if (!ok) {
      const go = document.createElement("button");
      go.className = "go"; go.dataset.goto = tab; go.textContent = "Go →";
      li.appendChild(go);
    }
    list.appendChild(li);
  });
}

function refreshDerivedUI() {
  updateCardSummaries();
  updateSteps();
  updateBudgetInfo();
  updateRenderNote();
}

/* ================= Tab 1: PDF & instructions ================= */

function showPdfCard() {
  const loaded = !!state.pdfName;
  $("#dropzone").hidden = loaded;
  $("#pdf-card").hidden = !loaded;
  $("#pdf-name").textContent = state.pdfName || "no file loaded";
}

function pickPdf() {
  // Browsers do not fire change when the user retries the same file after a failed conversion.
  $("#pdf-input").value = "";
  $("#pdf-input").click();
}
$("#dropzone").addEventListener("click", pickPdf);
$("#btn-open-pdf").addEventListener("click", pickPdf);

function setConverting(on) {
  state.converting = on;
  $("#pdf-spinner").hidden = !on;
  updateSteps();
}

// Convert state.pdfFile at the current image budget and cache mode, replacing
// the old render cache. reason: "load" | "mode" | "budget". Re-renders of the
// same file keep Visual-mode batches. Resolves true on success.
async function convertCurrentPdf(reason = "load") {
  const conversion = ++state.conversionVersion;
  const file = state.pdfFile;
  const oldSession = state.pages[0]?.sessionId;
  const oldCount = state.pages.length;
  const targetPx = renderTargetPx();
  if (oldSession) Backend.clearPdf?.(oldSession);
  $("#page-count").textContent = `rendering at ${fmtMP(targetPx)} per page…`;
  setConverting(true);
  try {
    const pages = await convertPdfSerialized(file, targetPx);
    if (conversion !== state.conversionVersion) return false; // superseded by a newer conversion
    state.pages = pages;
    state.renderTargetPx = targetPx;
  } catch (err) {
    if (conversion !== state.conversionVersion) return false;
    // The previous render cache was already cleared, so its pages are unusable.
    state.pages = [];
    state.renderTargetPx = null;
    $("#page-count").textContent = "conversion failed: " + err.message;
    setConverting(false);
    renderThumbs(); renderBatches();
    toast(`Couldn't convert ${file.name}: ${err.message}`, "error");
    return false;
  }
  if (reason === "load" || state.pages.length !== oldCount) state.visualBatches = [[]];
  $("#page-count").textContent = `${plural(state.pages.length, "page")} · ${fmtMP(targetPx)} each`;
  setConverting(false);
  renderThumbs(); renderBatches();
  updateSavePreview();
  refreshDerivedUI();
  const n = plural(state.pages.length, "page");
  toast(reason === "budget" ? `Re-rendered ${n} at ${fmtMP(targetPx)} to match the model's image budget`
    : reason === "mode" ? `Re-rendered ${n} in ${settings.efficientMode ? "Efficient" : "Fast"} mode`
    : `Loaded ${file.name} · ${n}`, "success");
  return true;
}

function loadPdfFile(file) {
  if (state.running) { toast("Wait for the run to finish before loading another PDF.", "error"); return; }
  state.pdfFile = file;
  state.pdfName = file.name;
  showPdfCard();
  convertCurrentPdf("load");
}

$("#pdf-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) loadPdfFile(file);
});

/* Fast (rabbit) vs Efficient (turtle) page processing, chosen in the title bar. */
function applyProcessingMode(efficient) {
  settings.efficientMode = efficient;
  Backend.configure({ efficient });
  $$(".mode-btn").forEach(b => {
    const on = (b.dataset.mode === "efficient") === efficient;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("#mode-note").textContent = efficient
    ? "Efficient mode: only thumbnails are rendered now. Full-size pages render one at a time just before they're sent, then get deleted."
    : "Fast mode: all full-size pages are rendered now and kept in /tmp (often held in RAM) until you close the PDF.";
}
$$(".mode-btn").forEach(btn => btn.addEventListener("click", () => {
  const efficient = btn.dataset.mode === "efficient";
  if (efficient === settings.efficientMode) return;
  applyProcessingMode(efficient);
  saveSettings();
  // Re-render the open document in the newly selected mode.
  if (state.pdfFile && !state.running) convertCurrentPdf("mode");
}));

function loadInstructionFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    $("#instruction-editor").value = reader.result;
    updateSteps();
    toast(`Instructions loaded from ${file.name}`, "success");
  };
  reader.onerror = () => toast(`Couldn't read ${file.name}`, "error");
  reader.readAsText(file);
}

$("#btn-open-md").addEventListener("click", () => { $("#md-input").value = ""; $("#md-input").click(); });
$("#md-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) loadInstructionFile(file);
});
$("#instruction-editor").addEventListener("input", () => updateSteps());

function refreshInstructionSelect() {
  const sel = $("#instruction-select");
  sel.innerHTML = '<option value="">— saved sets —</option>';
  Object.keys(instructionSets).sort().forEach(name => {
    const opt = document.createElement("option");
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  });
}

$("#instruction-select").addEventListener("change", (e) => {
  const name = e.target.value;
  if (name && instructionSets[name] != null) {
    $("#instruction-editor").value = instructionSets[name];
    updateSteps();
  }
});

$("#btn-save-instruction").addEventListener("click", () => {
  const name = prompt("Name for this instruction set:", $("#instruction-select").value);
  if (!name) return;
  instructionSets[name] = $("#instruction-editor").value;
  saveInstr(); refreshInstructionSelect();
  $("#instruction-select").value = name;
  toast(`Saved instruction set "${name}"`, "success");
});

$("#btn-delete-instruction").addEventListener("click", () => {
  const name = $("#instruction-select").value;
  if (!name) return;
  if (!confirm(`Delete instruction set "${name}"?`)) return;
  delete instructionSets[name];
  saveInstr(); refreshInstructionSelect();
  toast(`Deleted instruction set "${name}"`);
});

/* ---- drag & drop anywhere in the window ---- */
let dragDepth = 0;
const draggingFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("#drop-overlay").hidden = false;
});
window.addEventListener("dragover", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (e) => {
  if (!draggingFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $("#drop-overlay").hidden = true; }
});
window.addEventListener("drop", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  handleDroppedFiles([...e.dataTransfer.files]);
});

function handleDroppedFiles(files) {
  const pdf = files.find(f => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  const text = files.find(f => /\.(md|markdown|txt)$/i.test(f.name));
  if (!pdf && !text) { toast("Drop a PDF, or a .md or .txt file for instructions.", "error"); return; }
  if (pdf) loadPdfFile(pdf);
  if (text) loadInstructionFile(text);
  selectTab("tab1");
}

/* ================= Tab 2: batching ================= */

$$('input[name="batch-mode"]').forEach(r => r.addEventListener("change", (e) => {
  state.batchMode = e.target.value;
  $("#tab2").dataset.mode = state.batchMode;
  const visual = state.batchMode === "visual";
  $("#visual-hint").hidden = !visual;
  $("#btn-next-batch").hidden = !visual;
  $("#btn-clear-batches").hidden = !visual;
  decorateThumbs(); renderBatches();
}));

$("#fixed-n").addEventListener("change", (e) => {
  state.fixedN = clampInt(e.target.value, 1, 20, 3);
  e.target.value = state.fixedN;
  decorateThumbs(); renderBatches();
});

$("#btn-next-batch").addEventListener("click", () => {
  const open = state.visualBatches[state.visualBatches.length - 1];
  if (open.length === 0) return;
  state.visualBatches.push([]);
  decorateThumbs(); renderBatches();
});

$("#btn-clear-batches").addEventListener("click", () => {
  state.visualBatches = [[]];
  decorateThumbs(); renderBatches();
});

function applyBatchZoom(value) {
  const zoom = clampInt(value, 100, 320, 165);
  settings.batchZoom = zoom;
  // Keep this CSS variable on the batching strip, not the document root.
  // This control can only resize .thumb elements inside the batch panel.
  $("#thumb-strip").style.setProperty("--batch-thumb-width", zoom + "px");
  $("#batch-zoom").value = zoom;
  $("#batch-zoom-value").textContent = zoom + " px";
}
$("#batch-zoom").addEventListener("input", e => applyBatchZoom(e.target.value));
$("#batch-zoom").addEventListener("change", () => saveSettings());

function getBatches() {
  if (state.batchMode === "fixed") {
    const out = [];
    for (let i = 0; i < state.pages.length; i += state.fixedN)
      out.push(state.pages.slice(i, i + state.fixedN).map(p => p.index));
    return out;
  }
  return state.visualBatches.filter(b => b.length > 0);
}

function drawPlaceholder(canvas, pageNum, scale = 1) {
  const w = 220, h = 285; // ~A-series ratio
  canvas.width = w * scale; canvas.height = h * scale;
  const c = canvas.getContext("2d");
  c.scale(scale, scale);
  const cs = getComputedStyle(document.documentElement);
  c.fillStyle = cs.getPropertyValue("--bg-inset").trim() || "#111";
  c.fillRect(0, 0, w, h);
  c.strokeStyle = cs.getPropertyValue("--border").trim() || "#333";
  c.strokeRect(4, 4, w - 8, h - 8);
  c.fillStyle = cs.getPropertyValue("--muted").trim() || "#888";
  for (let y = 30; y < h - 40; y += 16) {           // fake text lines
    const lineW = w - 40 - Math.random() * 60;
    c.fillRect(20, y, lineW, 5);
  }
  c.fillStyle = cs.getPropertyValue("--accent").trim() || "#0ff";
  c.font = "bold 28px monospace";
  c.textAlign = "center";
  c.fillText(String(pageNum), w / 2, h / 2 + 10);
}

// Efficient mode: fetch a thumbnail only when it scrolls near the viewport,
// and drop its image data again once it is far off-screen.
let thumbObserver = null;
function observeThumb(img, p) {
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver((entries) => {
      entries.forEach(({ target, isIntersecting }) => {
        if (!isIntersecting) { target.removeAttribute("src"); return; }
        const page = target._page;
        Backend.thumbnail(page)
          .then(src => { if (target.isConnected && target._page === page) target.src = src; })
          .catch(() => {});
      });
    }, { root: $("#thumb-strip"), rootMargin: "400px 0px" });
  }
  img._page = p;
  // Remember the real page shape so unloading the image does not resize the tile.
  img.addEventListener("load", () => { img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`; }, { once: true });
  thumbObserver.observe(img);
}

/* Visual-mode selection: click toggles one page, dragging across pages selects
 * a range (adds, or removes when the drag starts on an assigned page), and
 * Shift-click adds everything between the last picked page and this one. */
let dragSel = null; // { anchor, current, remove }
let lastPick = null;

const assignedBatch = (index) => state.visualBatches.findIndex(b => b.includes(index));
function rangeIndices(a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return state.pages.map(p => p.index).filter(i => i >= lo && i <= hi);
}
function previewSelection() {
  const lo = dragSel ? Math.min(dragSel.anchor, dragSel.current) : -1;
  const hi = dragSel ? Math.max(dragSel.anchor, dragSel.current) : -2;
  $$("#thumb-strip .thumb").forEach(t => {
    const i = Number(t.dataset.index);
    const inRange = i >= lo && i <= hi;
    t.classList.toggle("sel-preview", inRange);
    t.classList.toggle("removing", inRange && !!dragSel?.remove);
  });
}
function applyRange(indices, remove) {
  if (remove) {
    state.visualBatches.forEach(b => indices.forEach(i => { const at = b.indexOf(i); if (at !== -1) b.splice(at, 1); }));
  } else {
    const open = state.visualBatches[state.visualBatches.length - 1];
    indices.forEach(i => { if (assignedBatch(i) === -1) open.push(i); });
  }
  // Drop batches emptied by removals so the remaining ones stay numbered B1, B2, …
  const open = state.visualBatches[state.visualBatches.length - 1];
  state.visualBatches = [...state.visualBatches.slice(0, -1).filter(b => b.length), open];
  decorateThumbs(); renderBatches();
}
window.addEventListener("pointerup", () => {
  if (!dragSel) return;
  const { anchor, current, remove } = dragSel;
  dragSel = null;
  previewSelection();
  applyRange(rangeIndices(anchor, current), remove);
  lastPick = current;
});

/** Build page tiles (only when the page list changes). */
function renderThumbs() {
  const strip = $("#thumb-strip");
  thumbObserver?.disconnect();
  strip.innerHTML = "";
  lastPick = null;

  state.pages.forEach(p => {
    const div = document.createElement("div");
    div.className = "thumb";
    div.dataset.index = p.index;
    if (p.sessionId && Backend.thumbnail) {
      const img = document.createElement("img");
      img.alt = p.label; img.loading = "lazy"; img.draggable = false;
      if (settings.efficientMode) {
        img.classList.add("lazy-thumb");
        observeThumb(img, p);
      } else {
        Backend.thumbnail(p).then(src => { if (div.isConnected) img.src = src; }).catch(() => {});
      }
      div.appendChild(img);
    } else if (p.thumb) {
      const img = document.createElement("img"); img.src = p.thumb; img.alt = p.label; img.loading = "lazy"; img.draggable = false;
      div.appendChild(img);
    } else {
      const cv = document.createElement("canvas");
      drawPlaceholder(cv, p.index + 1);
      div.appendChild(cv);
    }
    div.insertAdjacentHTML("beforeend", `<div class="tint"></div><div class="stripe"></div>
      <div class="pnum">p. ${p.index + 1}</div><div class="badge" hidden></div>`);
    const zb = document.createElement("button");
    zb.className = "zoom-btn";
    zb.title = "Zoom";
    zb.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>';
    zb.addEventListener("click", (e) => { e.stopPropagation(); openZoom(p); });
    div.appendChild(zb);
    div.addEventListener("dblclick", () => openZoom(p));
    div.addEventListener("pointerdown", (e) => {
      if (state.batchMode !== "visual" || e.button !== 0 || e.target.closest(".zoom-btn")) return;
      e.preventDefault();
      if (e.shiftKey && lastPick != null) {
        applyRange(rangeIndices(lastPick, p.index), false);
        lastPick = p.index;
        return;
      }
      dragSel = { anchor: p.index, current: p.index, remove: assignedBatch(p.index) !== -1 };
      previewSelection();
    });
    div.addEventListener("pointerenter", () => {
      if (!dragSel) return;
      dragSel.current = p.index;
      previewSelection();
    });
    strip.appendChild(div);
  });

  const any = state.pages.length > 0;
  strip.hidden = !any;
  $("#thumb-empty").hidden = any;
  $("#thumb-summary").textContent = any ? `· ${plural(state.pages.length, "page")}` : "";
  decorateThumbs();
}

/** Batch colors, stripes, and badges on existing tiles. */
function decorateThumbs() {
  const assignment = {}; // pageIndex -> 0-based batch number
  (state.batchMode === "visual" ? state.visualBatches : getBatches())
    .forEach((b, bi) => b.forEach(pi => { assignment[pi] = bi; }));
  $$("#thumb-strip .thumb").forEach(t => {
    const bi = assignment[Number(t.dataset.index)];
    const badge = t.querySelector(".badge");
    const on = bi != null;
    t.classList.toggle("assigned", on);
    badge.hidden = !on;
    if (on) {
      t.style.setProperty("--bc", batchColor(bi));
      badge.textContent = `B${bi + 1}`;
    } else {
      t.style.removeProperty("--bc");
    }
  });
}

async function openZoom(p) {
  const lb = $("#lightbox"); if (!lb) return;
  const img = $("#lightbox-img");
  lb.hidden = false;
  try {
    img.src = p.sessionId && Backend.preview ? await Backend.preview(p) : (p.full || "");
  } catch { img.removeAttribute("src"); }
}
function closeZoom() { const lb = $("#lightbox"); if (!lb) return; lb.hidden = true; $("#lightbox-img").removeAttribute("src"); }

$("#lightbox")?.addEventListener("click", closeZoom);
document.addEventListener("keydown", (e) => {
  const lb = $("#lightbox");
  if (e.key === "Escape" && lb) closeZoom();
});

function renderBatches() {
  const wrap = $("#batch-pills");
  wrap.innerHTML = "";
  const batches = getBatches();
  const visual = state.batchMode === "visual" && state.pages.length > 0;
  const open = state.visualBatches[state.visualBatches.length - 1];
  const addPill = (i, text, isOpen) => {
    const pill = document.createElement("span");
    pill.className = "bpill" + (isOpen ? " open" : "");
    pill.textContent = text;
    pill.style.color = batchColor(i);
    pill.style.borderColor = batchColor(i);
    wrap.appendChild(pill);
  };
  batches.forEach((b, i) => {
    const pages = b.map(x => x + 1);
    const range = pages.length > 1 ? `p.${pages[0]}–${pages[pages.length - 1]}` : `p.${pages[0]}`;
    const isOpen = visual && b === open;
    addPill(i, `Batch ${i + 1} · ${range}${isOpen ? " (open)" : ""}`, isOpen);
  });
  // An empty open batch still gets a pill so it's clear where clicks go next.
  if (visual && !open.length) addPill(batches.length, `Batch ${batches.length + 1} (open) · click pages to add`, true);
  updateSavePreview();
  updateSteps();
}

/* ================= Image budget (per model) =================
 * Pages are rendered to the pixel count the loaded model can actually use.
 * No server reports that directly, so it is measured: the prompt-token cost
 * of synthetic test images gives pixels per token and the per-image token cap.
 * Results are cached per server + model. */

// Used until a model has been measured, and for fixed-resolution models:
// 4096 image tokens × 32×32 px (Qwen3-VL-style dynamic resolution).
const DEFAULT_TARGET_PX = 4096 * 32 * 32;
const PROBE_SIDES = [1024, 1448, 4096]; // ~1 MP, ~2 MP (twice the area), ~16.8 MP

const fmtMP = (px) => `${(px / 1e6).toFixed(1)} MP`;
const letterDpi = (px) => Math.round(72 * Math.sqrt(px / (612 * 792)));
const serverKey = () => settings.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
const budgetKey = (model) => `${serverKey()} ${model}`;
const budgetFor = (model) => (model ? settings.imageBudgets[budgetKey(model)] ?? null : null);
const renderTargetPx = () => budgetFor(currentModel())?.targetPx ?? settings.lastTargetPx ?? DEFAULT_TARGET_PX;
const pageTokenEstimate = () => budgetFor(currentModel())?.tokens ?? 4096;

/** Synthetic page-like PNG (white with dark text lines) of side × side pixels. */
function probeImage(side) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = side;
  const c = canvas.getContext("2d");
  c.fillStyle = "#fff";
  c.fillRect(0, 0, side, side);
  c.fillStyle = "#222";
  const line = Math.max(4, Math.round(side / 90));
  for (let y = line * 3; y < side - line * 3; y += line * 2.2)
    c.fillRect(line * 3, y, side - line * (6 + ((y / line) % 7) * 3), line);
  const url = canvas.toDataURL("image/png");
  canvas.width = canvas.height = 0;
  return url;
}

async function measureImageBudget(model) {
  const text = { type: "text", text: "What is in this image?" };
  const count = (content) => Backend.promptTokens(model, content);
  const base = await count([text]);
  const imageTokens = async (side) =>
    (await count([text, { type: "image_url", image_url: { url: probeImage(side) } }])) - base;
  const [sa, sb, sc] = PROBE_SIDES;
  const a = await imageTokens(sa);
  const b = await imageTokens(sb);
  let c = null, cError = "";
  try { c = await imageTokens(sc); } catch (err) { cError = err.message || String(err); }
  const near = (x, y, tol) => Math.abs(x - y) <= tol * Math.max(Math.abs(x), Math.abs(y));
  const measuredAt = new Date().toISOString();

  // Dynamic resolution: doubling the area roughly doubles the tokens.
  if (a > 0 && near(b / a, (sb * sb) / (sa * sa), 0.2)) {
    const pxPerToken = (sb * sb) / b;
    if (c == null)
      return { kind: "fallback", targetPx: DEFAULT_TARGET_PX, pxPerToken, measuredAt,
        reason: `the oversized test image failed (${cError})` };
    const capPx = c * pxPerToken;
    if (capPx < sc * sc * 0.95)
      return { kind: "measured", tokens: c, pxPerToken, targetPx: Math.round(capPx), measuredAt };
    return { kind: "uncapped", tokens: c, pxPerToken, targetPx: sc * sc, measuredAt,
      reason: `no image cap found up to ${fmtMP(sc * sc)}` };
  }
  // Fixed resolution: every image costs the same number of tokens.
  if (a > 0 && near(a, b, 0.03) && (c == null || near(a, c, 0.03)))
    return { kind: "fixed", tokens: a, targetPx: DEFAULT_TARGET_PX, measuredAt,
      reason: "fixed-resolution model (same token count at every image size)" };
  return { kind: "fallback", targetPx: DEFAULT_TARGET_PX, measuredAt,
    reason: `unexpected token counts (${a}, ${b}${c != null ? `, ${c}` : ""})` };
}

let budgetJob = null; // { key, promise } while a measurement runs
/** Cached budget for `model`, measuring it first if needed (or when forced).
 *  Resolves null if the measurement itself fails. */
function ensureImageBudget(model, force = false) {
  if (!model) return Promise.resolve(null);
  const key = budgetKey(model);
  if (!force && settings.imageBudgets[key]) return Promise.resolve(settings.imageBudgets[key]);
  if (budgetJob?.key === key) return budgetJob.promise;
  const promise = (async () => {
    $("#budget-info").textContent = `Measuring the image budget for ${model}…`;
    $("#btn-measure").disabled = true;
    try {
      const budget = await measureImageBudget(model);
      settings.imageBudgets = { ...settings.imageBudgets, [key]: budget };
      settings.lastTargetPx = budget.targetPx;
      saveSettings();
      if (budget.kind === "measured")
        toast(`Image budget for ${model}: ${budget.tokens} tokens · ${fmtMP(budget.targetPx)} per page`, "success");
      else
        toast(`Image budget for ${model}: using ${fmtMP(budget.targetPx)} — ${budget.reason}`);
      return budget;
    } catch (err) {
      toast(`Couldn't measure the image budget for ${model}: ${err.message || err}`, "error");
      return null;
    } finally {
      budgetJob = null;
      $("#btn-measure").disabled = false;
      refreshDerivedUI();
    }
  })();
  budgetJob = { key, promise };
  return promise;
}

/** Re-render the open PDF when its pages were rendered for a different budget. */
async function rerenderForBudget() {
  if (!state.pdfFile || !state.pages.length || state.renderTargetPx == null) return true;
  const target = renderTargetPx();
  if (Math.abs(target - state.renderTargetPx) / target < 0.02) return true;
  return convertCurrentPdf("budget");
}

function updateBudgetInfo() {
  const model = currentModel();
  const b = budgetFor(model);
  const el = $("#budget-info");
  if (budgetJob) return; // "measuring…" stays until it finishes
  if (!model) el.textContent = "Image budget: pick a model first.";
  else if (!b) el.textContent = `Image budget: not measured yet. It's measured automatically when you Load or Start.`;
  else if (b.kind === "measured")
    el.textContent = `Image budget: ${b.tokens} tokens × ${Math.round(b.pxPerToken)} px ≈ ${fmtMP(b.targetPx)} per page (≈${letterDpi(b.targetPx)} DPI on Letter) · measured ${new Date(b.measuredAt).toLocaleDateString()}`;
  else el.textContent = `Image budget: using ${fmtMP(b.targetPx)} per page (≈${letterDpi(b.targetPx)} DPI on Letter) — ${b.reason}`;
  el.title = model ? `Cached for ${budgetKey(model)}` : "";
}

function updateRenderNote() {
  const target = renderTargetPx();
  const b = budgetFor(currentModel());
  const source = b ? `the image budget measured for ${currentModel()}`
    : settings.lastTargetPx ? "the last measured image budget" : "a default until a model is measured";
  let text = `Pages render at ${fmtMP(target)} (≈${letterDpi(target)} DPI on Letter), from ${source}.`;
  if (state.renderTargetPx != null && Math.abs(target - state.renderTargetPx) / target >= 0.02)
    text += ` This PDF was rendered at ${fmtMP(state.renderTargetPx)} and will be re-rendered when you Start.`;
  $("#render-note").textContent = text;
}

/* ================= Tab 3: server / model / params ================= */

async function checkHealth() {
  const pill = $("#health-pill");
  pill.textContent = "checking…"; pill.className = "pill unknown";
  try {
    const h = await Backend.health(settings.baseUrl, settings.apiKey);
    const online = h.status === "ok" || h.status == null;
    pill.textContent = online ? "online" : h.status;
    pill.className = "pill " + (online ? "ok" : "err");
    state.server = online ? "online" : "offline";
    updateLoadedPill(h);
    updateSteps();
    return online;
  } catch {
    pill.textContent = "offline"; pill.className = "pill err";
    state.server = "offline";
    updateSteps();
    return false;
  }
}
$("#btn-health").addEventListener("click", async () => {
  const online = await checkHealth();
  toast(online ? "Server is online" : `Can't reach ${settings.baseUrl}`, online ? "success" : "error");
});

$("#btn-fetch-models").addEventListener("click", async () => {
  const sel = $("#model-select");
  sel.innerHTML = '<option value="">loading…</option>';
  try {
    const models = await Backend.listModels(settings.baseUrl, settings.apiKey);
    sel.innerHTML = "";
    models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      sel.appendChild(opt);
    });
    if (settings.model && models.includes(settings.model)) sel.value = settings.model;
    toast(`Found ${plural(models.length, "model")}`, "success");
  } catch (err) {
    sel.innerHTML = '<option value="">(fetch failed)</option>';
    toast(`Couldn't fetch models: ${err.message || err}`, "error");
  }
});

$("#model-select").addEventListener("change", e => { settings.model = e.target.value; saveSettings(); });

function updateLoadedPill(healthData) {
  const loaded = Backend._state.loadedModel;
  const pill = $("#loaded-pill");
  pill.textContent = loaded ? `loaded: ${loaded}` : "none loaded";
  pill.className = "pill " + (loaded ? "ok" : "off");
  // show effective context from the server's recipe options, incl. --parallel slicing
  const info = $("#loaded-info");
  info.textContent = "";
  info.classList.remove("warn");
  const entry = healthData?.all_models_loaded?.find(m => m.model_name === loaded);
  const opts = entry?.recipe_options;
  if (entry && opts) {
    let text = `ctx ${opts.ctx_size ?? "server default"}`;
    const m = /--parallel\s+(\d+)/.exec(opts.llamacpp_args || "");
    if (m && opts.ctx_size) {
      const per = Math.floor(opts.ctx_size / parseInt(m[1], 10));
      text += ` · parallel ${m[1]} → ~${per} ctx/request`;
      if (per < pageTokenEstimate() + 2048) {
        text += " ⚠ may not fit a full-size page plus output";
        info.classList.add("warn");
      }
    }
    info.textContent = text;
  }
  updateSteps();
}

// llama.cpp flags Lemonade manages itself and rejects in llamacpp_args.
const RESERVED_LLAMACPP_FLAGS = ["-m", "--model", "--port", "-c", "--ctx-size", "-ngl", "--n-gpu-layers",
  "--gpu-layers", "--jinja", "--mmproj", "--embeddings", "--reranking"];
// Set from Concurrent evaluations instead, so client and server agree.
const PARALLEL_FLAGS = ["-np", "--parallel"];

function flagsIn(args, flags) {
  const tokens = args.split(/\s+/).map(t => t.split("=")[0]);
  return flags.filter(f => tokens.includes(f));
}

/* Thinking effort → extra request fields. Levels go out as OpenAI's top-level
 * reasoning_effort and as the chat-template kwarg of the same name, which is
 * where llama.cpp templates read it (Qwen 3.8 accepts low/medium/xhigh this way).
 * Qwen 3 turns thinking off with chat_template_kwargs.enable_thinking=false
 * instead; its template rejects reasoning_effort values it doesn't know. */
const effort = (level) => ({ payload: { reasoning_effort: level, chat_template_kwargs: { reasoning_effort: level } } });
const THINKING = {
  none: effort("none"),
  "qwen-none": {
    payload: { chat_template_kwargs: { enable_thinking: false } },
    // Qwen's recommended non-thinking sampling
    sampling: { temp: 0.7, topp: 0.8, topk: 20, minp: 0, presencePenalty: 1.5, repeatPenalty: 1 },
  },
  low: effort("low"),
  medium: effort("medium"),
  high: effort("high"),
  xhigh: effort("xhigh"),
};
const THINKING_LABELS = { "": "model default", none: "none", "qwen-none": "none (Qwen 3)", low: "low", medium: "medium", high: "high", xhigh: "x-high" };
// Thinking options from earlier versions → current equivalents.
const LEGACY_THINKING = { "qwen-off": "qwen-none", "qwen-on": "", "qwen-precise": "" };
const thinkingPayload = () => THINKING[settings.thinkingEffort]?.payload ?? {};

/** Options for Backend.loadModel(); empty when the toggle is off. */
function loadOptions() {
  if (!settings.lcEnabled) return {};
  const opts = { merge_args: settings.lcMerge };
  const ctx = parseInt(settings.lcCtx, 10);
  if (!Number.isNaN(ctx) && (ctx === -1 || ctx > 0)) opts.ctx_size = ctx;
  if (settings.lcBackend) opts.llamacpp_backend = settings.lcBackend;
  // Concurrent evaluations owns --parallel; drop any stray copy from Extra args.
  const extra = settings.lcArgs.replace(/(^|\s)(--parallel|-np)(=\S+|\s+\S+)?/g, " ").trim();
  opts.llamacpp_args = [`--parallel ${settings.conc}`, extra].filter(Boolean).join(" ");
  if (settings.lcSave) opts.save_options = true;
  return opts;
}

const LC_HINT = "Extra flags for llama-server. Context size and --parallel come from the fields above. "
  + "The server sets -m, --port, -ngl, --jinja, and --mmproj itself. Click Load to apply changes.";

function validateLoadArgs() {
  const hint = $("#lc-hint");
  const reserved = flagsIn(settings.lcArgs, RESERVED_LLAMACPP_FLAGS);
  const parallel = flagsIn(settings.lcArgs, PARALLEL_FLAGS);
  const problems = [];
  if (reserved.length)
    problems.push(`The server sets ${reserved.join(", ")} itself. Remove ${reserved.length > 1 ? "them" : "it"} or the load will be rejected.`
      + (reserved.some(f => f === "-c" || f === "--ctx-size") ? " Use the Context size field instead." : ""));
  if (parallel.length) problems.push(`${parallel.join(", ")} will be ignored. Concurrent evaluations sets --parallel.`);
  hint.textContent = problems.length ? problems.join(" ") : LC_HINT;
  hint.classList.toggle("warn", problems.length > 0);
}

function updateLoadStatus() {
  const status = $("#lc-status");
  status.classList.remove("warn");
  if (!settings.lcEnabled) { status.textContent = "Server/model defaults will be used"; return; }
  let text = `Sent on Load: --parallel ${settings.conc}`;
  const ctx = parseInt(settings.lcCtx, 10);
  if (ctx > 0) {
    const per = Math.floor(ctx / settings.conc);
    text += ` · ~${per} tokens per slot`;
    if (per < pageTokenEstimate() + 2048) { text += " (may not fit a full-size page plus output)"; status.classList.add("warn"); }
  }
  status.textContent = text;
}

function updateThinkingNote(applied) {
  const note = $("#lc-thinking-note");
  const t = THINKING[settings.thinkingEffort];
  if (applied && t?.sampling) {
    const s = t.sampling;
    note.textContent = `Qwen's recommended sampling applied to Parameters (temp ${s.temp}, top-p ${s.topp}, top-k ${s.topk}, presence ${s.presencePenalty}).`;
  } else if (settings.thinkingEffort === "qwen-none") {
    note.textContent = "Sent as enable_thinking: false, which is how Qwen 3 models turn thinking off.";
  } else if (settings.thinkingEffort === "none") {
    note.textContent = "Sent as reasoning_effort: none. For Qwen 3 models, use None (Qwen 3).";
  } else if (settings.thinkingEffort === "high") {
    note.textContent = "Sent as reasoning_effort. Qwen 3.8 only accepts Low, Medium, and X-High.";
  } else if (t) {
    note.textContent = "Sent as reasoning_effort. Models without effort levels ignore it.";
  } else {
    note.textContent = "";
  }
}

const LOAD_FIELDS = [
  ["#lc-ctx", "lcCtx", "value"], ["#lc-backend", "lcBackend", "value"], ["#lc-args", "lcArgs", "value"],
  ["#lc-merge", "lcMerge", "checked"], ["#lc-save", "lcSave", "checked"], ["#lc-enabled", "lcEnabled", "checked"],
  ["#lc-conc", "conc", "value"], ["#lc-thinking", "thinkingEffort", "value"],
];

/** Push settings into the Load Options panel (init and after applying a preset). */
function syncLoadOptionsUI() {
  LOAD_FIELDS.forEach(([sel, key, prop]) => { $(sel)[prop] = settings[key]; });
  $$(".lc-opt input, .lc-opt select, input.lc-opt").forEach(el => { el.disabled = !settings.lcEnabled; });
  validateLoadArgs();
  updateLoadStatus();
  updateThinkingNote(false);
  updateCardSummaries();
}

function bindLoadOptions() {
  LOAD_FIELDS.forEach(([sel, key, prop]) => {
    const el = $(sel);
    el.addEventListener("change", () => {
      if (key === "conc") el.value = clampInt(el.value, 1, 8, settings.conc);
      settings[key] = key === "conc" ? parseInt(el.value, 10) : el[prop];
      saveSettings();
      if (key === "lcEnabled") syncLoadOptionsUI();
      if (key === "thinkingEffort") {
        const sampling = THINKING[settings.thinkingEffort]?.sampling;
        if (sampling) { Object.assign(settings, sampling, { sendParams: true }); saveSettings(); syncParamsUI(); }
        updateThinkingNote(!!sampling);
      }
      updateLoadStatus();
    });
  });
  $("#lc-args").addEventListener("input", e => { settings.lcArgs = e.target.value; validateLoadArgs(); });
  syncLoadOptionsUI();
}

/** One-line summaries shown on collapsed Tab 3 cards. */
function updateCardSummaries() {
  const lc = [`${settings.conc}× parallel`, `thinking ${THINKING_LABELS[settings.thinkingEffort] ?? settings.thinkingEffort}`];
  if (settings.lcEnabled) {
    const ctx = parseInt(settings.lcCtx, 10);
    lc.push(ctx > 0 ? `ctx ${ctx % 1024 === 0 ? ctx / 1024 + "k" : ctx}` : ctx === -1 ? "ctx auto" : "ctx default");
    if (settings.lcBackend) lc.push(settings.lcBackend);
    const kv = /--cache-type-k[ =](\S+)/.exec(settings.lcArgs);
    if (kv) lc.push(`KV ${kv[1]}`);
    if (/(--flash-attn|-fa)[ =]on\b/.test(settings.lcArgs)) lc.push("flash-attn");
  } else {
    lc.push("load defaults");
  }
  $("#lc-summary").textContent = lc.join(" · ");
  $("#param-summary").textContent = settings.sendParams
    ? `temp ${settings.temp} · top-p ${settings.topp} · top-k ${settings.topk} · min-p ${settings.minp} · repeat ${settings.repeatPenalty} · presence ${settings.presencePenalty}${settings.seed !== "" ? ` · seed ${settings.seed}` : ""}`
    : "server/model defaults";
}

/** Collapsible Tab 3 cards; collapsed state is remembered. */
function bindCards() {
  $$(".card").forEach(card => {
    const key = card.dataset.card;
    const apply = (collapsed) => {
      card.classList.toggle("collapsed", collapsed);
      card.querySelector(".collapse-btn").setAttribute("aria-expanded", String(!collapsed));
    };
    apply(!!settings.collapsed?.[key]);
    const toggle = () => {
      const collapsed = !card.classList.contains("collapsed");
      apply(collapsed);
      settings.collapsed = { ...settings.collapsed, [key]: collapsed };
      saveSettings();
    };
    card.querySelector(".collapse-btn").addEventListener("click", toggle);
    card.querySelector(".card-title").addEventListener("click", toggle);
    card.querySelector(".card-summary").addEventListener("click", toggle);
  });
}

/* Named presets for a group of settings (stored in settings[store]). */
function bindPresets({ select, save, del, store, keys, sync, label }) {
  const sel = $(select);
  function refresh(selected = "") {
    sel.innerHTML = '<option value="">— saved presets —</option>';
    Object.keys(settings[store]).sort().forEach(name => {
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name;
      sel.appendChild(opt);
    });
    sel.value = selected;
  }
  sel.addEventListener("change", () => {
    const preset = settings[store][sel.value];
    if (!preset) return;
    keys.forEach(k => { if (k in preset) settings[k] = preset[k]; });
    saveSettings(); sync();
    toast(`Applied ${label} preset "${sel.value}"`);
  });
  $(save).addEventListener("click", () => {
    const name = prompt(`Name for this ${label} preset:`, sel.value);
    if (!name) return;
    settings[store] = { ...settings[store], [name]: Object.fromEntries(keys.map(k => [k, settings[k]])) };
    saveSettings(); refresh(name);
    toast(`Saved ${label} preset "${name}"`, "success");
  });
  $(del).addEventListener("click", () => {
    const name = sel.value;
    if (!name || !confirm(`Delete ${label} preset "${name}"?`)) return;
    const { [name]: _removed, ...rest } = settings[store];
    settings[store] = rest;
    saveSettings(); refresh();
    toast(`Deleted ${label} preset "${name}"`);
  });
  refresh();
}

$("#btn-load-model").addEventListener("click", async () => {
  const model = $("#model-select").value;
  if (!model) { toast("Fetch models and pick one first.", "error"); return; }
  const pill = $("#loaded-pill");
  pill.textContent = `loading ${model}…`; pill.className = "pill unknown";
  try {
    // Persist this explicitly: some servers manage loading themselves, but this
    // is still the exact model name that must be sent in each chat request.
    settings.model = model;
    saveSettings();
    await Backend.loadModel(model, loadOptions());
    await checkHealth(); // refresh loaded info (ctx, parallel) from server
  } catch (err) {
    pill.textContent = "load failed"; pill.className = "pill err";
    $("#loaded-info").textContent = err.message || String(err);
    $("#loaded-info").classList.add("warn");
    toast(`Couldn't load ${model}: ${err.message || err}`, "error");
    return;
  }
  updateLoadedPill();
  toast(`Loaded ${model}`, "success");
  if (await ensureImageBudget(model) && !state.running) await rerenderForBudget();
});

$("#btn-measure").addEventListener("click", async () => {
  const model = currentModel() || $("#model-select").value;
  if (!model) { toast("Pick a model first.", "error"); return; }
  if (await ensureImageBudget(model, true) && !state.running) await rerenderForBudget();
});

$("#btn-unload-model").addEventListener("click", async () => {
  try {
    await Backend.unloadModel();
    toast("Model unloaded");
  } catch (err) {
    toast(`Couldn't unload: ${err.message || err}`, "error");
  }
  updateLoadedPill();
});

// parameter bindings: [elementId, settingsKey, parser] — wired up in init
// after persisted settings have loaded
const serverBindings = [["#base-url", "baseUrl", String], ["#api-key", "apiKey", String]];
const samplingBindings = [
  ["#p-temp", "temp", parseFloat], ["#p-topp", "topp", parseFloat],
  ["#p-topk", "topk", parseInt], ["#p-minp", "minp", parseFloat],
  ["#p-repeat-penalty", "repeatPenalty", parseFloat],
  ["#p-presence-penalty", "presencePenalty", parseFloat],
  // blank = random; otherwise a non-negative integer
  ["#p-seed", "seed", v => (v.trim() === "" ? "" : Math.max(0, parseInt(v, 10)))],
];

/** Push settings into the Parameters panel (init, presets, Qwen sampling). */
function syncParamsUI() {
  samplingBindings.forEach(([sel, key]) => { $(sel).value = settings[key]; });
  $("#p-send-params").checked = !!settings.sendParams;
  $$(".sampling-param input").forEach(el => { el.disabled = !settings.sendParams; });
  $("#sampling-status").textContent = settings.sendParams
    ? "Custom sampling values will be sent"
    : "Server/model defaults will be used";
  updateCardSummaries();
}

function bindParamInputs() {
  [...serverBindings, ...samplingBindings].forEach(([sel, key, parse]) => {
    const el = $(sel);
    el.value = settings[key];
    el.addEventListener("change", () => {
      const v = parse(el.value);
      if (typeof v === "number" && Number.isNaN(v)) { el.value = settings[key]; return; }
      settings[key] = v;
      if (key === "baseUrl" || key === "apiKey") { Backend.configure(settings); state.server = "unknown"; }
      saveSettings();
    });
  });
  $("#p-send-params").addEventListener("change", e => {
    settings.sendParams = e.target.checked;
    saveSettings(); syncParamsUI();
  });
  syncParamsUI();
}

// Local machine telemetry — independent of the configured inference server.
// Polls every 3 s while Tab 3 or Tab 4 is visible; Tab 4 draws sparklines.
const STAT_HISTORY = 40;
const statHistory = { ram: [], vram: [], gpu: [] };

async function pollSystemStats() {
  if (!$("#tab3").classList.contains("active") && !$("#tab4").classList.contains("active")) return;
  const el = $("#sys-stats");
  try {
    const s = await Backend.systemStats();
    const gb = v => v == null ? "n/a" : `${v.toFixed(1)} GiB`;
    const pct = v => v == null ? "n/a" : `${Math.round(v)}%`;
    const vram = s.vram_total_gb != null ? `${gb(s.vram_gb)}/${gb(s.vram_total_gb)}` : gb(s.vram_gb);
    const gtt = s.gtt_total_gb != null ? ` · Shared/GTT ${gb(s.gtt_gb)}/${gb(s.gtt_total_gb)}` : "";
    el.textContent = `CPU ${pct(s.cpu_percent)} · RAM ${gb(s.memory_gb)} · VRAM ${vram} · GPU ${pct(s.gpu_percent)}${gtt}`;
    el.title = "Local Linux telemetry. Shared/GTT is AMD's TTM-backed system-memory pool, not dedicated VRAM.";

    // APUs have little dedicated VRAM; the shared GTT pool is what fills up.
    const useGtt = s.gtt_gb != null && (s.vram_total_gb == null || s.vram_total_gb < 2);
    const gpuMem = useGtt ? s.gtt_gb : s.vram_gb;
    const gpuMemTotal = useGtt ? s.gtt_total_gb : s.vram_total_gb;
    const push = (key, v) => { if (v == null) return; statHistory[key].push(v); if (statHistory[key].length > STAT_HISTORY) statHistory[key].shift(); };
    push("ram", s.memory_gb); push("vram", gpuMem); push("gpu", s.gpu_percent);
    $("#d-ram").textContent = gb(s.memory_gb);
    $("#d-vram-label").textContent = useGtt ? "Shared GPU mem" : "VRAM";
    $("#d-vram").textContent = gpuMemTotal != null ? `${gb(gpuMem)} / ${gpuMemTotal.toFixed(0)}` : gb(gpuMem);
    $("#d-gpu").textContent = pct(s.gpu_percent);
    drawSpark("ram", null);
    drawSpark("vram", gpuMemTotal);
    drawSpark("gpu", 100);
  } catch {
    el.textContent = "local host stats unavailable";
  }
}
setInterval(pollSystemStats, 3000);

function drawSpark(metric, max) {
  const svg = $(`.spark-tile[data-metric="${metric}"] .spark`);
  const data = statHistory[metric];
  if (!svg || data.length < 2) return;
  const top = max ?? (Math.max(...data) * 1.15 || 1);
  const step = 100 / (STAT_HISTORY - 1);
  const x0 = 100 - (data.length - 1) * step;
  const pts = data.map((v, i) => `${(x0 + i * step).toFixed(2)},${(24 - Math.min(v / top, 1) * 22).toFixed(2)}`);
  svg.querySelector(".spark-line").setAttribute("d", "M" + pts.join(" L"));
  svg.querySelector(".spark-area").setAttribute("d", `M${x0.toFixed(2)},24 L${pts.join(" L")} L100,24 Z`);
}

/* ================= Tab 4: run & outputs ================= */

function bindSaveMode() {
  $$('input[name="save-mode"]').forEach(r => {
    r.checked = r.value === settings.saveMode;
    r.addEventListener("change", e => { settings.saveMode = e.target.value; saveSettings(); updateSavePreview(); });
  });
  $$('input[name="output-view"]').forEach(r => {
    r.checked = r.value === settings.outputView;
    r.addEventListener("change", e => {
      settings.outputView = e.target.value;
      saveSettings();
      $$(".run-panel").forEach(p => paintOutput(p, p._raw ?? ""));
    });
  });
}

function pdfBase() {
  return state.pdfName ? state.pdfName.replace(/\.pdf$/i, "") : "output";
}

function updateSavePreview() {
  const batches = getBatches();
  const el = $("#save-preview");
  if (!batches.length || !state.pdfName) { el.textContent = ""; return; }
  el.textContent = settings.saveMode === "merged"
    ? `→ ${pdfBase()}.md`
    : `→ ${pdfBase()}_1_of_${batches.length}.md … ${pdfBase()}_${batches.length}_of_${batches.length}.md`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

const COPY_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/></svg>';
const PAGES_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="5.5" height="11" rx="1"/><path d="M9.5 4h5M9.5 7h5M9.5 10h3.5"/></svg>';

/** Render a panel's Markdown (or raw text) at most once per frame while streaming. */
function paintOutput(panel, text) {
  panel._raw = text;
  if (panel._paintPending) return;
  panel._paintPending = requestAnimationFrame(() => {
    panel._paintPending = 0;
    const out = panel.querySelector(".rp-output");
    const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 24;
    const raw = settings.outputView === "raw";
    out.classList.toggle("raw", raw);
    out.classList.toggle("md", !raw);
    if (raw) out.textContent = panel._raw;
    else out.innerHTML = Markdown.render(panel._raw);
    if (stick) out.scrollTop = out.scrollHeight;
  });
}

/** Side-by-side view: the batch's page images next to its output. */
function togglePanelPages(panel, batch) {
  const on = !panel.classList.contains("with-pages");
  panel.classList.toggle("with-pages", on);
  panel.querySelector(".rp-pages-btn").classList.toggle("on", on);
  const box = panel.querySelector(".rp-pages");
  box.hidden = !on;
  box.innerHTML = "";
  if (!on) return;
  batch.map(pi => state.pages[pi]).filter(Boolean).forEach(p => {
    const fig = document.createElement("figure");
    const cap = document.createElement("figcaption");
    cap.textContent = `page ${p.index + 1}`;
    let el;
    if (p.sessionId && Backend.preview) {
      el = document.createElement("img");
      el.alt = p.label;
      Backend.preview(p)
        .then(src => { if (fig.isConnected) el.src = src; })
        .catch(() => { cap.textContent += " · image unavailable"; });
    } else {
      el = document.createElement("canvas");
      drawPlaceholder(el, p.index + 1);
    }
    el.addEventListener("click", () => openZoom(p));
    fig.append(el, cap);
    box.appendChild(fig);
  });
}

function buildRunPanel(i, batch) {
  const pages = batch.map(x => x + 1);
  const range = pages.length > 1 ? `pages ${pages[0]}–${pages[pages.length - 1]}` : `page ${pages[0]}`;
  const panel = document.createElement("div");
  panel.className = "run-panel";
  panel.style.setProperty("--bc", batchColor(i));
  panel.innerHTML = `
    <div class="rp-head">
      <span class="bname">Batch ${i + 1}</span>
      <span class="muted">${range}</span>
      <span class="rp-status">queued</span>
      <button class="btn icon rp-pages-btn" title="Show the pages next to the output">${PAGES_ICON}</button>
      <button class="btn icon rp-copy" title="Copy Markdown">${COPY_ICON}</button>
      <button class="btn danger rp-cancel">Cancel</button>
    </div>
    <div class="rp-thinking-live" hidden></div>
    <div class="rp-body"><div class="rp-pages" hidden></div><div class="rp-output"></div></div>
    <div class="rp-stats" hidden></div>`;
  panel._raw = "";
  panel.querySelector(".rp-pages-btn").addEventListener("click", () => togglePanelPages(panel, batch));
  panel.querySelector(".rp-copy").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    await copyText(panel._raw);
    btn.classList.add("ok");
    setTimeout(() => btn.classList.remove("ok"), 800);
    toast(`Copied batch ${i + 1} Markdown`, "success", 2000);
  });
  return panel;
}

const LOOP_CHECK_EVERY = 500; // characters of new text between repetition checks

async function runBatch(i, batch, instruction, run) {
  const panel = run.panels[i];
  panel.querySelector(".rp-thinking")?.remove(); // clear previous review section
  const statusEl = panel.querySelector(".rp-status");
  const thinkEl = panel.querySelector(".rp-thinking-live");
  const outEl = panel.querySelector(".rp-output");
  const statsEl = panel.querySelector(".rp-stats");
  // reset panel state (fresh run or re-run)
  thinkEl.textContent = ""; thinkEl.hidden = true;
  paintOutput(panel, "");
  statsEl.textContent = ""; statsEl.hidden = true;
  statusEl.className = "rp-status";
  run.outputs[i] = ""; run.done[i] = false; run.speeds[i] = undefined; run.prefill[i] = undefined;
  const ctrl = new AbortController();
  run.controllers[i] = ctrl;
  const cancelBtn = panel.querySelector(".rp-cancel");
  const freshBtn = cancelBtn.cloneNode(true); // drop stale listeners
  cancelBtn.replaceWith(freshBtn);
  freshBtn.disabled = false;
  freshBtn.addEventListener("click", () => ctrl.abort());

  statusEl.textContent = "running"; statusEl.classList.add("running");
  outEl.classList.add("streaming");
  updateDashboard();
  let outputStarted = false;
  let thinkingText = "";
  // Loop check: re-run the repetition test after every LOOP_CHECK_EVERY new characters.
  let checkedThinking = 0, checkedOutput = 0;
  const loopError = (where) => {
    ctrl.abort(); // stops generation on the server; the thrown error marks the batch failed
    return new Error(`the model started repeating itself in its ${where}, so the batch was stopped`);
  };
  try {
    const stream = Backend.streamBatch({
      batch: batch.map(pi => state.pages[pi]),
      instruction,
      params: {
        // The run captures its model at Start time so a persisted/stale
        // selection cannot leak into active batches or a failed-batch re-run.
        model: run.model,
        // Sampling overrides are opt-in; thinking effort was captured at Start.
        sendParams: settings.sendParams,
        temperature: settings.temp, top_p: settings.topp, top_k: settings.topk,
        min_p: settings.minp, repeat_penalty: settings.repeatPenalty,
        presence_penalty: settings.presencePenalty,
        seed: settings.seed === "" ? null : settings.seed,
        extra: run.thinking,
      },
      signal: ctrl.signal,
    });
    for await (const ev of stream) {
      if (ev.type === "thinking") {
        thinkingText += ev.text;
        thinkEl.hidden = false;
        thinkEl.textContent += ev.text;
        thinkEl.scrollTop = thinkEl.scrollHeight;
        if (thinkingText.length - checkedThinking >= LOOP_CHECK_EVERY) {
          checkedThinking = thinkingText.length;
          if (Repetition.detect(thinkingText)) throw loopError("thinking");
        }
      } else if (ev.type === "output") {
        if (!outputStarted) { // thinking is ephemeral: clear it, switch to output
          outputStarted = true;
          thinkEl.textContent = "";
          thinkEl.hidden = true;
        }
        run.outputs[i] += ev.text;
        paintOutput(panel, run.outputs[i]);
        if (run.outputs[i].length - checkedOutput >= LOOP_CHECK_EVERY) {
          checkedOutput = run.outputs[i].length;
          if (Repetition.detect(run.outputs[i])) throw loopError("output");
        }
      } else if (ev.type === "stats") {
        statsEl.hidden = false;
        statsEl.textContent = formatStats(ev.stats);
        const speed = Number(ev.stats.tokPerSec);
        if (Number.isFinite(speed)) run.speeds[i] = speed;
        const prefill = Number(ev.stats.prefillPerSec);
        if (ev.stats.prefillPerSec != null && Number.isFinite(prefill)) run.prefill[i] = prefill;
      }
    }
    statusEl.textContent = "done"; statusEl.className = "rp-status done";
    run.done[i] = true;
    // keep the finished thinking reviewable in a collapsed section
    if (thinkingText) {
      const det = document.createElement("details");
      det.className = "rp-thinking";
      const sum = document.createElement("summary");
      sum.textContent = "thinking";
      const body = document.createElement("div");
      body.className = "body";
      body.textContent = thinkingText;
      det.append(sum, body);
      panel.insertBefore(det, panel.querySelector(".rp-body"));
    }
  } catch (err) {
    if (err.name === "AbortError") {
      statusEl.textContent = "cancelled"; statusEl.className = "rp-status cancelled";
    } else {
      statusEl.textContent = "error: " + err.message; statusEl.className = "rp-status error";
    }
  } finally {
    outEl.classList.remove("streaming");
    panel.querySelector(".rp-cancel").disabled = true;
    updateDashboard();
    updateSteps();
    maybeFinishRun(run);
  }
}

function failedIndices(run) {
  return run.panels.map((_, i) => i).filter(i => {
    const s = run.panels[i].querySelector(".rp-status");
    return s.classList.contains("error") || s.classList.contains("cancelled");
  });
}

function maybeFinishRun(run) {
  if (!state.running) return; // already settled
  const settled = run.panels.every((_, i) => run.done[i] || run.controllers[i]?.signal.aborted
    || run.panels[i].querySelector(".rp-status").classList.contains("error")
    || run.panels[i].querySelector(".rp-status").classList.contains("cancelled"));
  if (!settled) return;
  state.running = false;
  run.finishedAt = Date.now();
  stopDashTimer();
  const done = run.done.filter(Boolean).length;
  const failed = failedIndices(run).length;
  $("#btn-start").disabled = false;
  $("#btn-cancel-all").disabled = true;
  $("#btn-save").disabled = !done;
  $("#btn-rerun").disabled = !failed;
  $("#run-status").textContent = done
    ? (failed ? "finished with failures — re-run available" : "finished")
    : "cancelled — model unloaded";
  updateDashboard();
  updateSteps();
  if (run.cancelled) toast(done ? `Run cancelled · ${plural(done, "batch", "batches")} finished` : "Run cancelled");
  else if (failed) toast(`Finished with ${plural(failed, "failed batch", "failed batches")}. Use Re-run failed to try ${failed === 1 ? "it" : "them"} again.`, "error");
  else toast(`Finished ${plural(done, "batch", "batches")} in ${fmtDuration(run.finishedAt - run.startedAt)}`, "success");
}

async function runIndices(run, indices) {
  const queue = [...indices];
  async function worker() {
    while (!run.cancelled && queue.length) {
      const i = queue.shift();
      await runBatch(i, run.batches[i], run.instruction, run);
    }
  }
  await Promise.all(Array.from({ length: Math.min(settings.conc, indices.length) }, worker));
}

/** "prefill 8,214 tok @ 612.3 tok/s · generation 530 tok @ 21.4 tok/s · TTFT 13.4 s" */
function formatStats(st) {
  const n = (v) => Number(v).toLocaleString();
  const parts = [];
  if (st.promptTokens != null)
    parts.push(`prefill ${n(st.promptTokens)} tok${st.prefillPerSec != null ? ` @ ${st.prefillPerSec} tok/s` : ""}`);
  parts.push(`generation ${n(st.tokens)} tok @ ${st.tokPerSec} tok/s`);
  const ttft = Number(st.ttftMs);
  parts.push(`TTFT ${Number.isFinite(ttft) ? (ttft >= 10000 ? `${(ttft / 1000).toFixed(1)} s` : `${ttft} ms`) : "?"}`);
  return parts.join(" · ");
}

/* ---- dashboard ---- */

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

let dashTimer = null;
function startDashTimer() { stopDashTimer(); dashTimer = setInterval(updateDashboard, 1000); }
function stopDashTimer() { clearInterval(dashTimer); dashTimer = null; }

function updateDashboard() {
  const run = state.currentRun;
  $("#dash").classList.toggle("running-run", state.running);
  const bar = $("#prog-bar"), fail = $("#prog-fail"), label = $("#prog-label");
  if (!run?.batches) {
    bar.style.width = "0"; fail.style.width = "0";
    label.textContent = "Not started";
    ["#d-batches", "#d-pages", "#d-prefill", "#d-speed", "#d-elapsed", "#d-eta"].forEach(s => { $(s).textContent = "—"; });
    return;
  }
  const total = run.batches.length;
  const done = run.done.filter(Boolean).length;
  const failed = failedIndices(run).length;
  const totalPages = run.batches.reduce((n, b) => n + b.length, 0);
  const donePages = run.batches.reduce((n, b, i) => n + (run.done[i] ? b.length : 0), 0);
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.style.width = `${(done / total) * 100}%`;
  fail.style.left = `${(done / total) * 100}%`;
  fail.style.width = `${(failed / total) * 100}%`;
  $(".progress").setAttribute("aria-valuenow", String(pct));
  label.textContent = state.running
    ? (run.startedAt ? `${done} of ${total} batches · ${pct}%` : "loading model…")
    : failed ? `${done} done · ${failed} failed` : `${done} of ${total} batches · ${pct}%`;

  $("#d-batches").textContent = `${done} / ${total}`;
  $("#d-pages").textContent = `${donePages} / ${totalPages}`;
  const avg = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? `${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)} tok/s` : "—"; };
  $("#d-prefill").textContent = avg(run.prefill);
  $("#d-speed").textContent = avg(run.speeds);
  const now = run.finishedAt ?? Date.now();
  $("#d-elapsed").textContent = run.startedAt ? fmtDuration(now - run.startedAt) : "—";
  // Time left extrapolates from batches finished since this (re-)run started.
  const doneThisLeg = done - run.etaBase;
  const remaining = total - done - failed;
  $("#d-eta").textContent = !state.running ? "—"
    : doneThisLeg > 0 && remaining > 0 ? fmtDuration(((Date.now() - run.etaStart) / doneThisLeg) * remaining)
    : remaining === 0 ? "finishing…" : "estimating…";
}

$("#btn-rerun").addEventListener("click", () => {
  const run = state.currentRun;
  if (!run || state.running) return;
  const failed = failedIndices(run);
  if (!failed.length) return;
  state.running = true;
  run.cancelled = false;
  run.finishedAt = undefined;
  run.etaStart = Date.now();
  run.etaBase = run.done.filter(Boolean).length;
  $("#btn-start").disabled = true;
  $("#btn-rerun").disabled = true;
  $("#btn-cancel-all").disabled = false;
  $("#btn-save").disabled = true;
  $("#run-status").textContent = `re-running ${plural(failed.length, "batch", "batches")}…`;
  startDashTimer();
  updateSteps();
  runIndices(run, failed);
});

async function startRun() {
  const batches = getBatches();
  const baseInstruction = $("#instruction-editor").value.trim();
  if (!state.pdfName || !batches.length) { toast("Load a PDF and define batches first.", "error"); return; }
  if (!baseInstruction) { toast("Write or load instructions in step 1 first.", "error"); return; }

  // A server can already have a model loaded even when this app's dropdown was
  // never populated (or its saved selection is stale). Health is authoritative.
  $("#run-status").textContent = "checking server health…";
  if (!(await checkHealth())) {
    $("#run-status").textContent = "server offline — aborting";
    toast(`Can't reach the server at ${settings.baseUrl}. Check it in step 3.`, "error");
    return;
  }
  // Prefer the model this session actually loaded. This matters for
  // standard OpenAI servers, which do not report a loaded model in /v1/health.
  const model = Backend._state.loadedModel || $("#model-select").value || settings.model;
  if (!model) { toast("Pick a model in step 3 first.", "error"); $("#run-status").textContent = "idle"; return; }
  if (settings.model !== model) {
    settings.model = model;
    saveSettings();
    const select = $("#model-select");
    if (![...select.options].some(o => o.value === model)) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      select.appendChild(option);
    }
    select.value = model;
  }
  const instruction = baseInstruction;

  // clear previous outputs (outputs are ephemeral)
  const container = $("#run-panels");
  container.innerHTML = "";
  container.hidden = false;
  $("#run-empty").hidden = true;
  const run = { panels: [], outputs: [], done: [], controllers: [], speeds: [], prefill: [], cancelled: false };
  batches.forEach((b, i) => {
    const panel = buildRunPanel(i, b);
    container.appendChild(panel);
    run.panels.push(panel); run.outputs.push(""); run.done.push(false); run.controllers.push(null);
  });

  state.running = true;
  $("#btn-start").disabled = true;
  $("#btn-cancel-all").disabled = false;
  $("#btn-save").disabled = true;
  $("#btn-rerun").disabled = true;
  run.batches = batches;
  run.instruction = instruction;
  run.model = model; // immutable choice used by every initial/re-run request
  run.thinking = thinkingPayload();
  state.currentRun = run; // lets Cancel all also stop a model load before streams begin
  updateDashboard();
  updateSteps();

  // ensure model is loaded (POST /v1/load — server-side recipe options apply)
  if (Backend._state.loadedModel !== model) {
    $("#run-status").textContent = `loading ${model}… (large models can take a minute)`;
    try {
      await Backend.loadModel(model, loadOptions());
      if (run.cancelled) {
        await Backend.unloadModel().catch(() => {}); // cancel may have raced model loading
        return;
      }
      await checkHealth();
    } catch (err) {
      $("#run-status").textContent = "load failed: " + (err.message || err);
      toast(`Couldn't load ${model}: ${err.message || err}`, "error");
      state.running = false;
      $("#btn-start").disabled = false;
      $("#btn-cancel-all").disabled = true;
      updateDashboard(); updateSteps();
      return;
    }
    updateLoadedPill();
  }
  // Pages must match this model's image budget: measure it once, re-render if needed.
  if (!budgetFor(model)) {
    $("#run-status").textContent = `measuring the image budget for ${model}…`;
    await ensureImageBudget(model);
    if (run.cancelled) return;
  }
  if (state.renderTargetPx != null && Math.abs(renderTargetPx() - state.renderTargetPx) / renderTargetPx() >= 0.02) {
    $("#run-status").textContent = "re-rendering pages for this model's image budget…";
    if (!(await rerenderForBudget())) {
      $("#run-status").textContent = "re-render failed — run stopped";
      state.running = false;
      $("#btn-start").disabled = false;
      $("#btn-cancel-all").disabled = true;
      run.panels.forEach(p => { const st = p.querySelector(".rp-status"); st.textContent = "cancelled"; st.className = "rp-status cancelled"; });
      updateDashboard(); updateSteps();
      return;
    }
    if (run.cancelled) return;
  }
  $("#run-status").textContent = `running ${plural(batches.length, "batch", "batches")}, ${settings.conc} at a time`;

  if (run.cancelled) return;
  run.startedAt = run.etaStart = Date.now();
  run.etaBase = 0;
  startDashTimer();
  updateDashboard();
  runIndices(run, batches.map((_, i) => i));
}

$("#btn-start").addEventListener("click", startRun);

$("#btn-cancel-all").addEventListener("click", async () => {
  const run = state.currentRun;
  if (!run || !state.running) return;
  run.cancelled = true;
  // Queued batches have no controller yet; mark them now and prevent workers
  // from dequeuing them after an active request settles.
  run.panels.forEach((panel, i) => {
    if (!run.controllers[i] && !run.done[i]) {
      const status = panel.querySelector(".rp-status");
      status.textContent = "cancelled";
      status.className = "rp-status cancelled";
      panel.querySelector(".rp-cancel").disabled = true;
    }
  });
  run.controllers.forEach(c => c?.abort());
  $("#run-status").textContent = "cancelling…";
  await Backend.unloadModel(); // model unloads on cancel-all
  updateLoadedPill();
  maybeFinishRun(run);
});

$("#btn-save").addEventListener("click", async () => {
  const run = state.currentRun;
  if (!run) return;
  const base = pdfBase();
  const n = run.outputs.length;
  const completed = run.outputs.map((t, i) => ({ t, i })).filter(x => run.done[x.i] && x.t.trim());
  if (!completed.length) { toast("No completed batches to save.", "error"); return; }
  const merged = settings.saveMode === "merged";
  const files = merged
    ? [{ name: `${base}.md`, content: completed.map(x => x.t).join("\n\n---\n\n") }]
    : completed.map(x => ({ name: `${base}_${x.i + 1}_of_${n}.md`, content: x.t }));
  try {
    const res = await Backend.saveOutputs(merged, files);
    if (res.saved.length) {
      $("#run-status").textContent = `saved: ${res.saved.join(", ")}`;
      toast(res.saved.length === 1 ? `Saved ${res.saved[0]}` : `Saved ${res.saved.length} files`, "success");
    } else {
      $("#run-status").textContent = "save cancelled";
    }
  } catch (err) {
    $("#run-status").textContent = "save failed: " + err;
    toast(`Save failed: ${err}`, "error");
  }
});

/* unload on app close (best-effort; real backend will POST /v1/unload) */
window.addEventListener("beforeunload", () => {
  if (Backend._state.loadedModel) Backend.unloadModel();
});

/* ================= Helpers & init ================= */

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : Math.min(hi, Math.max(lo, n));
}

(async function init() {
  // load persisted settings + instruction sets (app-data via Tauri, localStorage in browser)
  try {
    const persisted = await Backend.loadPersisted();
    if (persisted.settings) Object.assign(settings, persisted.settings);
    LEGACY_SETTINGS.forEach(k => delete settings[k]);
    const migrate = (obj) => { if (obj.thinkingEffort in LEGACY_THINKING) obj.thinkingEffort = LEGACY_THINKING[obj.thinkingEffort]; };
    migrate(settings);
    Object.values(settings.loadPresets || {}).forEach(migrate);
    if (persisted.instructions) Object.assign(instructionSets, persisted.instructions);
  } catch { /* first run or unreadable store — use defaults */ }

  Backend.configure({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, efficient: settings.efficientMode });

  applyTheme(settings.theme);
  bindParamInputs();
  bindLoadOptions();
  bindCards();
  bindPresets({ select: "#load-preset", save: "#btn-load-preset-save", del: "#btn-load-preset-delete",
    store: "loadPresets", keys: LOAD_PRESET_KEYS, sync: syncLoadOptionsUI, label: "load-option" });
  bindPresets({ select: "#param-preset", save: "#btn-param-preset-save", del: "#btn-param-preset-delete",
    store: "paramPresets", keys: PARAM_PRESET_KEYS, sync: syncParamsUI, label: "parameter" });
  bindSaveMode();
  applyProcessingMode(settings.efficientMode);
  $("#fixed-n").value = state.fixedN;
  applyBatchZoom(settings.batchZoom);
  $("#tab2").dataset.mode = state.batchMode;
  $("#run-panels").hidden = true;
  refreshInstructionSelect();
  showPdfCard();
  renderThumbs(); renderBatches();
  updateLoadedPill();
  updateSavePreview();
  updateDashboard();
  refreshDerivedUI();
  // deep-link: index.html#tab2 … #tab4
  const hash = location.hash.slice(1);
  if (["tab1", "tab2", "tab3", "tab4"].includes(hash)) selectTab(hash);
  // demo mode for visual review: ?demo=fixed | ?demo=visual | ?demo=panels
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo) demoPopulate(demo);
  // e2e self-test against the live Lemonade server: window.__E2E__ (e2e.html)
  if (window.__E2E__) runE2E();
})();

/* End-to-end smoke test (Tauri only): fetch bundled test PDF, convert,
 * fetch models, stream one batch from the live server, show results. */
async function runE2E() {
  const log = [];
  const note = (s) => { log.push(s); console.log("[e2e]", s); render(); };
  const render = () => {
    selectTab("tab4");
    $("#run-empty").hidden = true;
    $("#run-panels").hidden = false;
    $("#run-panels").innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "rp-output raw";
    pre.style.padding = "12px";
    pre.textContent = log.join("\n");
    $("#run-panels").appendChild(pre);
    $("#run-panels").scrollTop = $("#run-panels").scrollHeight;
    document.title = log[log.length - 1] || "e2e";
  };
  try {
    note("E2E: starting…");
    const resp = await fetch("test-assets/test.pdf");
    const blob = await resp.blob();
    const file = new File([blob], "e2e.pdf", { type: "application/pdf" });
    note("E2E: fetched test.pdf (" + blob.size + " bytes)");
    const pages = await Backend.convertPdf(file, renderTargetPx());
    note(`E2E: converted ${pages.length} pages into the disk-backed render cache`);
    state.pdfFile = file; state.pdfName = "e2e.pdf"; state.pages = pages;
    const h = await Backend.health();
    note("E2E: health = " + h.status);
    const models = await Backend.listModels();
    note(`E2E: ${models.length} models; first = ${models[0]}`);
    const model = window.__E2E_MODEL__ || models.find(m => /kimi/i.test(m)) || models[0];
    const stats0 = await Backend.systemStats();
    note(`E2E: system-stats RAM ${stats0.memory_gb} GiB, VRAM ${stats0.vram_gb} GiB`);
    if (Backend._state.loadedModel !== model) {
      note("E2E: loading " + model + "…");
      await Backend.loadModel(model, { ctx_size: 8192 });
    }
    note("E2E: model ready: " + model);
    // two batches concurrently — mirrors a real run
    const runOne = async (tag, pageIdx) => {
      const ctrl = new AbortController();
      let thinking = "", output = "", stats = null, err = null;
      try {
        for await (const ev of Backend.streamBatch({
          batch: [pages[pageIdx]],
          instruction: "Transcribe the text on this page in one short sentence.",
          params: { model, temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, max_tokens: 512, thinking: true },
          signal: ctrl.signal,
        })) {
          if (ev.type === "thinking") thinking += ev.text;
          else if (ev.type === "output") output += ev.text;
          else if (ev.type === "stats") stats = ev.stats;
        }
      } catch (e) { err = e.message || String(e); }
      return { tag, thinking, output, stats, err };
    };
    note("E2E: launching 2 concurrent batches…");
    const [r1, r2] = await Promise.all([runOne("B1", 0), runOne("B2", 1)]);
    for (const r of [r1, r2]) {
      if (r.err) { note(`${r.tag}: ERROR — ${r.err}`); continue; }
      note(`${r.tag}: thinking ${r.thinking.length} chars, output ${r.output.length} chars`);
      note(`${r.tag} thinking: ` + r.thinking.slice(0, 100).replace(/\n/g, " "));
      note(`${r.tag} output: ` + r.output.slice(0, 150).replace(/\n/g, " "));
      if (r.stats) note(`${r.tag}: ${r.stats.tokens} tok · ${r.stats.tokPerSec} tok/s · TTFT ${r.stats.ttftMs} ms`);
    }
    const pass = [r1, r2].every(r => !r.err && r.thinking.length > 0 && r.output.length > 0);
    note(pass ? "E2E: stream PASS ✓" : "E2E: stream FAIL — see above");

  } catch (err) {
    note("E2E: FAIL — " + (err.message || err));
  }
}

function demoPopulate(kind) {
  // synchronous (no mock conversion delay) so headless screenshots capture it
  state.pdfName = "demo.pdf";
  state.pages = Array.from({ length: 9 }, (_, i) => ({
    index: i, label: `demo.pdf · page ${i + 1}`,
  }));
  showPdfCard();
  $("#page-count").textContent = `${plural(state.pages.length, "page")} · ${fmtMP(renderTargetPx())} each`;
  if (kind === "visual") {
    document.querySelector('input[name="batch-mode"][value="visual"]').click();
    state.visualBatches = [[0, 1, 2], [3, 4], []];
  }
  renderThumbs(); renderBatches(); updateSavePreview();
  if (kind === "panels") demoPanels();
}

function demoPanels() {
  const c = $("#run-panels");
  c.innerHTML = "";
  c.hidden = false;
  $("#run-empty").hidden = true;
  const p1 = buildRunPanel(0, [0, 1, 2]);
  const s1 = p1.querySelector(".rp-status");
  s1.textContent = "running"; s1.classList.add("running");
  const t1 = p1.querySelector(".rp-thinking-live");
  t1.hidden = false;
  t1.textContent = "Let me examine pages 1–3 carefully. The instruction says to transcribe in reading order, watching for tables, figures, and footnotes. Header rows appear consistent across these pages. I should preserve the two-column layout on page 2 and mark the figure caption inline…";
  p1.querySelector(".rp-output").classList.add("streaming");
  c.appendChild(p1);

  const p2 = buildRunPanel(1, [3, 4, 5]);
  const s2 = p2.querySelector(".rp-status");
  s2.textContent = "running"; s2.classList.add("running");
  p2.querySelector(".rp-output").classList.add("streaming");
  paintOutput(p2, "# Transcription — pages 4–6\n\n## Page 4\n\nLorem ipsum dolor sit amet, **consectetur** adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n\n| Item | Qty | Price |\n|---|--:|--:|\n| Widget | 4 | $12.00 |\n| Gadget | 1 | $3.50 |\n\n- first point\n- second point");
  c.appendChild(p2);

  const p3 = buildRunPanel(2, [6, 7]);
  const s3 = p3.querySelector(".rp-status");
  s3.textContent = "done"; s3.className = "rp-status done";
  paintOutput(p3, "# Transcription — pages 7–8\n\n## Page 7\n\nDuis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.\n\n> Excepteur sint occaecat cupidatat non proident.");
  const st3 = p3.querySelector(".rp-stats");
  st3.hidden = false;
  st3.textContent = "132 tokens · 61.4 tok/s · TTFT 500 ms";
  p3.querySelector(".rp-cancel").disabled = true;
  c.appendChild(p3);
}
