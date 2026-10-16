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
- `src/components/`: gallery UI pieces (`SearchComponent` with regex/semantic toggles and the pure mode rules in `searchMode.ts`, `ImageGrid`, `SemanticIndexBar` progress/status strip, `IndexStatusDetails` shared by the details dialog and settings)
- `src/editor/`: CM6 editor extension and Reading-mode post processor that render upload progress cards (display layer only, never written to notes)
- `src/services/`: upload, sync, object key, search, embed rendering
- `src/semantic/`: opt-in semantic image search (design: `docs/semantic-search.md`): model download manager, WebGPU probe, worker host (`WorkerEmbeddingBackend`, `FakeEmbeddingBackend`), `VectorStore` (+ `IndexStatusStore` sidecar), `SemanticIndexService` (per-scope indexing, deletion sync protocol, traffic confirmation), `SemanticSearchService`, image format handling (`imageFormat.ts`, `svgRasterizer.ts`, header dimension checks in `imageHeader.ts`, bounded TIFF structure parsing in `tiffStructure.ts`; never call `UTIF.decode` on untrusted bytes), remote byte fetching (`remoteBytes.ts`, requestUrl + signed GET fallback), status texts (`statusText.ts`), Obsidian glue `SemanticIndexing.ts` (gallery hooks, status bar, dialogs), self-test; `src/semantic/worker/` (incl. the UTIF.js TIFF decoder) is bundled separately into `dist/semantic-worker.js` and must never be imported by `main.ts` code (the production build asserts main.js has no transformers.js)
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
- `semantic`: `{ enabled, modelDir, indexDir, imageTokenBudget: 70 | 140 | 280, autoIndex, hfEndpoint, githubMirror }` (semantic image search; `enabled` becomes true only after a fully verified model install; `indexDir` = per-device index root outside the vault, `''` = `<appDir>/indexes`; `hfEndpoint` / `githubMirror` are optional `https://` download mirrors, `''` = official)

Provider settings live under `settings.providers`.

## Provider model

Provider metadata is centralized in `src/providers/registry.ts`.

Each provider entry defines:

- label
- capabilities: upload/list/delete
- default settings
- configuration validation
- factory function
- optional `getIndexIdentity` (`src/providers/indexIdentity.ts`): settings fields that decide which objects a listing sees (bucket, endpoint, repo, path...; never credentials), hashed into the semantic index scope id. Without it the provider cannot be indexed.

Use the registry as the source of truth when adding or changing providers.

## Notes for changes

- Keep README, `manifest.json`, and settings behavior aligned.
- If you add user-facing strings, update `src/locale/en.ts`, `src/locale/zh-cn.ts`, and `src/locale/zh-tw.ts`.
- Gallery features must respect provider capabilities. Imgur is upload-only in this plugin.
- `basepath`, `nameRule`, and `pathRule` all affect final object keys.
- Unit tests live in `tests/` (vitest). Code under test must not import `obsidian` or transformers.js; inject timers/fs instead of using globals.
- `src/semantic/assets.generated.ts` is written by `esbuild.config.mjs` on every build (hashes of the semantic runtime release assets). Commit it after a build; never edit it by hand. Model files are pinned to a Hugging Face commit in `src/semantic/assets.ts`.
- Semantic search files live outside the vault. Deleting them must only remove files the plugin knows about, never the whole model directory.
- `listImages` returns `ListResult { items, complete, prefix }`. Any cap (`MAX_LIST_PAGES`, `MAX_LIST_REQUESTS`, depth limits) or partial failure must set `complete = false` (use `ListingCollector` / `collectPages` in `src/providers/shared/listing.ts`); the semantic index only deletes based on complete listings. Fill `etag` when the API returns one. Implement `listingKeyForUpload` when the listed key of an upload is predictable.
- Semantic indexes live per device in `semantic.indexDir` (`<indexDir>/<vaultId>/<scopeId>/`), never in the vault. "Clear index" removes only the plugin's index files; "Delete model" never touches indexes and vice versa.
- Remote indexing downloads images: it must never start without the traffic confirmation (`SemanticIndexService.start`, rules in `trafficPromptReason`).
- Remote image bytes go through Obsidian `requestUrl` (`src/semantic/remoteBytes.ts`), never `fetch()` (bucket CORS, private buckets). Providers that sign their own requests can implement `signedObjectGet(key)` for private buckets (S3-compatible ones do).
- Semantic UI in the gallery must respect availability (`SemanticIndexing.availability`: installed, enabled, WebGPU, listable provider, index exists) and must never show images that are not in the current listing (`intersectHits`).
- The build writes `dist/THIRD_PARTY_NOTICES.txt` (licenses of everything in the worker bundle and the ORT files, `scripts/third-party-notices.mjs`). It is a release asset (`release.yml`), not part of the hashed runtime manifest. Both bundles use esbuild `charset: "utf8"`.
- Download mirrors (`src/semantic/mirrors.ts`) change only download URLs. Local file names and SHA-256 hashes never depend on them, so changing a mirror must not invalidate installed files.

## Compact Instructions

When compressing, preserve in priority order:

1. Architecture decisions (NEVER summarize)
2. Modified files and their key changes
3. Current verification status (pass/fail)
4. Open TODOs and rollback notes
5. Tool outputs (can delete, keep pass/fail only)
