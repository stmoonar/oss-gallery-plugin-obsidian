# AGENTS.md

This repository contains an Obsidian plugin that uploads media and documents to multiple OSS providers and provides a gallery view for providers that support listing.

## Common commands

```bash
pnpm run lint  # always pass before commit
pnpm test      # vitest unit tests (tests/**/*.test.ts, Node env)
pnpm run build
pnpm run version
tsc -noEmit -skipLibCheck
pnpm run dev:install -- --vault <path>  # copy dist/ into a test vault (or OBSIDIAN_TEST_VAULT); never touches data.json
```

## Architecture

- `src/main.ts`: plugin entrypoint, commands, event registration, settings load/save
- `src/settings/SettingsManager.ts`: settings UI, active provider selection, global object rules, preview settings
- `src/providers/`: provider implementations and registry metadata
- `src/views/OssGalleryView.ts`: gallery view
- `src/components/`: gallery UI pieces
- `src/editor/`: CM6 editor extension and Reading-mode post processor that render upload progress cards (display layer only, never written to notes)
- `src/services/`: upload, sync, object key, search, embed rendering
- `src/semantic/`: opt-in semantic image search (design: `docs/semantic-search.md`): model download manager, WebGPU probe, worker host (`WorkerEmbeddingBackend`, `FakeEmbeddingBackend`), `VectorStore`, self-test; `src/semantic/worker/` is bundled separately into `dist/semantic-worker.js` and must never be imported by `main.ts` code (the production build asserts main.js has no transformers.js)
- `src/semantic/`: optional semantic image search (design: `docs/semantic-search.md`): WebGPU probe, asset manifest, model download manager, `worker/entry.ts` (built separately into `dist/semantic-worker.js`, never into main.js)
- `src/types/`: shared types for settings, providers, and gallery state
- `src/locale/` and `src/i18n.ts`: localization

## Current settings model

Global settings:

- `activeProvider`
- `basepath`
- `nameRule`
- `pathRule`
- `imgPreview`
- `videoPreview`
- `audioPreview`
- `docsPreview`
- `embedFormat`
- `semantic`: `{ enabled, modelDir, imageTokenBudget: 70 | 140 | 280, autoIndex, hfEndpoint, githubMirror }` (semantic image search; `enabled` becomes true only after a fully verified model install; `hfEndpoint` / `githubMirror` are optional `https://` download mirrors, `''` = official)

Provider settings live under `settings.providers`.

## Provider model

Provider metadata is centralized in `src/providers/registry.ts`.

Each provider entry defines:

- label
- capabilities: upload/list/delete
- default settings
- configuration validation
- factory function

Use the registry as the source of truth when adding or changing providers.

## Notes for changes

- Keep README, `manifest.json`, and settings behavior aligned.
- If you add user-facing strings, update `src/locale/en.ts`, `src/locale/zh-cn.ts`, and `src/locale/zh-tw.ts`.
- Gallery features must respect provider capabilities. Imgur is upload-only in this plugin.
- `basepath`, `nameRule`, and `pathRule` all affect final object keys.
- Unit tests live in `tests/` (vitest). Code under test must not import `obsidian` or transformers.js; inject timers/fs instead of using globals.
- `src/semantic/assets.generated.ts` is written by `esbuild.config.mjs` on every build (hashes of the semantic runtime release assets). Commit it after a build; never edit it by hand. Model files are pinned to a Hugging Face commit in `src/semantic/assets.ts`.
- Semantic search files live outside the vault. Deleting them must only remove files the plugin knows about, never the whole model directory.
- Download mirrors (`src/semantic/mirrors.ts`) change only download URLs. Local file names and SHA-256 hashes never depend on them, so changing a mirror must not invalidate installed files.

## Compact Instructions

When compressing, preserve in priority order:

1. Architecture decisions (NEVER summarize)
2. Modified files and their key changes
3. Current verification status (pass/fail)
4. Open TODOs and rollback notes
5. Tool outputs (can delete, keep pass/fail only)
