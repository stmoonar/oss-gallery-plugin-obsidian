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
- `src/settings/SettingsManager.ts`: settings UI, active provider selection, global object rules, preview settings, gallery thumbnails (`ThumbnailSettingsSection`), semantic search (`SemanticSettingsSection`); `settingGroups.ts` groups each section (`SettingGroup` on 1.11+, plugin fallback container below)
- `src/providers/`: provider implementations and registry metadata
- `src/views/OssGalleryView.ts`: gallery view
- `src/components/`: gallery UI pieces (`SearchComponent` with regex/semantic toggles and the pure mode rules in `searchMode.ts`, `ImageGrid` (listbox/option tiles, roving tabindex, multi-select, drag-to-embed), `SemanticIndexBar` progress/status strip, `IndexStatusDetails` shared by the details dialog and settings). Pure, unit-tested gallery rules: `gridNavigation.ts` (arrow/Home/End index math), `tileSelection.ts` (Ctrl/Shift selection), `galleryUx.ts` (empty states, focus after delete, batch delete summary), `semanticCutoff.ts` (how many best semantic matches to show first, then "Show more" pages), `zoomMath.ts` (lightbox fit/zoom/pan/swipe). The lightbox is `src/modals/ImagePreviewModal.ts`
- `src/editor/`: CM6 editor extension and Reading-mode post processor that render upload progress cards (display layer only, never written to notes; card buttons go through `UploadProgressStore.requestAction`), `UploadAnnouncer` (polite live region for upload results)
- Upload flow: `src/services/UploadQueue.ts` (Obsidian-free state machine, unit tested: one upload at a time, cancel = stop waiting since `requestUrl` cannot abort, failed uploads keep placeholder + File with Retry / Save to vault / Remove, unload rewrites unfinished placeholders to a readable "did not finish" text), `uploadFileTriage.ts` (grouped notice for files the provider rejects), `src/providers/requiredFields.ts` (required fields per provider, shared by the "not set up" notice and the settings tab markers; mirror `isConfigured` in the registry when changing providers, a unit test checks it)
- `src/services/`: upload, sync, object key, search, embed rendering; `LazyImageService` + `imageLoadQueue.ts` load gallery tiles (with a `TileSource`: cached thumbnail first through its own small queue, then the original once as bytes through the 6-slot network queue, falling back once to `<img src>`; without one: `<img src>` as before); `remoteBytes.ts` (remote image bytes via requestUrl + signed GET fallback, 50 MB cap, timeout, abort; shared by thumbnails and semantic indexing)
- `src/thumbnails/`: local gallery thumbnails, independent of semantic search (design: `docs/semantic-search.md` §13): `ThumbnailCache` (files, manifest, LRU size cap), `ThumbnailGenerator` (lazy thumbnails from originals the gallery downloads), `ThumbnailService` (tile sources, listing/delete hooks, `put` for semantic indexing), `encode.ts` (DOM-only encoder, also used by the semantic worker), Obsidian glue `GalleryThumbnails.ts`. Never imports `src/semantic` (a unit test enforces it)
- `src/utils/`: shared helpers, incl. modules used by both thumbnails and semantic search: `objectScope.ts` (fingerprints, scope ids), `vaultId.ts`, `appDir.ts` (per-device app dir), `imageHeader.ts` (header dimension checks), `imageType.ts` (format sniffing), `timers.ts`
- `src/semantic/`: opt-in semantic image search (design: `docs/semantic-search.md`): model download manager, WebGPU probe, worker host (`WorkerEmbeddingBackend`, `FakeEmbeddingBackend`), `VectorStore` (+ `IndexStatusStore` sidecar), `SemanticIndexService` (per-scope indexing, deletion sync protocol, traffic confirmation), `SemanticSearchService`, image format handling (`imageFormat.ts`, `svgRasterizer.ts`, header dimension checks in `src/utils/imageHeader.ts`, bounded TIFF structure parsing in `tiffStructure.ts`; never call `UTIF.decode` on untrusted bytes), remote byte fetching (`src/services/remoteBytes.ts`), status texts (`statusText.ts`), Obsidian glue `SemanticIndexing.ts` (gallery hooks, status bar, dialogs), self-test; `src/semantic/worker/` (incl. the UTIF.js TIFF decoder) is bundled separately into `dist/semantic-worker.js` and must never be imported by `main.ts` code (the production build asserts main.js has no transformers.js)
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
- `thumbnails`: `{ enabled, maxSizeMB }` (local gallery thumbnails, independent of semantic search; `enabled` default true; `maxSizeMB` = cache cap per vault on this device, default 500, `THUMBNAIL_CACHE_MIN_MB`..`THUMBNAIL_CACHE_MAX_MB` = 10..100000)

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
- Local gallery thumbnails (`src/thumbnails/`, docs §13) are independent of semantic search: they work for every listable provider with a `getIndexIdentity`, with the model not installed or semantic search off. Dependency direction: `src/semantic` may use `src/thumbnails` (`ThumbnailWriter.put`, and the DOM-only `encode.ts` in the worker), never the reverse; shared code lives in `src/utils/` / `src/services/remoteBytes.ts`.
  - Storage: per device, outside the vault, independent of `semantic.indexDir`: `<appDir>/thumbs/<vaultId>/<scopeId>/` (`thumbs.json` manifest `{ key: { fp, ext, bytes, atime } }` + `<sha256(key)[:32]>-<sha256(fp)[:12]>.webp|.jpg`, written tmp + rename). Scope ids are the semantic index scope ids (`computeScopeId` in `src/utils/objectScope.ts`). Only names `isThumbnailFileName` accepts are ever deleted.
  - Lazy generation: a tile without a matching thumbnail loads the original once as bytes (requestUrl through `remoteBytes.ts` with the signed GET fallback; Local reads the file), shows it from a Blob URL, then `ThumbnailGenerator` makes the thumbnail from the same bytes (header size check first, bounded concurrency, dropped when busy) and the tile switches to it. GIF and SVG tiles load the original through `<img>` and get no lazy thumbnail; TIFF keeps the placeholder unless a thumbnail exists. Any failure falls back once to `<img src=url>`; thumbnail failures never break a tile.
  - Semantic indexing adds thumbnails as a by-product (the worker encodes them from the bitmap it decodes; never changes vectors, never fails an embedding; GIFs get none) through `put`, only while `thumbnails.enabled`.
  - Lifecycle (gallery glue, works with semantic off): delete in the gallery → removed; every listing adopts upload fingerprints; a complete listing prunes unlisted keys under its prefix (except thumbnails written/viewed since the listing started); a changed fingerprint is replaced.
  - Size cap: `atime` is updated on display (coarse, debounced manifest write); above `thumbnails.maxSizeMB` (all scopes of the vault) the least recently viewed are evicted down to 90%. Eviction runs in the background after writes, on startup and when the cap changes; never blocks rendering.
  - "Clear thumbnails" deletes only thumbnail files; "Clear index" and "Delete model" never touch thumbnails and vice versa. Tiles use a thumbnail only when its fingerprint matches the listed object; preview, copy URL and embeds always use originals; with thumbnails off the gallery loads originals through `<img>` exactly as before.
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
