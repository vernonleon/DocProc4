# DocProc4

DocProc4 turns PDF pages into Markdown using a local, OpenAI-compatible vision-language-model server. PDF rendering, settings, and output files stay on your machine.

## Compatible servers

Use any local server implementing GET /v1/models and POST /v1/chat/completions with image-url inputs and streaming responses. This includes LM Studio and Jan. Set the base URL in LLM Config; LM Studio normally uses http://localhost:1234 and Jan commonly uses http://127.0.0.1:1337. You may paste either the server root or its OpenAI URL ending in /v1; DocProc4 accepts both forms. Fetch models, select a vision model, then run batches.

DocProc4 first probes GET /v1/health when available. For standard OpenAI-compatible servers without that non-standard endpoint, a successful GET /v1/models check marks the server online. Model load/unload and host statistics are optional extensions: Jan and other standard servers manage the selected model themselves, and DocProc4 sends its selected model name with each chat request.

## Run

```bash
npm install
source ~/.cargo/env
npm run dev
```

You can drag a PDF onto the window to load it, and a .md or .txt file to use it as instructions. The steps across the top show what's done. Tab 4 shows run progress, speed, time left, and memory use. Outputs can be viewed as rendered Markdown or raw text, with the page images alongside. Each finished batch is backed up to the app's data folder until you save, so if the app crashes or is closed first, it offers to restore that run on the next launch. Unfinished batches can be re-run after you load the same PDF again.

PDF pages are rendered by MuPDF, which is compiled into the app from source by the `mupdf` crate, so there's nothing extra to install. PDF.js in the webview is the automatic fallback for any PDF MuPDF can't open. MuPDF is AGPL-3.0; that doesn't matter for personal use, but distributing DocProc4 would put it under the AGPL too.

Build a release with `npm run build`.

Requirements: Rust (via rustup), Node.js, a C compiler and clang (MuPDF is built from source), and Tauri's Linux build dependencies (WebKitGTK 4.1 and related packages; see Tauri's prerequisites guide for your distro).

If the project lives on a mount that can't execute binaries (such as pCloud), keep build output on a local disk. Create `src-tauri/.cargo/config.toml` containing `[build]` and `target-dir = "/absolute/local/path"`. That file is git-ignored because it's machine-specific.

## Installers

`npm run build` builds release installers for the operating system it runs on. On Linux you get `.deb`, `.rpm`, and an AppImage, in `bundle/` under the build output folder (`src-tauri/target/release/`, or your local `target-dir`). Windows installers (`.msi` and a setup `.exe`) have to be built on Windows.

GitHub can build both for you. The **Build installers** workflow (`.github/workflows/build-installers.yml`) runs on GitHub's Linux and Windows machines and attaches every installer to a draft release. To use it:

1. Set the new version in `src-tauri/tauri.conf.json` (keep `src-tauri/Cargo.toml` and `package.json` in step), commit, and push.
2. Push a matching tag, e.g. `git tag v0.2.0` then `git push origin v0.2.0`, or start it from the repository's **Actions** tab with **Run workflow**.
3. When it finishes, open **Releases** on GitHub, check the draft, and publish it.

DocProc4 includes MuPDF, which is AGPL-3.0, so installers you give to others are covered by the AGPL (`AGPL-3.0-or-later`). Share the source with anyone you give the app to.

On Arch-based systems (including CachyOS), `packaging/aur/` has a PKGBUILD that installs DocProc4 as a regular package. See `packaging/aur/README.md`.

## Portable copy

The source is in git, with dependencies and build output ignored. To make a clean archive of the last commit:

```bash
git archive --format=tar.gz --prefix=DocProc4/ -o ~/DocProc4-src.tar.gz HEAD
```

On the other machine, unpack it and run `npm install` then `npm run dev`.

## Low-memory machines

- **Fast / Efficient toggle** (the rabbit and turtle in the title bar). **Fast** renders every full-size page as soon as the PDF loads, into `/tmp`, which is RAM-backed tmpfs on many distros. **Efficient** renders only thumbnails up front, into `~/.cache/com.docproc4.app/render` on disk. Full-size pages render one at a time just before their batch is sent, then get deleted. Batching thumbnails load only while they're on screen. In both modes, PDFs and page PNGs pass between the UI and the backend as raw bytes, not base64.
- **llama.cpp Load Options** (tab 3) sends `ctx_size`, `llamacpp_backend`, `llamacpp_args`, `merge_args`, and `save_options` to Lemonade's `/v1/load`. **Concurrent evaluations** sets both the app's concurrency and llama.cpp's `--parallel` slots. **Thinking effort** is sent with each request. None, Low, Medium, High, and X-High go out as `reasoning_effort` (top-level and in `chat_template_kwargs`). **None (Qwen 3)** sends `chat_template_kwargs.enable_thinking=false` instead, because Qwen's template rejects effort values it doesn't know. It also fills in Qwen's recommended non-thinking sampling.
- Load options and parameters can be saved as named presets.
- Most of the memory goes to the model server, and every page image becomes vision tokens. Smaller batches, fewer parallel slots, and `--cache-type-k q8_0 --cache-type-v q8_0` all help.

## Page resolution

There's no DPI setting. Each page is rendered to the pixel count the loaded model can actually use (its image budget), so the model gets full detail without the app rendering pixels the server would throw away. No server reports this budget directly, so DocProc4 measures it: it sends a text-only prompt and three synthetic test images (about 1, 2, and 16.8 MP) with a 1-token output limit, then reads `usage.prompt_tokens`. That gives pixels per token and the per-image token cap. For example, Qwen3-VL-style models measure at 4,096 tokens × 1,024 px ≈ 4.2 MP (about 212 DPI on Letter).

- The measurement runs automatically the first time a model is loaded or used, and is cached per server and model. **Re-measure** in the Model panel repeats it, for example after changing the server's image-token settings.
- Pages are sized individually, so mixed page sizes all use the full budget. A PDF opened before a model is measured renders at the last measured budget (or 4.2 MP) and is re-rendered automatically at Start if the budget differs. Visual-mode batches are kept.
- Fixed-resolution models, and models with no cap up to 16.8 MP, are detected and reported. If the measurement fails, the default is used and the reason is shown.
- Each batch reports prefill (prompt tokens and tok/s) separately from generation, and the Run dashboard averages both. That makes backend comparisons (e.g. ROCm vs Vulkan) straightforward.
