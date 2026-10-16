# Obsidian OSS Gallery Plugin

### English | [中文](./README-zh.md)

This plugin uploads files from Obsidian to multiple object storage providers and offers a gallery view for providers that support listing.

> **Requires** Obsidian 1.7.2 or later.

> **Note**: This plugin is desktop-only. It relies on Node.js APIs (crypto signing, local file system) that are not available in Obsidian mobile.

It started as a fork of [Obsidian Minio Uploader Plugin](https://github.com/seebin/obsidian-minio-uploader-plugin) and now supports a broader multi-provider workflow.

## Supported providers

- **Local**: desktop-only local file storage with gallery management
- **SM.MS**: image hosting
- **GitHub**: repository-backed uploads
- **Aliyun OSS**
- **Tencent COS**
- **Qiniu Kodo**
- **Upyun USS**
- **Imgur**: image upload only, no gallery listing or deletion in this plugin
- **Cloudflare R2**: S3-compatible object storage
- **S3**: generic S3-compatible provider (AWS S3, DigitalOcean Spaces, Backblaze B2, etc.)
- **MinIO**: self-hosted S3-compatible object storage

## Features

- Upload files from the command palette, paste, or drag and drop
- Supported file types: images, video, audio, `.doc`, `.docx`, `.pdf`, `.pptx`, `.xls`, `.xlsx`
- Global object naming and path rules
- Optional base path prefix for all uploads
- Configurable embed output for image, video, audio, and document preview
- Gallery view for providers that support listing
- URL search with plain text or regex mode
- One-click URL copy
- Delete from the gallery for providers that support deletion
- Full-screen image preview
- Lazy loading, batch rendering, back-to-top control, and background refresh for the gallery
- Local gallery thumbnails: each image is downloaded once, then shown from a small thumbnail kept on this device (size-capped, works without semantic search)
- Optional on-device semantic image search: find images by description or by similarity (WebGPU, model downloaded on request; see [below](#semantic-image-search-optional))

![upload](./docs/assets/upload.gif)

---

![delete](./docs/assets/delete.gif)

## Settings

Choose an active provider in the plugin settings, then configure:

### Global settings

- **Base path**: optional prefix applied to every uploaded object key; the gallery only lists files under it (and under the provider's own path prefix, if set)
- **Object naming rules**
  - `local`
  - `time`
  - `timeAndLocal`
- **Object path rules**
  - `root`
  - `type`
  - `date`
  - `typeAndDate`
- **Preview**
  - image preview on or off
  - video preview on or off
  - audio preview on or off
  - document preview provider: disabled, Google Docs, or Office Online
- **Gallery thumbnails** (on by default, independent of semantic search)
  - The first time a gallery tile is shown, the original is downloaded once (Obsidian's request API; Local reads the file from disk), shown, and a small copy (longest side 320 px, WebP) is saved on this device, outside the vault: Windows `%LOCALAPPDATA%\obsidian-oss-gallery\thumbs`, macOS `~/Library/Application Support/obsidian-oss-gallery/thumbs`, Linux `~/.cache/obsidian-oss-gallery/thumbs`. Later views show the thumbnail without downloading. Semantic indexing saves thumbnails too.
  - Preview, **Copy URL** and embeds always use the original. Animated GIFs and SVGs load the original as before; TIFF tiles show a thumbnail only if indexing made one.
  - **Thumbnail cache size** (default 500 MB per vault on this device): above it, the least recently viewed thumbnails are deleted.
  - **Clear thumbnails** deletes only thumbnail files; the semantic index and the model are not touched (and their actions never touch thumbnails). Turn thumbnails off to load originals exactly as before.
- **Semantic image search**: model download/verify/delete, model directory, index directory, image detail, automatic indexing, index status and clearing (see [Semantic image search](#semantic-image-search-optional))

### Provider settings

#### Local

- Available in Obsidian desktop only
- Storage path: vault-relative directory, or absolute directory inserted as `file:///` links
- Use vault-relative path: toggle (default on, requires a local file-system vault)
- Delete to trash: move deleted files to system trash (default on)

#### SM.MS

- S.EE API key (SM.MS has migrated to S.EE; create a key under S.EE **Tools > API Token**)

#### GitHub

- Repository: `owner/repo`
- Branch
- Personal access token
- Custom URL: optional, for CDN such as jsDelivr

#### Aliyun OSS

- Access Key ID
- Access Key Secret
- Bucket
- Region, for example `oss-cn-hangzhou`
- Path prefix: optional
- Custom domain: optional

#### Tencent COS

- Secret ID
- Secret Key
- Bucket
- Region, for example `ap-shanghai`
- Path prefix: optional
- Custom domain: optional

#### Qiniu Kodo

- Access Key
- Secret Key
- Bucket
- CDN domain URL
- Storage area
- Path prefix: optional

#### Upyun USS

- Operator name
- Password
- Service name
- Acceleration domain URL
- Path prefix: optional
- Image processing suffix: optional

#### Imgur

- Client ID
- Proxy URL: optional, required in some regions

Note: Imgur uploads are supported for image files only; gallery listing and deletion are not.

#### Cloudflare R2

- Account ID
- Access Key ID
- Secret Access Key
- Bucket
- Public URL: custom domain or `r2.dev` URL

#### S3 (Generic)

- Endpoint: S3-compatible endpoint (e.g. `s3.amazonaws.com`)
- Region
- Access Key ID
- Secret Access Key
- Bucket
- Use SSL: toggle (default on)
- Force path style: use `endpoint/bucket/key` instead of `bucket.endpoint/key` (default on)
- Public URL: optional custom URL for file access

#### MinIO

- Endpoint: host name or complete URL; an explicit `http://` / `https://` scheme and port take precedence
- Port: used when Endpoint is a host name without a port
- Use SSL: used when Endpoint does not include a URL scheme
- Access Key
- Secret Key
- Bucket
- Region: optional
- Custom domain: optional

For MinIO public access, enable anonymous or otherwise publicly accessible object URLs in your bucket policy.

![Settings](./docs/assets/minio-bucket-setting.png)

## Semantic image search (optional)

Semantic search finds images by describing them in English or Chinese, and finds images that look like a given one. It is **off by default** and nothing is downloaded until you ask.

**Quick start:** **Settings → Semantic image search → Download model** → open the gallery → **Build index** (under the search box) → turn on the ✨ toggle next to the search box, type a description (for example "a cat on a sofa") and press **Enter**.

- **Requirements:** desktop Obsidian with **WebGPU** and a hardware GPU (integrated graphics are fine). The settings page checks this first and explains why it is unavailable (outdated Obsidian or graphics driver, remote desktop / virtual machine, software-only renderer). There is no CPU fallback.
- **Download:** about **343 MB**, only after you confirm the file list in **Settings → Semantic image search → Download**:
  - runtime (about 27 MB): `semantic-worker.js` and the ONNX Runtime WebAssembly files, from this plugin's GitHub release
  - model (about 316 MB): [EmbeddingGemma 2](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX) text and vision encoders (q4), from Hugging Face at a pinned revision
  - every file is checked against a SHA-256 hash built into the plugin before it is used; interrupted downloads resume file by file
- **Stored outside your vault**, shared by every vault on this computer and never synced:
  - Windows: `%LOCALAPPDATA%\obsidian-oss-gallery\models`
  - macOS: `~/Library/Application Support/obsidian-oss-gallery/models`
  - Linux: `$XDG_CACHE_HOME/obsidian-oss-gallery/models` (default `~/.cache/...`)
  - change it with **Model directory** (absolute path)
- **Delete:** **Delete model** removes only the files the plugin downloaded (and directories left empty), not other files in the directory. It affects every vault that uses the same directory.
- **Download sources (optional):** downloads go through Node's HTTPS client, which does **not** use the system proxy. If Hugging Face or GitHub is blocked or slow where you are (for example in mainland China), set them under **Settings → Semantic image search → Download sources**:
  - **Hugging Face endpoint** replaces `https://huggingface.co` for the model files. The mirror must serve the same `/<repo>/resolve/<revision>/<file>` paths, for example `https://hf-mirror.com`.
  - **GitHub mirror** is a proxy prefix for the runtime files; the full GitHub URL is appended after it: `https://gh-proxy.com` requests `https://gh-proxy.com/https://github.com/stmoonar/oss-gallery-plugin-obsidian/releases/download/<version>/<file>`.
  - Only `https://` addresses are accepted (trailing slashes are removed). Leave empty for the official sites.
  - Mirrors cannot change what gets installed: every file must still match the SHA-256 hash built into the plugin, and the download dialog shows the hosts actually contacted. Changing a mirror does not affect files already installed.
  - If no mirror works for you, use the offline install below.
- **Offline install:** copy the files into the model directory with the same layout (`huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/<revision>/...` and `runtime/<plugin version>/...`), then press **Verify** or **Download**: files that pass the hash check are kept and not downloaded again.
- **Settings:** image detail (70/140/280 image tokens, default 70; changing it later rebuilds the index) and automatic indexing.
- **Indexing:** every listable provider can be indexed (not Imgur). Press **Build index** / **Update index (N new)** in the gallery (or run **Semantic search: index current provider now**). While it runs, a bar at the top of the gallery shows the count, the current file, pause/resume and stop; the status bar shows the same count (click to pause/resume). Stopping keeps what was indexed; the next start continues.
  - **Local** reads files from disk: no network traffic, no confirmation.
  - **Remote providers** download each image once to analyze it on your computer. Indexing never starts without a dialog showing the number of images, the download size and how many are already indexed. With **Index automatically** on, new images are indexed after the gallery refreshes; it asks the first time on each device and again only when more than 200 MB would be downloaded.
  - Images are downloaded with Obsidian's own request API (no bucket CORS rules needed, uses the system proxy) from the same URL the gallery shows. For **private** S3 / R2 / MinIO buckets a signed request is used when the public URL is refused. Images that still can't be read (for example a private Aliyun/Tencent/Qiniu bucket) are listed as *failed* with "access denied: check the bucket permissions".
  - Images uploaded through the plugin are indexed from the file in hand (no download); images deleted in the gallery leave the index right away; images deleted elsewhere are hidden from results at the next full listing and removed after the second.
  - **Index files** are stored per device, outside your vault, and never synced (each device builds its own index): Windows `%LOCALAPPDATA%\obsidian-oss-gallery\indexes`, macOS `~/Library/Application Support/obsidian-oss-gallery/indexes`, Linux `~/.cache/obsidian-oss-gallery/indexes`. Change it with **Index directory**; **Clear index for this vault** deletes only this vault's index files. Deleting the model does not touch indexes, and the reverse.
  - **Thumbnails:** while an image is indexed, its [gallery thumbnail](#global-settings) is saved as a by-product (no extra download; TIFF tiles get a real thumbnail this way). **Clear index for this vault** keeps thumbnails, **Clear thumbnails** keeps the index.
- **Image formats:** JPEG, PNG, WebP, GIF (first frame), BMP, ICO and AVIF are read directly (the gallery lists `.avif` files too). **SVG** is rasterized (scripts and external references are never loaded) and **TIFF** is decoded with the bundled [UTIF.js](https://github.com/photopea/UTIF.js) (MIT); both are listed as *converted*. HEIC/HEIF, PSD, camera RAW and unreadable files are *unsupported* and skipped.
- **Search:** the ✨ toggle next to the search box switches it to semantic mode (it is disabled, with the reason in its tooltip, until the model is installed and the provider has an index; the regex toggle is off in this mode). Type a description and press **Enter**: all images are sorted by similarity, best first, with a small score on each tile. The first search loads the search model (about 1.5 s). **Esc**, the clear button or **×** returns to all images. There is no cut-off: scores only rank results.
- **Find similar images:** right-click an image (or use the hover button) → **Find similar images**. The gallery shows the images closest to it under "Similar to *name* ×".
- **Index status:** when idle, a chip under the search box reads like "1,234 indexed · 3 converted · 2 unsupported". Click it for the details: converted files (with their source format) and unsupported / failed files with the reason; click a file name to show it in the gallery, or **Retry failed**. The status bar shows "Semantic: N indexed"; click it to open the gallery in semantic mode. The settings page shows the same lists.
- **Self-test:** after the model is installed, run **Semantic search: run self-test** from the command palette. It loads the model on your GPU, embeds a few test queries, a generated test image and up to two images from your vault (the active image first), and shows load time, latency and a similarity table. Nothing leaves your computer; the model runs offline from the model directory.
- **Third-party licenses:** the runtime bundles [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0), ONNX Runtime Web (MIT), UTIF.js and pako (MIT/Zlib) and a few of their dependencies. Their license texts are in `THIRD_PARTY_NOTICES.txt`, attached to every GitHub release next to `semantic-worker.js`.

## Network use and privacy

This plugin makes network requests only to the storage service you configure, plus GitHub and Hugging Face (or the mirrors you set) if you choose to download the semantic search model. It has no telemetry, analytics, or ads, and sends nothing to the plugin author.

- **Files are sent to the service you choose.** Uploading, listing, and deleting contact the active provider's endpoint:
  - S3 (Generic) / MinIO: the endpoint you enter (for MinIO, `http://` or `https://` as configured)
  - Cloudflare R2: your R2 S3 endpoint (`<account>.r2.cloudflarestorage.com`)
  - Aliyun OSS: `<bucket>.<area>.aliyuncs.com` (or your custom domain)
  - Tencent COS: `<bucket>.cos.<region>.myqcloud.com`
  - Qiniu Kodo: `up-<area>.qiniup.com` and the Qiniu API hosts
  - Upyun USS: `v0.api.upyun.com`
  - GitHub: `api.github.com` (links use `raw.githubusercontent.com` unless you set a custom domain)
  - Imgur: `api.imgur.com`, or the proxy you configure
  - SM.MS (via S.EE): `s.ee/api/v1`
  - Local: no network access
- **Document preview.** If you set the document preview option to Google Docs or Office Online, the public URL of the document is sent to `docs.google.com/viewer` or `view.officeapps.live.com` so they can render it. Keep it Disabled to avoid this.
- **Accounts and cost.** Every provider except Local needs an account (or self-hosted server) of your own. Some services are paid; check each provider's pricing.
- **Local files outside the vault.** The Local provider can use an absolute storage path. In that mode it reads, writes, and (optionally) moves to the system trash files outside your vault, because the gallery needs to list and manage the directory you chose. It only touches that directory.
- **Gallery thumbnails.** Gallery tiles download each image from your storage service once (as before, but through Obsidian's request API) and keep a small thumbnail per device outside the vault, so later views need no download. Turn it off under **Gallery thumbnails** to load images directly again.
- **Semantic image index (opt-in).** Indexing a remote provider downloads its images from that same storage service, only after you confirm the size estimate. Images are analyzed locally; nothing is uploaded.
- **Semantic search model (opt-in).** Only after you confirm the download dialog, the plugin downloads files from `github.com` (this plugin's releases, served from `release-assets.githubusercontent.com`) and `huggingface.co` (served from its CDN), or from the mirrors you set under **Download sources**, and writes them to the model directory outside your vault. No images or queries are sent anywhere; the model runs locally on your GPU.
- **Credentials are stored in plain text.** Access keys, tokens, and secrets are saved in the plugin's `data.json` under your vault's `.obsidian/plugins/` folder. If you sync or commit your vault (Git, cloud drives), exclude that file or use least-privilege keys.
- **No telemetry.** The plugin does not collect usage data or crash reports.
