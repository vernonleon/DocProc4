# DocProc4 — notes for Claude

Tauri 2 desktop app (Rust backend + vanilla JS UI, no framework or bundler) that renders PDF pages and sends them to a local OpenAI-compatible vision LLM server (usually Lemonade/llama.cpp) to transcribe them into Markdown. See README.md for user-facing docs.

## Working with Vernon

- Vernon (owner, GitHub `vernonleon`) is not a developer. Explain git/GitHub/packaging steps plainly, one shell command per code block.
- For non-trivial changes, or anything touching his server, accounts or GitHub, explain the plan and trade-offs first and wait for a go-ahead.
- Commit and push only when he asks. Commits use his repo-local identity.
- He values transcription fidelity over speed.

## Layout

- `src-tauri/src/main.rs`: all Rust. Server bridge (health, models, load/unload, streaming chat with think-tag splitting, `measure_prompt_tokens`), PDF render cache (MuPDF via the `mupdf` crate), settings persistence, save dialogs, local system stats.
- `ui/index.html`, `ui/styles.css`, `ui/app.js`: the UI. `app.js` holds all state and logic.
- `ui/real-backend.js`: Tauri bridge. `ui/stub.js`: mock backend used when `index.html` is opened in a plain browser. `ui/backend.js` picks one.
- `ui/markdown.js`: small, safe Markdown renderer for outputs (escapes all HTML; links render as text).
- `ui/repetition.js`: detects a model stuck in a loop; `runBatch` uses it to stop and fail the batch.
- `ui/vendor/`: pdf.js, the fallback renderer if MuPDF can't open a PDF.
- `packaging/aur/`: PKGBUILD (not published). `.github/workflows/build-installers.yml`: Linux + Windows installers to a draft release.

## Build and test

- `npm run dev` and `npm run build` go through `scripts/tauri-local.js`, which sets `NO_STRIP=true` (linuxdeploy's strip breaks on CachyOS libraries).
- The repo lives on a pCloud mount that can't execute binaries. On Vernon's machine, git-ignored `.cargo/config.toml` files send Cargo output to `~/.cache/docproc4-build/target`, and the Tauri CLI lives in `~/.cache/docproc4-build/npm`.
- Rust tests: `cargo test` in `src-tauri/` (13 tests, including a real MuPDF render of `ui/test-assets/test.pdf`).
- Loop detector (`ui/repetition.js`): `node scripts/test-repetition.js`.
- UI: serve `ui/` over HTTP (e.g. `python3 -m http.server --directory ui`) and use the mock backend. `?demo=visual|panels` fills demo data.
- Real-app checks: build a scratch copy with `TAURI_CONFIG` pointing the window at a test page, and use a fake OpenAI server. Don't point tests at Vernon's real Lemonade server without asking.

## Design decisions (keep unless Vernon says otherwise)

- **No DPI setting.** Pages render at the loaded model's *measured* image budget. `measureImageBudget` in `app.js` counts `usage.prompt_tokens` for synthetic 1 MP, 2 MP and 16.8 MP images. Results are cached per server + model; the default is 4096 tokens × 32×32 px ≈ 4.2 MP. The budget must stay dynamic per model, never hard-coded to one model family. He wants maximum image tokens, so don't add `--image-min/max-tokens` controls.
- **No margin cropping and no PDF text-layer extraction.** Keep to images, for fidelity.
- **Fast / Efficient mode** (rabbit/turtle in the title bar). Efficient renders only thumbnails up front, on disk; full pages render one at a time just before sending and are deleted after.
- **Thinking effort:** None / Low / Medium / High / X-High are sent as `reasoning_effort` (top-level and in `chat_template_kwargs`). "None (Qwen 3)" sends `chat_template_kwargs.enable_thinking=false`, because Qwen's template rejects unknown effort values. He mostly uses Qwen 3.x models.
- **Concurrent evaluations** also sets llama.cpp `--parallel` when load options are sent. On ROCm, concurrent batches make the model loop ("////"); Vernon runs 1 on ROCm and declined an in-app warning.
- **Run recovery:** each finished batch rewrites `recovery/last-run.json` in the app data dir (atomic temp-file + rename). Launch offers Restore/Discard; the file is removed on Save, Discard or a new Start. Page images are not kept, so re-running unfinished batches needs the same PDF (name + page count) loaded again.
- **Licensing:** MuPDF is AGPL-3.0, so DocProc4 is `AGPL-3.0-or-later` (LICENSE file). The GitHub repo is private; AUR packaging is prepared but not published.

## Releases

Bump the version in `src-tauri/tauri.conf.json` (keep `Cargo.toml` and `package.json` in step), then push a `vX.Y.Z` tag or run the "Build installers" workflow. It attaches `.deb`, `.rpm`, AppImage, `.msi` and setup `.exe` to a draft release.
