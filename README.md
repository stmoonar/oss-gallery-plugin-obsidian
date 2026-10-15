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
- Optional semantic image search (WebGPU, model downloaded on request; see [below](#semantic-image-search-optional))

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
- **Semantic image search**: model download/verify/delete, model directory, image detail, automatic indexing (see [Semantic image search](#semantic-image-search-optional))

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

> In development. This version sets up the model and can test it (command **Semantic search: run self-test**); indexing and searching images by description arrive in a later release.

Semantic search finds images by describing them in English or Chinese. It is **off by default** and nothing is downloaded until you ask.

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
- **Self-test:** after the model is installed, run **Semantic search: run self-test** from the command palette. It loads the model on your GPU, embeds a few test queries, a generated test image and up to two images from your vault (the active image first), and shows load time, latency and a similarity table. Nothing leaves your computer; the model runs offline from the model directory.

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
- **Semantic search model (opt-in).** Only after you confirm the download dialog, the plugin downloads files from `github.com` (this plugin's releases, served from `release-assets.githubusercontent.com`) and `huggingface.co` (served from its CDN), or from the mirrors you set under **Download sources**, and writes them to the model directory outside your vault. No images or queries are sent anywhere; the model runs locally on your GPU.
- **Credentials are stored in plain text.** Access keys, tokens, and secrets are saved in the plugin's `data.json` under your vault's `.obsidian/plugins/` folder. If you sync or commit your vault (Git, cloud drives), exclude that file or use least-privilege keys.
- **No telemetry.** The plugin does not collect usage data or crash reports.
