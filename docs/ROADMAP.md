# Roadmap

Status: ideas only, none started. Order inside a group is not a priority.
Audience: maintainers and future implementers (human or AI). Items marked "constraint" must hold when implemented.
Reference links point at PicGo / PicList / Obsidian plugins we looked at for ideas; we borrow design, not code.

## Small

1. **Gallery "copy as embed" and insert into note.** Formats: Markdown / HTML / URL / custom template with `$url`, `$fileName`, `$extName`; drag a tile into the editor or insert into the active note.
   Why: today only the raw URL can be copied. Ref: [PicList pasteTemplate](https://github.com/Kuingsmile/PicList/blob/dev/src/main/utils/pasteTemplate.ts). Reuse `EmbedRenderer`.
2. **URL rewrite rules.** Ordered regex list, first match wins (CDN domain switch, image-processing suffixes, jsDelivr).
   Ref: [PicGo-Core urlRewrite](https://github.com/PicGo/PicGo-Core/blob/dev/src/utils/urlRewrite.ts). Constraint: apply only when generating embeds / copied links; gallery keys, listing intersection and `remoteBytes` downloads keep provider URLs.
3. **Per-note frontmatter overrides** such as `image-auto-upload: false` to keep a note's pasted images local, plus a global auto-upload toggle.
   Ref: [s3-image-uploader](https://github.com/jvsteiner/s3-image-uploader).
4. **Opt-in provider-side thumbnail suffix** (PicList style, empty by default), e.g. `?x-oss-process=image/resize,w_320`.
   Notes: Aliyun / Tencent / Qiniu bill processing by original size, Upyun is free; must be signed for private buckets. Complements the local thumbnails (docs/semantic-search.md section 13).

## Medium

5. **Batch commands for the current note:** upload all local images, upload network images (with a blocked-domain list), download network images into the vault.
   Ref: [image-auto-upload main.ts](https://github.com/renmu123/obsidian-image-auto-upload-plugin/blob/master/src/main.ts), [download.ts](https://github.com/renmu123/obsidian-image-auto-upload-plugin/blob/master/src/download.ts).
   Notes: confirm count / size before re-uploading network images; keep the originating-note target; consider a resumable task queue ([PicList taskCheckpoint](https://github.com/Kuingsmile/PicList/blob/dev/src/main/services/taskCheckpoint.ts)).
6. **Delete from the note** (context menu on an embed: delete remote object + link), "used in" notes shown before deleting in the gallery, and an "unreferenced objects" filter.
   Ref: [deleter.ts](https://github.com/renmu123/obsidian-image-auto-upload-plugin/blob/master/src/deleter.ts).
   Constraints: needs a per-provider `keyFromUrl` in the registry; only with the delete capability (never Imgur); call semantic `onDeleted`; reference scan runs in memory via the metadata cache.
7. **Filename templates** replacing the fixed `nameRule` / `pathRule`: `{Y}{m}{d}{h}{i}{s}{ms}{timestamp}{uuid}{ulid}{str-N}{md5}{sha256-N}{filename}{localFolder:N}{noteName}{notePath}`. Content-hash keys give dedup for free.
   Ref: [PicList-Core rename.ts](https://github.com/Kuingsmile/PicList-Core/blob/dev/src/utils/common/rename.ts).
   Constraints: `listingKeyForUpload` must stay predictable; migrate existing enum values. Optional rename-before-upload dialog.
8. **Pre-upload image processing:** compress, convert to WebP, cap the longest edge, strip EXIF / GPS, skip-extension list, per-provider overrides.
   Ref: [PicList-Core compress.ts](https://github.com/Kuingsmile/PicList-Core/blob/dev/src/utils/common/compress.ts).
   Constraints: canvas-based (sharp is native, unusable in Obsidian); skip GIF / SVG; semantic `onUploaded` must index the processed bytes.

## Large

9. **Multiple named configs per provider** (work / personal buckets).
   Ref: [PicGo-Core UploaderConfigManager](https://github.com/PicGo/PicGo-Core/blob/dev/src/lib/UploaderConfigManager.ts). Needs a settings migration; semantic `scopeId` already separates indexes.
10. **Gallery multi-select:** batch delete / copy, bulk rename / move with a preview.
    Ref: [PicList BulkChangePreview](https://github.com/Kuingsmile/PicList/blob/dev/src/renderer/components/BulkChangePreview.vue).
    Constraint: a key change must move the index entry and thumbnail (adopt, no re-download).
11. **Optional upload history**, the only "gallery" for upload-only providers; stored per device outside `data.json`.
    Open decision: keeping the Imgur deletehash vs. the "Imgur is upload-only" rule.
12. **"Clean up the bucket":** combine content-hash keys (7) with unreferenced-object detection (6) to find and remove objects no note uses.

## Safety / semantic follow-ups

13. **Global deletion guard:** if one complete listing would tombstone more than ~50% of a scope's entries, hold the deletions until a second consistent listing confirms.
14. **Warn before changing the image-token budget.** It discards the whole index and re-downloads everything; optionally keep the old index so the user can switch back.
15. **Lint:** `remoteBytes` default timers use bare `setTimeout` (2 `prefer-window-timers` warnings) because Node tests have no `window`; find a clean injection.

## Explicitly out of scope

- Local HTTP upload server: Obsidian is the client, nothing needs to call us.
- Short URLs: third-party services and a privacy cost.
- Config sync: Obsidian Sync already covers `data.json`.
- Clipboard polling: the editor paste / drop events already cover it.
- Watermarks: not worth the canvas and UX surface.

## Already better than PicGo / PicList (keep)

- Display-only upload progress cards: nothing is written to the note on failure.
- Deletion only on complete listings.
- Direct provider APIs: no external app to install or keep running.
- Semantic search plus fingerprint-bound local thumbnails.
- Hash-verified downloads and bounded image parsing.
