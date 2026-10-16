# 语义搜索（Semantic Search）设计文档

状态：设计已定，P0 spike 完成，P1–P4 已实施（分支 `feat/semantic-search`）；P4 的端到端验收（Local + 一个 S3 兼容 provider，真实 GPU）待维护者按 §10 手工完成。
读者：维护者与后续实施者（人或 AI）。本文是实施依据，标注"已定"的内容不要自行更改。
P0 实测报告：分支 `spike/semantic-search-p0`，commit `6683806`，文件 `spike/semantic-p0/RESULTS.md`（下文引用为 [P0]）。

## 1. 背景与目标 / 非目标

### 目标

对所有支持 `list` 能力的 provider（`providerRegistry` 中除 Imgur 外全部）的图库提供：

1. **文本搜图**：输入自然语言（中英文），按语义相似度对图片排序。
2. **以图搜图**：在某张图的右键菜单中"找相似图片"，复用已存向量。

模型：EmbeddingGemma 2（Google，2026-10-06，Apache 2.0），文本与图像共享 768 维空间，支持 Matryoshka 截断（768/512/256/128）。
模型包：`onnx-community/embeddinggemma-2-ONNX`，dtype `q4`，只加载 text + vision_encoder（不加载 audio），约 316 MB / 10 个文件 [P0 §1]。

### 非目标

- 不做 CPU / wasm 回退（见决策 D2）。
- 不做 OCR、图片内文字检索、视频/音频/文档的语义搜索（只处理图片）。
- 不做绝对分数阈值过滤（见 D9）。
- 不随插件 release 分发任何模型或 runtime（main.js 保持精简）。
- 暂不做 provider 端缩略图（Aliyun `x-oss-process=image/resize`、Tencent COS `imageMogr2`、Qiniu `imageView2`）以省流量；列为后续可选项。
- 不改变现有 URL / key 搜索（`SearchService` 的文本与正则搜索保持不变）。

## 2. 已定决策表

| # | 决策 | 理由 |
|---|---|---|
| D1 | 运行时用内置 transformers.js（`@huggingface/transformers` 4.x），跑在 Web Worker | P0 在 Obsidian 同款 Electron 39.6.0 worker 中验证可行；不引入外部服务 |
| D2 | **仅 WebGPU**，无 CPU/wasm 回退 | ORT-web CPU 缺 `GatherBlockQuantized` kernel，所有量化变体都用到；打补丁后仍 2.5 s/张（70 token）、峰值 3.4 GB [P0 §1b] |
| D3 | WebGPU 自动检测，不可用则功能无法启用，设置页显示原因 | 避免用户下载 316 MB 后才发现跑不了 |
| D4 | Opt-in 分发：用户在设置中明确确认后才下载 | 插件体积与隐私；下载量大需知情同意 |
| D5 | worker bundle（~547 KB）+ ORT WebGPU wasm（~25.6 MB）从本项目 GitHub Release 下载；模型权重从 Hugging Face 下载；每个文件由写死在 main.js 中的 SHA-256 校验后才使用 | 防篡改；代码类资源来源可控 |
| D6 | 模型/runtime 存系统用户目录（Node `fs`），路径可配置，所有 vault 共享 | Cache API 可被清除且不透明；OPFS 同理；插件目录会被 Obsidian Sync/iCloud 同步 316 MB。`isDesktopOnly: true` 所以可用 `fs` |
| D7 | 索引文件**按设备**存在 vault 之外的 `semantic.indexDir`（默认 `<appDir>/indexes`，与模型目录同级），路径 `<indexDir>/<vaultId>/<scopeId>/`；不进 `data.json`，不同步，每台设备各自建立（P3 修订，取代"存插件目录"） | 插件目录会被 Obsidian Sync/iCloud 同步，多设备并发写 `meta.json`/`vectors.bin` 会冲突；索引是可重建缓存，按设备存放从设计上消除同步冲突；`data.json` 不适合放二进制 |
| D8 | 向量截断到 256 维、重新归一化、float32 | P0 在 768/256 维下检索结果一致；约 1 KB/图 |
| D9 | 只排序，不设绝对阈值 | 不相关对约 0.5，正确对约 0.73，分布随内容变化 [P0 §6] |
| D10 | 图像 token budget 默认 70（`processor.image_processor.max_soft_tokens`），可选 70/140/280，修改即全量重建 | 70 token：309 ms/张，批量 8 时 235 ms/张；280 token：1.43 s/张且批量无收益 [P0 §3] |
| D11 | 文本查询前缀 `task: search result \| query: {q}`；图片无前缀 | 模型约定，P0 使用且验证 |
| D12 | 查询 worker 只加载文本模型（≈175 MB）；索引 worker 加载 text+vision；空闲超时后 terminate | 搜索常驻、索引一次性；降低常驻内存 |
| D13 | 永不在同一 worker 内 dispose 后重载，需要重载就回收（terminate）worker | dispose+reload 会泄漏内存 [P0 §5] |
| D14 | worker 用 esbuild `define: { process: 'undefined' }` 打包，Blob URL 启动，`env.backends.onnx.wasm.wasmPaths` 指向本地目录 | Obsidian worker 有 Node 集成，transformers.js 否则误判 Node 环境崩溃 [P0 §7 Gotcha 1, §8] |
| D15 | 缓存键 = object key + fingerprint，**绝不用 URL** | URL 可能是预签名的，每次不同 |
| D16 | 索引是可重建的缓存：优先级 1 = 绝不展示已删除图片；优先级 2 = 避免误清（误清代价是重新下载） | 决定删除同步协议的取舍方向 |
| D17 | 远程索引前必须显示流量估算，不得静默下载全库 | 见 §9.4 |

## 3. 架构总览

```
┌──────────────────────── Obsidian renderer (main thread) ────────────────────────┐
│                                                                                 │
│  Settings UI ──► ModelDownloadManager ──► fs: <modelDir>/ (runtime + weights)   │
│       │               (SHA-256 verify)         ▲                                │
│       │                                        │ customCache{match,put}         │
│       ▼                                        │                                │
│  SemanticController (plugin-level, in main.ts) │                                │
│    ├─ WebGpuProbe                              │                                │
│    ├─ SemanticIndexService ──── VectorStore ──► <indexDir>/<vaultId>/          │
│    │     ▲  (per scope, serial queue)          │     <scopeId>/{meta.json,      │
│    │     │ reconcile/enqueue                   │      vectors.bin,status.json}  │
│    │     │                                     │                                │
│  OssGalleryView ── SyncService.sync() ─ listImages → {items, complete}          │
│    │  SearchComponent[语义] ──► SemanticSearchService.query()                   │
│    │                                   │ postMessage                            │
│    └───────────────────────────────────┼────────────────────────────────────────┤
│                                        ▼                                        │
│  ┌── query worker (Blob URL) ──┐   ┌── index worker (Blob URL) ──┐              │
│  │ transformers.js, text only  │   │ transformers.js, text+vision│              │
│  │ WebGPU, ~175 MB, idle→kill  │   │ WebGPU, batch 8, idle→kill  │              │
│  └─────────────────────────────┘   └─────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────────────────┘
        图片字节来源：Local = fs 读取；远程 = requestUrl(url)（被拒时签名 GET）；上传 = 内存中的 File
```

## 4. 模块与接口

新增目录 `src/semantic/`（不放入现有 `src/services/` 以便整体 lazy-load）。以下为接口草图，签名可在实现时微调，语义不变。

### 4.1 现有接口的改动（P3，已实现）

```ts
// src/types/oss.ts
export interface OssImage {
    key: string;
    url: string;
    lastModified?: Date;
    size: number;
    /** S3 系 ETag（含引号原样）/ Qiniu hash / GitHub blob sha。用于 fingerprint；缺省则退化为 size+lastModified。 */
    etag?: string;
}

export interface ListResult {
    items: OssImage[];
    /** false = 列表被截断或部分请求失败；此时绝不能据此判定"已删除"。 */
    complete: boolean;
    /** 本次列表覆盖的 key 前缀（'' = 全部）；只对这个前缀之下的已索引 key 做删除对账。 */
    prefix: string;
}

interface IStorageProvider {
    listImages(prefix?: string): Promise<ListResult>;
    /** 上传路径 → 列表中的 key；无法预知（S.EE 自行分配 id）则不实现 / 返回 null。 */
    listingKeyForUpload?(path: string): string | null;
}
```

与草图的差异：`ListResult` 增加 `prefix`。各 provider 的 key 空间不同（Aliyun/Tencent/Qiniu/Upyun 的 key 含 provider 自身的 `path` 设置，S3 系/GitHub/Local 不含，S.EE 忽略前缀），只有 provider 知道列表实际覆盖了哪个前缀，所以由它返回；对账不再自行推断。

`src/providers/shared/listing.ts`：

- `ListingCollector(provider, prefix)`：`push()`、`markIncomplete()`、`capped(limit)`（= `warnListingCapped` + `markIncomplete`）、`result()`。
- `collectPages(collector, maxPages, fetchPage)`：游标分页通用循环（S3 系 V2 continuation token、Aliyun/Tencent V1 marker、Qiniu marker）。到达 `maxPages`、服务器说"还有"却不给游标、或游标重复（会死循环）时 `complete = false`；请求错误照旧抛出（视图的错误处理不变）。

各 provider 的 `complete = false` 条件：

| provider | 条件 |
|---|---|
| S3 / R2 / MinIO（`S3CompatibleProvider`）、Aliyun、Tencent、Qiniu | `MAX_LIST_PAGES`；`IsTruncated` 但无 / 重复游标 |
| GitHub | tree 截断后改走目录遍历：`MAX_LIST_REQUESTS`、超过 `GITHUB_MAX_WALK_DEPTH` 的子目录、遍历中子目录 404（根目录 404 = 空列表，仍完整） |
| Upyun | `MAX_LIST_REQUESTS`；子目录或续页 404 |
| S.EE（SmMs） | `SEE_MAX_PAGES`；API 重复返回同一页（忽略分页）。前缀恒为 `''` |
| Local | 存储目录不可访问（盘符未挂载等，不再当作"全部删除"）；任一子目录 `readdir` 失败；文件在 `readdir` 与 `stat` 之间消失 |
| 任一 provider | 未配置（返回空列表时 `complete = false`） |
| Imgur | `{ items: [], complete: true, prefix: '' }`（registry 中不可列表，不会建索引） |

- etag：S3 系 / Aliyun / Tencent 取 `<ETag>`，Qiniu 取 `hash`，GitHub 取 tree / contents entry 的 `sha`；Upyun、S.EE、Local 无，用 `size+lastModified`。
- `listingKeyForUpload`：Local、S3 系、GitHub = 上传路径；Aliyun/Tencent/Qiniu/Upyun = `buildObjectKey(settings.path, path)`；S.EE / Imgur 不实现（上传钩子跳过，下一次列表时按普通新增处理）。
- `SyncService.sync()` 返回 `{ objects, changes, listing }`（`listing` 为 provider 原样的 `ListResult`，`items` 已按时间排序）。视图对 `objects` / `changes` 的使用不变。
- `LocalProvider.readObjectBytes(key)`：经 `resolveWithinStorage` 解析（拒绝 `..` 越界），`fs.promises.readFile`。

### 4.2 Fingerprint（P3，已实现：`src/semantic/fingerprint.ts`）

```ts
export function fingerprint(o: OssImage): string {
    if (o.etag) return `e:${o.etag}`;               // GitHub 的 sha 也放 etag 字段
    return `s:${o.size}:${o.lastModified?.getTime() ?? 0}`;
}
```

P3 补充：插件内上传在列表还没报告真实 etag/mtime 之前存临时 fingerprint `u:<size>`；之后第一次出现该 key 的列表若 size 相同（或 size 未知为 0），直接 `setFingerprint` 为真实值，**不重新 embed**；size 不同则按"已修改"重新 embed。

### 4.3 EmbeddingBackend（P2，已实现）

文件：`src/semantic/protocol.ts`（主线程与 worker 共享的类型、常量与纯函数，不 import transformers.js / Obsidian / Node）、`EmbeddingBackend.ts`（接口 + `FakeEmbeddingBackend`）、`WorkerEmbeddingBackend.ts`（主线程宿主）、`runtimeFiles.ts`（启动前校验）、`worker/{entry,handler,engine,fsModelCache}.ts`。

```ts
// protocol.ts
export interface EmbeddingConfig {
    modelId: string;            // MODEL_ID
    revision: string;           // MODEL_REVISION（§8.1）
    dtype: 'q4';
    dims: number;               // EMBEDDING_DIMS = 256
    imageTokenBudget: 70 | 140 | 280;
    preprocessVersion: number;  // PREPROCESS_VERSION = 1；改变解码/缩放逻辑时 +1
}
export interface ImageInput { id: string; bytes: ArrayBuffer; mime: string }   // bytes 会被 transfer（调用方的 buffer 变为 detached）
export type ImageEmbedding =
    | { id: string; ok: true; vector: Float32Array }
    | { id: string; ok: false; code: 'decode' | 'inference'; message: string };

// EmbeddingBackend.ts
export interface EmbeddingBackend {
    init(mode: 'query' | 'index', cfg: EmbeddingConfig): Promise<BackendInitInfo>; // {mode, sessions, loadMs, verifyMs}
    embedText(queries: string[]): Promise<Float32Array[]>;          // 内部加前缀、截断、归一化
    embedImages(images: ImageInput[]): Promise<ImageEmbedding[]>;   // 逐张成败；顺序与输入一致
    dispose(): Promise<void>;                                       // = terminate worker，不是复用
}
export function currentEmbeddingConfig(budget): EmbeddingConfig;    // 当前构建的 header 来源
```

与草图的差异：`embedImages` 输入改为 `{id, bytes, mime}`（P3 从 fs / fetch / File 拿到的本来就是字节），输出为逐张结果：一张坏图（无法解码、推理失败）只让它自己失败，不拖垮整批。`WorkerEmbeddingBackend` 另有 `embedTextDetailed / embedImagesDetailed`（附 worker 耗时与批数）、`ping()`、`recycle()`、`isRunning()`。

**协议**（`protocol.ts`，`PROTOCOL_VERSION = 2`）：`{id, type: 'ping'|'init'|'embedText'|'embedImages', payload}` → `{id, ok: true, result}` 或 `{id, ok: false, error: {code, message}}`。错误码：`bad-request`（含协议版本不符）、`not-initialized`、`already-initialized`、`unsupported`（query worker 收到 embedImages）、`model-load`、`inference`；宿主侧另有 `terminated`、`runtime-verify`、`worker-crashed`。没有 `dispose` 消息（D13：只 terminate）。`init` payload = `{protocol, mode, config, modelDir, files: {name,size}[], wasmBinary: ArrayBuffer(transfer), wasmFactory: string}`。输出向量的 buffer 全部 transfer 回主线程。

**宿主（`WorkerEmbeddingBackend`）**，一个实例 = 一种 mode = 至多一个活 worker：

- 每次启动 worker 前 `loadVerifiedRuntime()`：读取 `runtime/<版本>/` 下 3 个文件，按 `assets.generated.ts` 校验大小 + SHA-256（约 27 MB，实测 50–200 ms），并**直接使用校验过的那份字节**：worker 脚本 → Blob URL（首条消息后 revoke），ORT wasm → `init` 里 transfer，ORT mjs → 字符串。没有"校验后再按路径读取"的窗口。模型文件只做存在 + 大小检查（安装/校验时已算过哈希；worker 读取时再查一次大小）。query 模式不检查也不提供 `onnx/vision_encoder*`。
- ORT 走 **binary 模式**（P0 §8 方案 b）：`env.useWasmCache = false`、`wasm.wasmBinary = <bytes>`、`wasmPaths = { mjs: <Blob URL> }`，mjs 先做 `globalThis.process?.versions?.node → false` 替换。选它而不是 URL 模式，是因为运行时文件在 vault 之外，没有可靠的 `app://` URL，且这样可保证用的正是校验过的字节。
- 请求串行（一个 worker 同时只有一个在途请求）；`terminate` 时在途与排队中的请求都以 `terminated` reject（按 epoch 取消）。
- 空闲超时后 terminate，下次请求透明重启（重新校验 + 重新加载）：`QUERY_IDLE_TIMEOUT_MS = 5 min`、`INDEX_IDLE_TIMEOUT_MS = 30 s`，构造参数 `idleTimeoutMs` 可覆盖（0 = 不超时）。
- worker `error` 事件 → 在途请求以 `worker-crashed` reject 并回收；`init` 失败 → 回收（`onTerminated('init-failed')`），下次请求重试。
- `SemanticController.createBackend(mode)` 创建并登记；删除模型、修改 `modelDir`、插件卸载时 `disposeBackends()`。

**worker 内**（`engine.ts`，WebGPU、q4，**纯离线**）：

```ts
env.useBrowserCache = false; env.useFSCache = false;
env.useCustomCache = true; env.customCache = fsModelCache;   // 只读，见下
env.allowRemoteModels = false;            // 缓存未命中 → 加载失败，不会联网
env.allowLocalModels = true;              // 两者都 false 时 transformers.js 直接报配置错误
env.localModelPath = '/__oss-gallery-no-local-models__/';
env.fetch = () => Promise.reject(...);    // transformers.js 的 fetch
self.fetch = 仅放行 blob:/data:;           // ORT 等直接用全局 fetch 的代码
const opts = { revision, local_files_only: true };
const config = await AutoConfig.from_pretrained(id, opts);
config.audio_config = null; if (mode === 'query') config.vision_config = null;
processor = await AutoProcessor.from_pretrained(id, opts);
model = await AutoModel.from_pretrained(id, { ...opts, config, device: 'webgpu', dtype: { model: 'q4', vision_encoder: 'q4' } });
```

- `fsModelCache`：只服务宿主列出的文件（`files`），把 `https://huggingface.co/<model>/resolve/<revision>/<file>` 映射到 P1 写入的 `<modelDir>/huggingface.co/...`；不在列表内 → miss；列表内但缺失/大小不符 → 抛错；`put` 不写盘。**`/resolve/main/` 别名**：transformers.js 4.3.1 的 `get_tokenizer_files` / `get_processor_files` 探测 `tokenizer_config.json` / `preprocessor_config.json` 是否存在时**不传 revision**（固定问 `main`），不做别名则 tokenizer 配置被判为不存在，加载报 `reading 'tokenizer_class'`。因本地只有固定 revision 的文件，`main` 键直接映射到它。
- Node `fs` 通过 `self.require`（Obsidian worker 有 `nodeIntegrationInWorker`，Blob URL worker 也有）取得；按属性读取，esbuild 不会解析或替换它，lint 也无需 `eval`。仍用 `define: { process: 'undefined' }` 打包（D14）。
- 文本：`processor(queries.map(q => QUERY_PREFIX + q))`，批量一次调用。
- 图片（`PREPROCESS_VERSION = 1`）：`createImageBitmap(new Blob([bytes], {type: mime}))`；若像素数 > `max(1 MP, budget × 9 × 256 × 4)`（处理器目标像素的 4 倍）则用 `createImageBitmap(..., {resizeWidth, resizeHeight, resizeQuality: 'high'})` 等比缩小；画到白底 `OffscreenCanvas`（透明像素不变黑）→ `new RawImage(rgba, w, h, 4)`。解码失败（如损坏文件）→ 该张 `code: 'decode'`。P3：`mime === 'image/tiff'` 时先用 UTIF.js 解码为 `ImageData` 再走同一路径；SVG 在主线程栅格化为 PNG 后才送入 worker（§12）。
- 批量：`processor(null, imgs.map(i => [i]))`；每批张数按 budget 查表 `MAX_BATCH_BY_BUDGET = {70: 8, 140: 4, 280: 1}`（P0：70 token 批 8 有收益；280 token 批量无收益且每批 4 张多占约 900 MB 共享显存；140 未测，取与 8×70 相同的 patch 数）。整批推理失败时逐张重试，只让坏图失败。
- 输出：`sentence_embedding` 取前 256 维 → L2 归一化 → `Float32Array`（`truncateAndNormalize`）。

**FakeEmbeddingBackend**：确定性向量（文本 FNV-1a → mulberry32 → 归一化），无需 GPU；字节为 UTF-8 `fake-image:<caption>` 的"图片"得到与文本 `<caption>` 完全相同的向量（`fakeImageBytes(caption)`），便于 P3 写"能搜到"的测试；支持 `failImageIds`、`latencyMs`；与真实后端一样校验 mode / init / dispose。

若未来 Obsidian 去掉 `nodeIntegrationInWorker`，退回"主线程代理 fs"方案 [P0 §7]，接口不变（`fsModelCache` 的 `CacheFs` 换成 postMessage 代理）。

### 4.4 VectorStore（P2 实现，P3 扩展）

文件：`src/semantic/VectorStore.ts`。

```ts
export interface IndexHeader { modelId; revision; dtype; dims; imageTokenBudget; preprocessVersion }
export function headerFromConfig(cfg: EmbeddingConfig): IndexHeader;
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function scopeIndexDir(indexRoot, vaultId, scopeId): string;   // <indexRoot>/<vaultId>/<scopeId>（P3 修订）

export class VectorStore {
    static open(dir: string, header: IndexHeader, opts?: { fs?, timers?, flushDelayMs?, onFlushError?, asyncIo?, asyncFs? }): VectorStore;
    openResult: { status: 'created' | 'loaded' | 'reset' | 'repaired'; reason?: 'header-mismatch' | 'corrupt-meta'; dropped: number; recoveredTmp: boolean };
    get(key): { fp; vec; missingSince?; missCount? } | undefined;
    peek(key): { fp; missingSince?; missCount? } | undefined;   // P3：不复制向量
    has(key); keys(); size; stats(); holeRatio(); visibleCount();
    upsert(key, fp, vec): void;               // 新增或重新 embed；清除 tombstone
    setFingerprint(key, fp): void;            // P3：只换 fingerprint（上传的临时 fp → 列表的真实 fp）
    markMissing(key, now): void;              // 首次 missingSince=now, missCount=1；之后 missCount++
    restore(key): void;
    remove(key): void;                        // 立即清除
    clear(): void;
    visibleKeys(): Set<string>;               // 不含 tombstone
    search(q, k, allow?: Set<string> | ((key) => boolean)): { key; score }[];  // 降序；不含 tombstone
    flush(): Promise<void>; flushSync(): void;
    compactIfNeeded(threshold = 0.3): Promise<boolean>; compactSync(): void;
    close(): void;                            // flushSync + 停止定时器
}
```

- `open` 时 header 任一字段不符或 meta 无法解析 → 删除两个文件、返回空库（`reset`），调用方全量重建。
- 修改后按 `flushDelayMs`（默认 2 s）防抖自动 flush；插件卸载时调用 `close()`（同步写，退出 Obsidian 时也能落盘）。
- `search` 为暴力点积（向量已归一化）。1 万张 × 256 维 ≈ 10 MB，主线程可接受；若超 5 万张再移入 worker（§11）。
- `allow` = 当前内存中的远程对象 key 集合（§7.6）。
- **I/O 选择**：插件为 `isDesktopOnly`，直接用 Node `fs` 操作 `semantic.indexDir` 下的绝对路径，而不是 `DataAdapter`：需要定位写（只追加新槽位）、`fsync`、覆盖式 `rename` 与 `ftruncate`，这些 `DataAdapter` 都没有；同步调用保证卸载时 flush 可靠。也便于在纯 Node 单元测试中注入故障（`StoreFs` 接口）。
- **`asyncIo`（P3）**：实测 1 万条时同步 flush（追加 8 个槽位 + 重写 1.1 MB meta + 两次 fsync）阻塞主线程 13–20 ms，索引期间每 2 s 一次即可见卡顿。`SemanticIndexService` 打开的 store 用 `asyncIo: true`：主线程只做快照（`JSON.stringify` meta + 复制新槽位）和最后一步 `renameSync`，写入与 fsync 走 `fs.promises`，实测最大阻塞 7–14 ms。协议不变（先追加槽位并 fsync，再原子替换 meta），区别：
  - meta 写到私有临时文件 `meta.json.a<N>.tmp`；打开时直接删除这类孤儿（从未提交，追加的槽位按"未提交尾部"截掉）。
  - 槽位按固定偏移写入、不 `ftruncate`，与并发的 `flushSync` 只会写入相同字节。
  - 任何同步写（`flushSync`、compaction、`clear`、`close`）都会递增 `writeGeneration`；异步 flush 在 rename 前若发现代数变化或已关闭，丢弃自己的临时 meta，绝不用旧 meta 覆盖新状态。`clear` 改为 unlink 后新建 `vectors.bin`，使仍持有旧文件句柄的异步写落到旧 inode。
  - 期间发生的修改使 `dirty` 保持为 true，由下一次 flush 提交。

### 4.5 SemanticIndexService（P3，已实现）

文件：`src/semantic/SemanticIndexService.ts`（纯逻辑，不 import Obsidian；UI 通过 deps 注入）+ `src/semantic/SemanticIndexing.ts`（Obsidian 胶水：scope、取字节、对话框、Notice、状态栏、视图钩子、命令）。插件级单例，生命周期随插件，按 scope 隔离。

```ts
export interface IndexScope { id: string; providerId: string; listPrefix: string; local: boolean }

export interface IndexServiceDeps {
    indexRoot(): string | null; vaultId: string; embeddingConfig(): EmbeddingConfig;
    isEnabled(): boolean;              // semantic.enabled：对账与钩子
    isReady(): boolean;                // enabled 且模型已安装：可以 embed
    autoIndex(): boolean;
    createBackend(): EmbeddingBackend | null;                       // index 模式
    readBytes(scope, obj): Promise<ArrayBuffer>;                    // Local=fs，远程=requestUrl(obj.url)
    rasterizeSvg(bytes): Promise<ArrayBuffer>;                      // 主线程
    confirmTraffic(scope, estimate, reason): Promise<boolean>;      // §9.4；reason = manual | auto-first | auto-large
    onRunFinished?(summary: RunSummary): void;
    now?(); timers?; storeOptions?; prepare?;                       // 测试注入
}

export class SemanticIndexService {
    beginListing(scope): number;                                    // 全局单调递增 token
    reconcile(token, scope, r: ListResult): boolean;                // §7；过期 token / 功能关闭 → false
    onUploaded(scope, obj, bytes): void;                            // 用手头字节，零流量
    onDeleted(scope, key): void;                                    // 立即 remove
    estimate(scope): { pendingCount; pendingBytes; indexedCount; unknownSizeCount? };  // Local 的 pendingBytes = 0；size 为 0 的远程对象计入 unknownSizeCount（P4）
    start(scope, { auto? }): Promise<boolean>;                      // 远程先确认（§9.4）
    pause(); resume(); cancel(); isRunning(); isPaused(); whenIdle();
    onScopeChanged(currentScopeId | null): void;                    // provider/scope 切换：取消其他 scope、作废其 token
    closeAll(): void;                                               // indexDir / token budget 变化、清除索引
    getProgress(); onProgress(cb): () => void;                      // { state, scopeId, done, total, currentKey }（currentKey：P4）
    getStats(scope): IndexStats;                                    // 各状态计数 + 非 ok 条目及原因（§12）
    resetFailed(scope): number;                                     // P4 "重试失败"：清除 failed 记录（次数与退避），重新进入待办
    hasIndex(scope); isIndexed(scope, key); getSearchStore(scope); getRemote(scope);
    dispose(): void;                                                // 卸载：cancel + close 所有 store（同步落盘）
}
```

- **串行低优先级 runner**：一次一批（批大小 = `MAX_BATCH_BY_BUDGET`：70→8、140→4、280→1），先处理上传队列，再处理已授权 scope 的待办；批与批之间可暂停 / 取消。取消会终止 worker（D13），未处理项留在待办中，下次 `start` 继续；已处理的不回退。
- **授权**：一次 `start` 授权一次 run；run 结束后新出现的待办需要再次 `start`（或 `autoIndex` 按 §9.4 规则自动开始）。
- **取字节**：Local 用 `LocalProvider.readObjectBytes`（零流量）；远程用 `src/semantic/remoteBytes.ts` `fetchRemoteImageBytes`（P4）：Obsidian `requestUrl({ url: obj.url, throw: false })`——不受 `app://obsidian.md` 源的 CORS 限制（`fetch()` 需要存储桶配置 CORS，大多数用户没有配置；`<img>` 不需要），走系统代理；URL 与图库显示的相同，每次取自最新列表（预签名 URL 原样使用），缓存键永远是 key + fingerprint（D15）。401/403 且 provider 实现了 `signedObjectGet(key)`（S3 / R2 / MinIO：SigV4 签名 GET，与列表/删除同一套签名）时再试一次签名请求；仍失败按状态码给出可读原因（本地化）：401/403 → "拒绝访问（HTTP 403）：请检查存储桶权限，或将图片设为公开可读"，404 → "找不到"，其他 → "下载失败（HTTP n）"，网络错误 → "网络错误：…"，记为 `failed`（重试规则见 §12）。上传用手头 `File` 的字节。单元测试：`tests/semantic/remoteBytes.test.ts`（模拟 requestUrl：200、预签名 URL、403 无签名 / 签名重试成功 / 二次 403、404 不尝试签名、500、网络错误、无 URL）。
- **worker**：index 模式 backend 懒创建并复用，空闲 30 s 后由 `WorkerEmbeddingBackend` 自行回收；backend 级错误（`model-load`、`runtime-verify`、`worker-crashed`…）终止本次 run 并以 Notice 报告，未处理项留在待办；token budget 改变时换新 backend。
- **变更检测**：只看 `fingerprint()`（§4.2），不依赖 `SyncService.detectChanges`。
- **视图挂接**：`OssGalleryView` 在 `syncService.sync()` 前 `beginListing`、在 `isCurrentLoad(generation)` 通过后 `reconcile`（手动刷新与 2 分钟自动同步两条路径；自动同步即使图库无变化也对账）；删除成功后 `onDeleted`。上传成功后 `main.ts` 调 `SemanticIndexing.onUploaded`（仅图片、key 可预知、且该 scope 已有索引时）。
- **run 结束**：每个 store `compactIfNeeded()` + 异步 flush，status 落盘；`onRunFinished(summary)` → Notice（§12）。

### 4.6 Scope id（P3，已实现）

```ts
scopeId = sha256(stableStringify({ providerId, identity, listPrefix })).slice(0, 16)   // src/semantic/fingerprint.ts computeScopeId
```

`stableStringify` 对对象键排序，保证同一 identity 哈希不变。`identity` 由 `ProviderRegistryEntry.getIndexIdentity?(settings)` 给出（实现集中在纯模块 `src/providers/indexIdentity.ts`，registry 挂到每个 entry 上；`providerRegistry.getIndexIdentity(id, settings)` 对不可列表或无 identity 的 provider 返回 null）：

| provider | identity |
|---|---|
| local | `storagePath`（去首尾 `/`）、`useRelativePath` |
| github | `repo`（小写）、`branch` |
| aliyun / qiniu | `bucket`、`area`、`path` |
| tencent | `bucket`、`region`、`path` |
| upyun | `bucket`、`path` |
| r2 | `accountId`（出现在每个 R2 URL 中，不是凭证）、`bucket` |
| s3 | `endpoint`（小写）、`region`、`bucket`、`forcePathStyle` |
| minio | `endpoint`（小写）、`port`、`useSSL`、`bucket` |
| smms | `{}`：只有（保密的）token 能区分账号，所以所有 S.EE 账号共用一个 scope；换账号后完整列表会按 §7 把旧条目 tombstone 再清除 |
| imgur | 无（不可建索引） |

凭证（key/secret/token/password）一律不参与；单元测试断言 identity 不含任何凭证且轮换凭证不改变 scope id。`listPrefix` = 图库列表前缀（全局 base path + `/`），所以改 base path 会得到新 scope。`ProviderCapabilities` 不新增字段：可建索引 = `capabilities.list` 且有 identity。

### 4.7 SemanticSearchService（P3，已实现）

```ts
export class SemanticSearchService {
    searchByTextScored(scope, q, remote: OssImage[], k = remote.length): Promise<{ object: OssImage; score: number }[]>;
    searchByText(scope, q, remote, k?): Promise<OssImage[]>;
    searchSimilarScored(scope, key, remote, k?): { object; score }[];   // 用已存向量，无需 worker；排除自身
    searchSimilar(scope, key, remote, k?): OssImage[];
    isWarm(): boolean;                                                 // P4：query worker 已加载（否则 UI 显示"正在加载搜索模型"）
    dispose(): void;                                                   // 终止 query worker
}
```

- 文本查询用 query 模式 worker（只加载文本模型，D12，空闲 5 分钟回收）；worker 出错即丢弃，下次重建。
- 结果始终与传入的 `remote`（当前内存中的对象列表）取交集，且不含 tombstone（§7.6）。
- `SearchService.search(objects, text, useRegex)` 保持不变；P4 由 `OssGalleryView.handleSearch` 按 `queryFor(mode, text)`（`src/components/searchMode.ts`）分派到语义模式，结果按 score 降序（§9.1）。

## 5. 数据格式

目录：`<indexDir>/<vaultId>/<scopeId>/`（P3 修订，D7）。

- `indexDir` = 设置 `semantic.indexDir`，`''` = 平台默认 `<appDir>/indexes`（`src/semantic/modelDir.ts` `defaultIndexDir()`，与 `models` 同级；Windows 为 `%LOCALAPPDATA%obsidian-oss-galleryindexes`）。与 `modelDir` 相同的校验：前导 `~` 展开，其余必须是绝对路径。
- `vaultId`（`src/semantic/indexFiles.ts` `vaultIdFor`）：Obsidian 的每 vault `app.appId`（未公开 API，做类型守卫）清洗为 `[A-Za-z0-9_-]`、最长 64；没有则 `v` + vault 绝对路径（小写、`/` 分隔）SHA-256 的前 16 位。
- `scopeIndexDir()` 对 `vaultId` 与 `scopeId` 都只接受 `[A-Za-z0-9_-]{1,64}`。
- 文件：`meta.json`、`vectors.bin`（下文）、`status.json`（索引状态旁注，§12），以及各自的 `.tmp` / `meta.json.a<N>.tmp`。
- 修改 `indexDir` 即指向新位置：旧索引原地保留，服务关闭并在新位置重新打开 store；远程 provider 需要重新确认流量（确认记录 `confirmedAt` 存在 `status.json` 中）。
- **清除本 vault 的索引**（设置页，`clearVaultIndex`）：只删除 `<indexDir>/<vaultId>/<scopeId>/` 下本插件写入的文件名（上面列出的那些），跳过符号链接、未知文件和名字不是 scope id 的目录，然后删除变空的目录（含 `<vaultId>` 本身）；`indexDir` 根目录与其他 vault 的目录永不触碰。"删除模型"不触碰索引，清除索引也不触碰模型。
- 旧位置 `<vault>/<manifest.dir>/semantic-index/` 不再使用，也不迁移（P3 之前没有发布过索引）。

### meta.json

```jsonc
{
  "format": 1,
  "header": {
    "modelId": "onnx-community/embeddinggemma-2-ONNX",
    "revision": "<commit hash>",
    "dtype": "q4",
    "dims": 256,
    "imageTokenBudget": 70,
    "preprocessVersion": 1
  },
  "slotCount": 1234,                 // vectors.bin 中已提交的槽位数
  "entries": {
    "2025/10/a.png": { "fp": "e:\"abc\"", "slot": 17, "h": 2166136261 },
    "2025/10/b.png": { "fp": "s:48213:1760000000000", "slot": 18, "h": 84696351,
                        "missingSince": 1760100000000, "missCount": 1 }
  },
  "freeSlots": [3, 9]                // 空洞（已 remove / 被更新替换的槽位）
}
```

`h` = 该槽位字节的 FNV-1a 32 位校验和（P2 新增）。

### vectors.bin

- 无头部；第 `i` 个槽位位于字节偏移 `i * dims * 4`（256 维即 1024），内容为 little-endian float32（大端平台直接拒绝打开）。
- **只追加，不复用空洞**：新向量与更新都写到文件末尾，旧槽位入 `freeSlots`，由 compaction 回收。（不复用的原因：在 meta 提交前复用一个"内存中刚释放"的槽位，崩溃后旧 meta 仍指向它，会把新向量错配给旧 key。）
- `meta.json` 是提交点：flush = 先把未提交槽位写到 `slotCount*B` 处（先 `ftruncate` 掉上次失败留下的尾巴）并 `fsync`，再原子写 meta（`meta.json.tmp` → `fsync` → `rename`）。

### 打开时的恢复（按顺序）

1. **临时文件**：存在 `vectors.bin.tmp` → compaction 在替换 vectors 之前中断，删除两个 tmp（旧状态完好）；仅存在 `meta.json.tmp` → 若它完整可解析、header 一致且 `vectors.bin` 长度恰为 `tmp.slotCount*B`，说明中断发生在"vectors 已替换 / 已追加、meta 未 rename"之间，**前滚**（rename 为 meta.json）；否则删除。
2. 无 meta → 新库（顺带删除孤立的 vectors.bin）；meta 不可解析或 `format` 不符 → `reset`；header 不符 → `reset`。
3. 文件长于 `slotCount*B`（未提交的追加）→ 截断；短于（被截断、同步冲突）→ `slotCount` 取文件能容纳的整槽数。
4. **逐条校验**：槽位越界、重复引用或校验和 `h` 不符的条目被丢弃（`dropped` 计数，P3 将其视为"待重新 embed"），其余照常可用；未被引用的槽位重算为空洞。有任何修复则状态为 `repaired` 并立即写回修复后的 meta。

逐条校验和使"文件较短 / 混入另一设备的版本 / compaction 半途"都只损失受影响的条目，而不是要么静默错配、要么整库重建。

### 约束

- header 任一字段与当前配置不同 → 整个 scope 作废并重建（含修改 token budget、`PREPROCESS_VERSION`）。
- **原子写**：写 `.tmp` → `fsync` → `rename`；compaction 写 `vectors.bin.tmp` + `meta.json.tmp`（均 `fsync`），先 rename vectors 再 rename meta，中断由上面第 1 步回滚或前滚。
- **Compaction**：`freeSlots.length / slotCount > 0.3` 时 `compactIfNeeded()` 执行（P3 在空闲时调用）；按槽位顺序重排，搜索结果不变。
- 容量：1 万张 ≈ 10 MB vectors + 约 1–2 MB meta。

## 6. 向量与查询约定

- 文本：`"task: search result | query: " + q`；图片：无前缀。
- 图片：`max_soft_tokens = imageTokenBudget`；批量一次一个样本一张图。
- 输出：取前 256 维 → L2 归一化 → float32。查询向量同样处理，相似度 = 点积。
- 结果按分数降序取 top-k（默认 k = 当前远程对象数，即对整库排序而非截断；UI 可分页）。

## 7. 删除同步协议

原则：见 D16。索引是可重建缓存。

### 7.1 事件来源

| 事件 | 处理 |
|---|---|
| 插件内删除（`SyncService.deleteObject` 成功后） | `onDeleted` → `VectorStore.remove` 立即清除，不走 tombstone；同时移出待办 / 上传队列；若该 key 正在批处理中，结果到达时丢弃 |
| 插件内上传成功 | `onUploaded` → 用手头 `File` 字节入上传队列（优先于列表待办），零额外流量，不需要流量确认；key 由 `listingKeyForUpload` 得到，fingerprint 先记 `u:<size>`（§4.2）。仅当该 scope 已有索引时执行（不为从未建过索引的 scope 建立索引目录） |
| 外部变更（别的客户端、手动删除等） | 只能通过完整列表对账（§7.2–7.5）发现，不做猜测 |

### 7.2 完整性门槛

`reconcile(token, scope, { items, complete })`：

- `complete === false`：**只处理新增与修改**（入队 embed），**不处理任何删除**，也不推进 tombstone 计数。
- 仅对"在本次 `ListResult.prefix` 之下"的已索引 key 做对账（前缀由 provider 返回，§4.1）；prefix 之外的条目保持原样，不被视为删除。
- 上传队列中尚未处理的 key 不做删除对账（列表可能早于上传完成）。
- `complete === true` 时同时清理该前缀下已不在列表中、也没有向量的 `status.json` 条目。

### 7.3 两阶段 tombstone（`complete === true`）

对每个已索引 key：

1. 在列表中且 fingerprint 相同：若有 `missingSince` → `restore`（清除 `missingSince/missCount`），**不重新下载**。
2. 在列表中但 fingerprint 不同：入队重新 embed（旧向量在新向量落盘前仍可用，但立即视为"待更新"）。
3. 不在列表中：
   - 首次：`missingSince = now`、`missCount = 1`；**立即从搜索结果中隐藏**（`visibleKeys()` 不含）。
   - 之后每次完整列表仍缺失：`missCount++`。
   - `missCount >= 2` **或** `now - missingSince >= 7 天` → 真正清除向量（槽位入 `freeSlots`）。
4. 列表中有、索引中无：入队 add。

### 7.4 对账次序与过期列表

沿用 `OssGalleryView` 的 load generation 思想（`beginLoad/isCurrentLoad`，`loadGeneration` 是 view 私有的，服务层不能直接引用）：

- 发起 `listImages` 之前调用 `beginListing(scope)` 取 token；
- `reconcile` 时若 `token <= lastAppliedToken(scope)`（重复的也丢弃）或 token 早于该 scope 最近一次失效，直接丢弃，避免较慢的旧列表覆盖较新的对账结果；
- 当前 scope 变化（切换 provider，或修改 bucket/路径/base path 等 identity 字段；在 `saveSettings` 中比较 scope id）时 `onScopeChanged`：取消正在为其他 scope 运行的队列，并使其他 scope 此前发出的所有 token 失效。

挂接点（已实现）：`OssGalleryView.loadGallery` 在 `syncService.sync()` 前调用 `beginListing`、在 `isCurrentLoad(generation)` 通过后调用 `reconcile`；2 分钟自动同步路径同理，且即使图库无变化也对账。命令"立即为当前图床建立索引"与图库的"建立 / 更新索引"走同一协议（图库尚未对账过该 scope 时先列表）。

### 7.5 Fingerprint 规则

etag（含 GitHub sha）> `size + lastModified`。变化即重新 embed。注意现有 `SyncService.detectChanges` 的 modified 判定只看 `lastModified`，所以索引侧不要依赖它。

### 7.6 渲染前交集

任何语义结果在渲染前，与当前内存中的 `state.remoteObjects` 的 key 集合取交集（`VectorStore.search(..., allow)`），保证即便索引滞后也不展示已不在图库中的图片。P4：图库把结果（key + score）缓存在 `state.semanticResult`，每次重新列表后用 `intersectHits(remoteObjects, hits)` 重新取交集再渲染（保持原排序，丢弃已不在列表中的 key，用列表里的新 URL）；"找相似"每次重新排序（无需 worker，新索引的图片会加入）；文本查询不在自动同步时重跑 worker。

实现验证（`tests/semantic/SemanticIndexService.test.ts`）：截断列表不删除也不推进计数；完整列表缺失 → 立即隐藏（搜索不返回）；连续 2 次完整缺失清除（中间的不完整列表不计数）；缺失满 7 天清除；同 fingerprint 重新出现 → 恢复且零下载、零 embed；fingerprint 变化 → 重新 embed；旧 token 丢弃；scope 切换使旧 token 失效；只在前缀内对账；上传钩子不下载且随后采用真实 fingerprint；删除钩子立即清除。真实 worker 端到端见附录 P3。

## 8. 下载与安装流程

### 8.1 清单（写死在 main.js 中）

实现：`src/semantic/assets.ts`（P1）。

```ts
interface AssetEntry {
    name: string;            // 本地相对路径（"/" 分隔，相对 modelDir）
    url: string;             // GitHub Release 或 HF（带固定 revision）
    size: number;
    sha256: string;
    source: 'github' | 'huggingface';
}
export function getRuntimeAssets(pluginVersion: string): AssetEntry[]; // semantic-worker.js、ort-wasm-simd-threaded.asyncify.{mjs,wasm}
export const MODEL_ASSETS: AssetEntry[];   // 10 个模型文件，URL 含 /resolve/<revision>/
```

- **模型**：`MODEL_REVISION = daa72c51243991dfcaf9f9137d2c573d8f7790c0`（HF `main` @ 2026-10-06）。sha256 取自 HF API 的 `lfs.oid`（LFS 文件）或下载后计算（5 个小 json/jinja，已与 git blob id 交叉核对）。本地路径镜像 URL：`huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/<revision>/<file>`，即 P2 `fsCache` 直接读取的布局（§4.3），worker 不会再下载。
- **runtime**：URL = `https://github.com/stmoonar/oss-gallery-plugin-obsidian/releases/download/<插件版本>/<file>`；本地路径 `runtime/<插件版本>/<file>`，按版本分目录，使用不同插件版本的多个 vault 可共享同一 modelDir。哈希/大小**由构建生成**到 `src/semantic/assets.generated.ts`（`esbuild.config.mjs` 每次构建先打 worker、拷 ORT 文件、计算哈希、写该文件，再打 main.js），因此 release 中 main.js 的哈希必然与同次构建上传的资产一致；CI 在该文件与提交版本不一致时给出 warning。
- 合计 343,278,345 字节（≈ 343 MB：runtime 27.5 MB + 模型 315.8 MB）。
- `MODEL_ASSETS` 保存官方 URL；运行时实际使用 `getAllAssets(version, { hfEndpoint, githubMirror })`，镜像只替换 `url`，`name`（本地路径）、`size`、`sha256` 不变（§8.6）。

### 8.2 流程

1. 设置页"语义图片搜索"区块先跑 `WebGpuProbe`（§8.3）；不通过则状态为 `unsupported`，显示本地化原因，下载与启用均不可用。
2. 点"下载"弹确认对话框，显示：文件清单与大小（共约 343 MB）、来源（GitHub Release / Hugging Face + revision）及实际连接的主机（设置镜像时为镜像主机，并提示所有文件仍按 SHA-256 校验）、目标目录、写在 vault 之外且所有 vault 共享、不会同步的声明。
3. 确认后逐文件下载到 `<name>.part`，边下边算 SHA-256，大小与哈希都通过才 rename；失败重试 ≤ 3 次（指数退避；4xx 不重试），仍失败则保留已完成文件，可续传（按文件粒度）。下载开始时，已存在且大小正确的文件会做完整哈希，通过则跳过——手动放入的文件（离线安装）因此同样有效。
4. 全部完成后才将 `semantic.enabled = true`。启动时（仅当 `enabled`）只检查存在性与大小，不重算哈希、不自动重下，设置页提示"需要修复"；"校验"按钮做完整重哈希。手动打开"启用"开关时先完整校验再置 `enabled`。
5. "删除模型"按钮（**P1 安全修订，取代原"删除整个 `<modelDir>`"**）：用户可能把 `modelDir` 指向共享目录，因此**只删除**清单中的文件、它们的 `.part`、以及本插件的记录文件 `.oss-gallery-files.json`（记录所有装过的文件，含旧插件版本的 runtime）与锁文件 `.oss-gallery-download.lock`；记录中的路径须为相对路径且不含 `..`。随后仅移除因此变空的子目录；默认目录本身为空时一并移除，用户自定义的目录本身永不删除。删除后 `enabled = false`。对话框提示这会影响本机所有使用该目录的 vault，且不会动目录中的其他文件。
6. 安装状态机（`ModelDownloadManager`）：`checking` / `unsupported`（probe 失败；`filesPresent` 时仍可删除）/ `invalid-dir`（非绝对路径）/ `downloading`（bytesDone/bytesTotal/当前文件）/ `verifying` / `deleting`，以及由"文件现状 + 安装记录"决定的四个状态：

   | 状态 | 判定 | 文案 | 按钮 |
   |---|---|---|---|
   | `not-installed` | 没有任何模型文件，也没有 `.part`（只有 runtime 文件不算） | 尚未下载模型 | **下载模型（约 N MB）**（N = 缺失文件合计，runtime 已在则不含）、删除模型（磁盘上没有本插件的任何文件时禁用） |
   | `incomplete` | 有部分文件或 `.part`，但从未完整安装成功过 | 下载未完成：还剩 N 个文件（X MB） | **继续下载**、删除模型 |
   | `needs-repair` | 曾完整安装成功（记录里有 `completedAt`），现在有文件缺失、大小不符或校验失败，且没有 `.part` | 需要修复：缺失 N 个、损坏 M 个文件（为 0 的部分省略） | **修复**、校验、删除模型 |
   | `installed` | 所有清单文件都在且大小正确 | 已安装 | 校验、删除模型 |

   - 三个下载按钮都打开同一个确认对话框，只列出还需下载的文件；已完成的文件按 §8.2 第 3 条跳过。
   - `completedAt` 写在 `.oss-gallery-files.json`，仅在一次完整下载或"校验"全部通过时写入（只写一次，之后不清除）；没有该字段的旧记录视为从未完成，但全部文件齐全时仍是 `installed`。"删除模型"随记录一并清除它。
   - 中断下载遗留的 `.part` 算 `incomplete`，不算损坏。"校验"按钮只在 `installed` / `needs-repair` 显示。
   - 同一状态里的文案与按钮仅在种类、可删除性或下载体积变化时重建，下载进度只刷新文字。
7. 并发：下载期间持有 `<modelDir>/.oss-gallery-download.lock`（`wx` 独占创建，30 s 心跳刷新 mtime，2 分钟未更新视为残留可接管），防止两个 vault 写同一 `.part`。
8. 网络：全部用 Node `https`（手动跟随重定向，上限 5 次，只允许 https）。已验证：GitHub release 资产 302 到 `release-assets.githubusercontent.com`，两跳都**没有** `Access-Control-Allow-Origin`，渲染进程 `fetch` 会被 CORS 拦截；`requestUrl` 无流式与进度。HF LFS 文件重定向到 `us.aws.cdn.hf.co`。

### 8.3 WebGPU 检测

实现：`src/semantic/webGpuProbe.ts`。原因码与设置页提示（en/zh-cn/zh-tw）：

| reason | 含义 / 提示 |
|---|---|
| `no-api` | 无 `navigator.gpu`：Obsidian（Electron）太旧或禁用 WebGPU → 用最新安装包更新 Obsidian |
| `no-adapter` | `requestAdapter()` 为 null：驱动过旧/被拉黑、远程桌面、虚拟机 → 更新显卡驱动 |
| `software-adapter` | `isFallbackAdapter` 或名称匹配 SwiftShader/llvmpipe/WARP 等 → 检查硬件加速与驱动 |
| `insufficient-limits` | `maxBufferSize` 或 `maxStorageBufferBindingSize` < 64 MiB |
| `error` | `requestAdapter()` 抛错 |

limits 下限 = 最大单个权重张量：`model_embed_tokens_weight_quant` [262144, 256] uint8 = 64 MiB（解析 `onnx/model_q4.onnx` 得到；vision 最大 3.75 MiB）。WebGPU 规范默认保证 128 MiB binding，因此只会拒绝低于规范的适配器。旧版 Chromium 用 `requestAdapterInfo()` / `adapter.isFallbackAdapter` 兜底。每个会话只检测一次（适配器变化需重启）。`minAppVersion` 保持 1.7.2：旧版 Obsidian 检测失败即不可用。

### 8.4 目录默认值（已定）

| 平台 | 默认 `modelDir` |
|---|---|
| Windows | `%LOCALAPPDATA%\obsidian-oss-gallery\models` |
| macOS | `~/Library/Application Support/obsidian-oss-gallery/models` |
| Linux | `$XDG_CACHE_HOME/obsidian-oss-gallery/models`，否则 `~/.cache/obsidian-oss-gallery/models` |

实现：`src/semantic/modelDir.ts`。`%LOCALAPPDATA%` 缺失时退回 `~/AppData/Local`；`$XDG_CACHE_HOME` 为相对路径时按规范忽略。用户自定义 `modelDir` 支持前导 `~`，其余必须为绝对路径（否则状态 `invalid-dir`），不做"相对 vault"解析。

### 8.5 构建

- `esbuild.config.mjs` 新增第二个入口：`src/semantic/worker/entry.ts` → `dist/semantic-worker.js`，`bundle: true`、`format: "iife"`、`platform: "browser"`、`define: { process: 'undefined' }`、minify。**不要**把它并入 `main.js`。
- worker 与 ORT wasm/mjs 作为 GitHub Release 的独立资产上传（并生成 sha256 清单写入源码）；`releaseAssets`（`manifest.json`、`styles.css`、`LICENSE`）不变，`main.js` 不含 transformers.js / onnxruntime（生产构建对此做断言）。
- P1 实现：worker 还需 `target: es2022`、`legalComments: none`，以及把 `node:*` 导入替换为空模块的插件（同 P0 `build.js`）。onnxruntime-web 是 transformers.js 的传递依赖，构建脚本通过 transformers.js 的 `require.resolve('onnxruntime-web/webgpu')` 定位其 `dist/` 并复制 `ort-wasm-simd-threaded.asyncify.{wasm,mjs}`。`release.yml` 上传并 attest 这三个文件。P2 起 worker 为完整实现（§4.3），541 KB（minified）；P3 加入 UTIF.js + pako（TIFF 解码）后 625 KB。
- 测试：`vitest`（devDependency，`pnpm test`，用例在 `tests/`，Node 环境），不进入任何 bundle；CI（`lint.yml`）在 lint 后运行。
- 依赖：`@huggingface/transformers` 精确锁定 `4.3.1`（其依赖 `onnxruntime-web 1.31.0-dev.20260914-8d85527a0`）；`pnpm-workspace.yaml` 将 `onnxruntime-node`、`protobufjs` 列为 `ignoredBuiltDependencies`（Node 端原生包，插件用不到）。
- 实测 main.js：196,413 → 238,723 字节（P1，+42 KB）→ 267,523 字节（P2，+29 KB：宿主、VectorStore、自检与 locale）→ 329,785 字节（P3，+62 KB：索引/搜索服务、设置与对话框、locale；约一半为三份 locale，见 §11 第 17 条）→ P4 代码 360,359 字节（+31 KB：图库 UI、详情对话框、locale）→ 加 `charset: "utf8"` 后 **339,454 字节**（−20,905 字节，−5.8%），均无 transformers.js / UTIF.js。
- **P4 构建变更**：
  - main.js 与 worker 都设 `charset: "utf8"`（esbuild 默认把非 ASCII 转义为 `\uXXXX`，中文每字 6 字节 → UTF-8 3 字节）。worker 几乎全是 ASCII，节省可忽略（与加入的 banner 相抵后 640,466 → 640,672 字节）。
  - worker 加一行 `/*! … */` banner，说明打包了哪些开源包、许可证见 release 中的 `THIRD_PARTY_NOTICES.txt`（`legalComments: "none"` 仍然去掉各包自带的许可注释）。
  - `THIRD_PARTY_NOTICES.txt`：`scripts/third-party-notices.mjs` 由 worker 构建的 esbuild metafile 得到打包进来的 npm 包，加上直接复制的 onnxruntime-web 与 transformers.web.js 预先内联的包（按其 `// node_modules/<pkg>/` 路径注释识别：@huggingface/jinja、@huggingface/tokenizers），逐包写入名称、版本、许可证、来源和许可证全文（onnxruntime-web/common 的 npm 包没有 LICENSE 文件，按其 MIT 声明补全文，并给出 ORT wasm 内第三方组件的 ThirdPartyNotices 链接）。当前：@huggingface/jinja 0.5.10、@huggingface/tokenizers 0.2.0、@huggingface/transformers 4.3.1、onnxruntime-common 1.30.0、onnxruntime-web 1.31.0-dev、pako 1.0.11、utif 3.1.0，约 30 KB。找不到许可证文本时构建失败。
  - 该文件是 release 资产（`release.yml` 上传并 attest），**不进入** `assets.generated.ts` 的哈希清单、也不由下载管理器下载：运行不需要它；加入清单会让每次启动 worker 都多读一个文件做哈希，并让已安装的 runtime 目录变成"未完成"。worker 文件头的 banner 指向它。
- 注意：现有配置 `external` 含 `...builtinModules`，所以主线程使用 `fs`/`path`/`crypto` 无需额外处理；worker 端是 browser 平台，Node 的 `require` 通过 `self.require` 取得（P2 实测在 Blob URL worker 中可用；P0 用的 `(0, eval)('require')` 同样可行，但会触发 lint 的 `no-eval`）[P0 §7]。
- ORT 的 mjs 需应用与 transformers.js 相同的补丁 `code.replaceAll('globalThis.process?.versions?.node','false')`，仅在走"binary 模式"时需要 [P0 §8]。P2 采用 binary 模式（§4.3），由 worker 在 `engine.ts` 中打补丁。

### 8.6 下载镜像（P1 已实现）

实现：`src/semantic/mirrors.ts`，设置 `semantic.hfEndpoint` / `semantic.githubMirror`（默认 `''` = 官方）。

- **HF 端点**：替换 `https://huggingface.co`，URL = `<hfEndpoint>/<repo>/resolve/<revision>/<file>`。例：`https://hf-mirror.com`（与官方同布局；2026-10-15 实测：从非中国大陆网络访问时 hf-mirror.com 以 308 跳回 huggingface.co，下载内容 SHA-256 一致；国内直连行为未在本机验证）。
- **GitHub 镜像**："代理前缀"式，URL = `<githubMirror>/<完整 GitHub URL>`，如 `https://gh-proxy.com/https://github.com/stmoonar/oss-gallery-plugin-obsidian/releases/download/<version>/<file>`（2026-10-15 实测 gh-proxy.com 直接返回 200，哈希一致）。
- **校验**：`normalizeMirrorUrl` 只接受 `https://`（`http://` → `not-https`，其余无法解析、含账号密码、查询串或 fragment → `invalid`），去掉末尾 `/`。设置页非法值行内报错且不保存；`loadStoredSettings` 遇非法值回退 `''`。
- **安全性**：镜像只改变字节来源，每个文件仍按清单 SHA-256 + 大小校验，镜像无法改变安装内容；确认对话框显示实际连接的主机。重定向仍只允许 https。
- **不影响已安装文件**：本地路径与哈希不依赖镜像，修改镜像不触发重新检查或下载；正在进行的下载继续使用开始时的 URL。
- 离线替代：手动按 §8.2 第 3 条的布局放入文件后点"校验"/"下载"。开发时可用 `pnpm run dev:install -- --vault <path>` 把 `dist/` 的 runtime 直接放入 `<modelDir>/runtime/<version>/`（并写入安装记录），未发布的 Release URL 不会被访问。

## 9. UI

### 9.1 SearchComponent（P4 已实现）

`src/components/SearchComponent.ts`；模式规则是纯函数 `src/components/searchMode.ts`（`toggleSemantic / toggleRegex / applyAvailability / queryFor / intersectHits`，`tests/semantic/searchMode.test.ts`）。

- **语义开关**（✨ `sparkles` 图标，`aria-pressed`）放在输入框**外**、搜索按钮之前：输入框内右侧已有正则开关与原生清除按钮，二者由 Obsidian 的 `input-right-decorator` / `search-input-clear-button` 定位，再塞第三个按钮需要猜测 Obsidian 的内部偏移，容易重叠。
- **始终显示**，不可用时为禁用外观（`aria-disabled="true"`，仍可聚焦，tooltip 说明原因，而不是用 `disabled`——禁用按钮收不到悬停，tooltip 不出现）。可用性由 `SemanticIndexing.availability(provider, prefix)` 给出：`checking`（启动检查中）、`not-installed`、`webgpu`、`disabled`（已安装但关闭）、`no-list`（provider 不可列表/不可建索引）、`no-index`（尚无索引）；可用且该 scope 正在索引时 tooltip 为"索引进行中，结果可能不完整"。
- 语义与正则互斥：打开语义自动关闭正则；语义模式下正则开关禁用。可用性丢失（清除索引、关闭功能）时自动退出语义模式并回到全部图片。
- 语义模式下 placeholder 变为"例如：沙发上的猫"，输入框边框带强调色。Enter / 搜索按钮 → `SemanticSearchService.searchByTextScored`（query worker），结果替换网格，按分数降序，每张图左下角一个淡色小分数（两位小数）。结果区显示"语义：“查询” · N 张，最相关的在前 ×"。
- 首次查询（query worker 冷启动约 1.5 s）时结果区显示"正在加载搜索模型…"（`SemanticSearchService.isWarm()` 为 false），否则"正在搜索…"；较新的请求使旧请求的结果作废（`semanticToken`）。
- 清除按钮、有内容时 Esc、或结果区 × → 回到全部图片；空输入框时 Esc 也退出语义/相似结果（`onEscapeEmpty`）。
- 模式按视图会话记住（`GalleryState.useSemanticSearch`，不持久化）；结果缓存在 `GalleryState.semanticResult`（§7.6）。

### 9.2 其它 UI（P4 已实现）

- **找相似图片**：图片右键菜单（Obsidian `Menu`：找相似图片 / 复制 URL / 删除；键盘菜单键或 Shift+F10 在图块上同样可用）与悬停按钮（`images` 图标，仅对已索引的图片显示；未索引时菜单项禁用并注明"尚未索引"）。用已存向量排序（不需要 worker），排除自身；结果区显示"与 <文件名> 相似 · N 张 ×"。同时把搜索框切到语义模式。
- **图库顶部的语义条**（`src/components/SemanticIndexBar.ts`，在工具栏下方；功能未启用或 provider 不可建索引时隐藏）：
  - 索引进行中（本 scope）："正在索引 12 / 340 · cat.png" + 进度条（`role=progressbar`）+ 暂停/继续 + 停止（停止保留已完成的部分）。
  - 空闲且无索引："当前图床还没有语义索引。" + **建立索引**。
  - 空闲且有索引：状态标签"已索引 1,234 张 · 3 张已转换 · 2 张不支持 · 1 张失败 · 5 张待索引"（为 0 的部分省略，`formatIndexSummary`），点击打开**详情对话框**；有待办时另有 **更新索引（N 张新图片）**。
  - 只有形状（运行/暂停/空闲有无待办/无索引）变化时才重建按钮，进度只更新文字，键盘焦点不丢失。变化通知由 `SemanticIndexing` 合并（100 ms）：索引进度、模型安装状态、设置变化、清除索引。
- **详情对话框**（`SemanticIndexDetailsModal`）：标题"语义索引状态"、汇总行、经转换的文件（原格式）与不支持/失败的文件（状态（失败次数）、原因）两张表，文件名是按钮，点击后关闭对话框并在图库中定位（如有搜索先退出、等待分批渲染、滚动到中央、强调色描边并聚焦）；**重试失败的图片（N）**调用 `resetFailed` 后按手动开始（远程照常弹流量对话框）。表格组件 `src/components/IndexStatusDetails.ts` 与设置页共用（设置页不带定位）。
- **建立 / 更新索引**按钮 = 手动开始：未对账过时先列表；远程每次弹流量对话框；无待办时提示"已是最新"并创建空索引。
- **状态栏**：索引中显示"正在索引 done/total"（点击暂停/继续）；空闲且当前 provider 有索引时显示"语义：已索引 N 张"，点击（或聚焦后 Enter）打开/聚焦图库并切到语义模式（不可用时以 Notice 说明原因）。
- **图块键盘可达**：图块 `tabindex=0`，Enter/空格预览，聚焦时显示悬停按钮；复制/删除/找相似按钮有 `aria-label`。
- **命令**：保留"运行自检"（诊断）、"立即为当前图床建立索引"、"停止建立索引"；删除"搜索（调试）"及其对话框与字符串。
- 设置页"语义搜索"区块：WebGPU 检测状态、启用/下载、删除模型、存储路径、token budget（修改时提示将全量重建）、自动索引开关、当前 scope 的索引统计与问题文件（与详情对话框同一组件）。
- 所有新增字符串同步更新 `src/locale/en.ts`、`src/locale/zh-cn.ts`、`src/locale/zh-tw.ts`；CSS 全部以 `oss-gallery-` 前缀限定，只用 Obsidian 主题变量（明暗主题通用），并尊重 `prefers-reduced-motion`。README 说明用法、WebGPU 要求、下载来源、**写入 vault 之外目录**、流量与第三方许可。

### 9.3 设置模型

在 `PluginSettings` 新增（全局，不放入 `providers`）：

```ts
semantic: {
    enabled: boolean;
    modelDir: string;           // '' = 平台默认
    indexDir: string;           // P3：'' = <appDir>/indexes；按设备存放索引，不同步（§5）
    imageTokenBudget: 70 | 140 | 280;
    autoIndex: boolean;
    hfEndpoint: string;         // '' = https://huggingface.co；否则为规范化的 https URL（§8.6）
    githubMirror: string;       // '' = 官方；否则为代理前缀 <githubMirror>/https://github.com/...（§8.6）
}
```

默认值：`{ enabled: false, modelDir: '', indexDir: '', imageTokenBudget: 70, autoIndex: false, hfEndpoint: '', githubMirror: '' }`（`indexDir` 为 P3 新增，旧 data.json 缺失时回退 `''`）；`loadStoredSettings` 对缺失/非法字段逐项回退默认值（镜像 URL 经 `normalizeMirrorUrl` 规范化，非法则回退 `''`）。`enabled` 只由"下载并全部校验通过"或"开关打开时完整校验通过"置为 true；校验失败、删除模型、`modelDir` 改到未安装的目录都会置回 false。

### 9.4 流量提示对话框（P3 最小版本，P4 已打磨）

远程 provider 建索引前（`SemanticIndexService.start` → `deps.confirmTraffic(scope, estimate, reason)`，`SemanticTrafficModal`）：

- 估算 = 所有待办对象（未索引或 fingerprint 已变化，且不是 `unsupported` / 退避中的 `failed`）的 `size` 之和；Local 为 0（直接读盘），不弹框。列表没有给出大小（`size` 为 0）的对象单独计数（`unknownSizeCount`），此时下载量显示为"≥ X"并注明"图床没有报告其中 N 张图片的大小，实际下载量可能更大"。
- 显示三个大号数字"N 张待索引 / 需下载 X MB|GB / M 张已有索引"（`formatBytes`，≥ 1 GB 用 GB；数量带千分位）、来源 provider 与"可能消耗移动流量或流量额度"的提示；只有点"开始建立索引"才返回 true，关闭或取消都是 false。
- 自动索引弹框时第一行说明原因：`auto-first`"自动索引在本设备上首次从远程图床下载前会先询问"；`auto-large`"本次需要下载超过 200 MB，自动索引再次询问"。
- 规则（纯函数 `trafficPromptReason({ local, pendingCount, auto, confirmedBefore, pendingBytes })`，`tests/semantic/trafficPrompt.test.ts`）：
  - Local 或没有待办：不弹框（`null`）。
  - 手动开始（图库"建立 / 更新索引"、"重试失败"、命令"立即为当前图床建立索引"）：远程 scope 有待办时**每次**都弹框（`manual`）。
  - `autoIndex`：列表对账后若有待办且模型就绪则自动开始；远程 scope 若从未确认过（`status.json` 无 `confirmedAt`）或估算超过 `AUTO_CONFIRM_LIMIT_BYTES = 200 MB` 则弹框，同一会话中被拒绝后不再自动弹出（手动命令仍可）。
  - 确认成功写入 `confirmedAt`；修改 `indexDir` 后新位置没有该记录，所以需要重新确认。
- 后续若支持 provider 端缩略图，改显示"最多 X GB"。

## 10. 实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 已完成。Spike：模型、延迟、内存、缓存、Blob worker [P0] | RESULTS.md |
| P1 | 下载管理器 + 设置页：WebGPU 检测、opt-in 对话框、SHA-256 校验、fs 存储、进度、删除模型；esbuild 第二入口；Release 资产与清单生成 | 断网/中断/篡改文件均能正确失败与恢复；`pnpm run lint` 通过 |
| P2 | 已完成。worker 与 `EmbeddingBackend` 接口、`fsCache`、`VectorStore`（格式、原子写、compaction）、自检命令、vitest | 单元测试：崩溃恢复、header 不符重建；本地能嵌入并检索（见附录 P2 实测） |
| P3 | 已完成。`SemanticIndexService` / `SemanticSearchService`、对账协议、`listImages` → `ListResult`、`etag`、挂接 `OssGalleryView`/上传/删除、按设备的索引目录、流量确认（最小版）、图片格式处理（§12）、调试命令、状态栏进度、设置页索引统计与问题文件列表 | 已满足：模拟截断列表不删向量；删除后立即不可见；过期 token 被丢弃（单元测试 221 个通过，真实 worker 端到端见附录 P3） |
| P4 | 已实现（待手工验收）。UI：语义开关、"找相似图片"、流量对话框打磨、图库内进度条与状态标签、问题文件详情面板（定位、重试）、状态栏入口；远程取字节改为 `requestUrl` + 签名 GET 回退；`.avif` 加入图库；`THIRD_PARTY_NOTICES.txt`；`charset: "utf8"`；README（§9、附录 P4） | 手工在 Local 与一个 S3 兼容 provider 上端到端验证（单元测试 245 个通过） |

涉及 WebGPU 的代码先在本地做可跑通的部分（下载、存储、VectorStore、协议，可用 `FakeEmbeddingBackend`）；真实推理用 Electron 39.6.0 测试工具（Obsidian 同款设置）或在 Obsidian 中运行"语义搜索：运行自检"命令验证（P2 已在 Intel Arc iGPU 上实测）。

P3 的调试入口（P4 图库 UI 之前）：命令"语义搜索：立即为当前图床建立索引"（先列表 + 对账，再 `start`）、"语义搜索：搜索（调试）"（输入描述 → 前 10 个 key、分数与缩略图）、"语义搜索：停止建立索引"；状态栏显示"正在索引 done/total"，点击暂停 / 继续。P4 起"搜索（调试）"已删除（由图库搜索框取代），其余命令保留；整个功能可只通过图库 UI 测试（§9.1–§9.2）。

## 11. 风险与未决问题

1. **社区审核立场**：Obsidian 社区插件审核对"运行时下载并执行代码"（worker bundle + wasm）的态度未知。缓解：SHA-256 硬编码、opt-in、来源为本项目自己的 Release；最坏退路是仅作为 BRAT/手动安装特性。需在 P1 前确认或提前沟通。
2. **真实图库检索质量**：P0 仅 6 张样例，结果 6/6 top-1 但样本偏容易 [P0 §6]。需用真实图库（截图、文档、照片混合，中英文查询）评估，决定 token budget 默认值是否仍为 70。
3. **iGPU 内存压力**：iGPU 共享系统内存；GPU 进程批量时达 2.4 GB（无批量 1.08 GB），渲染进程约 1.1 GB [P0 §5]。低内存机器可能卡顿。缓解：索引结束即回收 worker；可选降低批大小；设置页给出内存提示。
4. **模型文件布局变化**：`onnx-community` 仓库可能调整文件结构。缓解：URL 固定 revision（commit hash），清单中记录。
5. **`minAppVersion` 与 WebGPU**：manifest 为 `1.7.2`，P0 只在 Obsidian 1.14.4（Electron 39.6.0）验证。旧版 Electron 的 WebGPU 支持不一致，由 `WebGpuProbe` 兜底；是否提高 `minAppVersion` 待定（默认不提高，探测失败即不可用）。
6. ~~**插件目录同步冲突**~~（P3 已从设计上解决）：索引改为按设备存放在 vault 之外的 `semantic.indexDir`（D7、§5），不再经 Obsidian Sync/iCloud 同步，也就不存在多设备并发写同一 `meta.json`/`vectors.bin`。代价：索引不随 vault 漫游，每台设备各自建立（远程图床需各自下载一次）。P2 的逐条校验和仍保留，用于崩溃与手工拷贝的情形。
7. **暴力检索规模**：当前设计在主线程暴力点积，约 5 万张以内可接受；更大规模需移入 worker 或分块。
8. **跨 vault 共享模型目录**：P1 已加下载锁（§8.2 第 7 条）；删除只删清单与记录中的文件（§8.2 第 5 条），但仍会影响共享该目录的其他 vault（对话框已提示）。删除与另一 vault 的下载之间未加锁。
9. ~~**`listImages` 返回类型变更**~~：P3 已一次改完 11 个 provider（含 Imgur）及调用方，`ListingCollector` / `collectPages` 有单元测试（§4.1）。provider 自身的 HTTP 分页逻辑仍无单元测试（依赖 `requestUrl` / `DOMParser`），需在 P4 端到端验证一个 S3 兼容 provider。
10. 不再需要：向上游提交 patched `GatherBlockQuantized` 图（无 CPU 路径，此项不适用）。
11. **代理 / 镜像**（P1 新发现）：Node `https` 不走系统代理，Hugging Face / GitHub 在部分地区不可直连或很慢。
    - [x] 可配置镜像：`hfEndpoint`（如 hf-mirror.com）与 `githubMirror`（代理前缀），已在 P1 实现（§8.6）。
    - [ ] **未决**：系统代理 / 自定义代理 agent 仍不支持（`https.get` 不读取系统或 Electron 代理设置）。可考虑读取 `session.resolveProxy` 或允许配置 `https://` / SOCKS 代理。
12. **transformers.js 内部假设**（P2 新发现）：4.3.1 的 `get_tokenizer_files` / `get_processor_files` 忽略 `revision`，固定探测 `resolve/main/`；离线 fs 缓存靠 `main → 固定 revision` 别名绕过（§4.3）。升级 transformers.js 时需重新验证：离线加载、`local_files_only`、`allowLocalModels=true + allowRemoteModels=false` 组合、binary 模式的 `wasmBinary` / Blob mjs。
13. **`self.require` 依赖 `nodeIntegrationInWorker`**（P2）：worker 读模型文件需要 Node `fs`。若 Obsidian 关闭该选项，`init` 以 `model-load`（"Node integration is not available"）失败，需改为主线程代理 fs（§4.3 末）。
14. **主线程 I/O**（P2 提出，P3 实测并缓解）：1 万条时同步 flush 阻塞 13–20 ms、首次全量 flush 约 60 ms、打开约 60 ms、compaction（6 千条）约 27 ms。索引服务改用 `asyncIo` flush，最大阻塞降到 7–14 ms（主要是 `JSON.stringify` 1.1 MB meta）；`close()`（卸载）与 compaction 仍为同步，后者每次 run 结束最多一次。若更大规模仍卡顿：增量 meta（只追加日志）或把 meta 序列化移入 worker。
15. ~~**图片解码差异 / 无法解码的格式**~~（P3 已决定，§12）：SVG 主线程栅格化、TIFF 在 worker 内用 UTIF.js 解码，二者记为 `converted`；HEIC/HEIF、PSD、RAW、无法识别的数据记为 `unsupported` 并跳过。浏览器解码在不同 Chromium 版本间的细微差异仍存在，不影响排序。
16. **远程取字节的权限**（P3 新发现，P4 部分解决）：远程索引一律用 `requestUrl`（无 CORS 要求；`fetch()` 从 `app://obsidian.md` 源请求需要存储桶 CORS，私有桶还会 403）。S3 / R2 / MinIO 在公开 URL 返回 401/403 时改用 SigV4 签名 GET（`signedObjectGet`，§4.5）。
    - [x] S3 系私有桶；403/404 给出可读原因。
    - [ ] **未决**：Aliyun / Tencent / Qiniu / Upyun / GitHub 私有仓库没有签名 GET 回退（各自签名方式不同），私有时记为 `failed`（"拒绝访问：请检查存储桶权限"）。需要时按 provider 实现 `signedObjectGet`。
    - [ ] 未在真实私有桶上手工验证（单元测试用模拟的 requestUrl）。
17. ~~**main.js 体积**~~（P3 提出，P4 已解决）：main.js 与 worker 都设 `charset: "utf8"`，main.js 360,359 → 339,454 字节（−20,905，−5.8%；§8.5）。
18. **P4 UI 未在真实 Obsidian 中自动化测试**：图库 UI 依赖 DOM / Obsidian API，单元测试只覆盖纯逻辑（模式切换、状态文本、流量规则、远程取字节）。按 §10 的手工脚本验收；尤其注意：首次查询的"正在加载搜索模型"、键盘菜单键在图块上的菜单位置、深色主题下的分数徽标与选中描边。
19. **语义文本结果不随自动同步重排**：缓存的命中只做交集（删除的图片会消失），新增并完成索引的图片要重新按 Enter 才会出现在文本结果中；"找相似"每次重排。

## 12. 图片格式与索引状态（P3）

维护者决定：worker 解码器读不了的格式尽量转换，并把"经转换"和"不支持"的文件都告诉用户。实现：`src/semantic/imageFormat.ts`（纯函数，可单测）、`src/semantic/svgRasterizer.ts`（主线程）、`src/semantic/worker/tiff.ts`（worker 内）。

**检测**：以字节魔数为准（扩展名只用于区分 TIFF 容器的相机 RAW，如 `.cr2/.nef/.dng`）。JPEG `FF D8 FF`、PNG、`GIF8`、`RIFF…WEBP`、`BM`、ICO/CUR、ISO-BMFF `ftyp`（品牌含 `avif`/`avis` → AVIF，否则 `heic/heix/hevc/mif1/…` → HEIC）、`8BPS`（PSD）、TIFF `II*\0` / `MM\0*`（含 BigTIFF 魔数）、文本开头含 `<svg` → SVG。

| 类别 | 格式 | 处理 | 状态 |
|---|---|---|---|
| 原生 | JPEG、PNG、WebP、GIF（第一帧）、BMP、ICO、AVIF | 字节直接交给 worker（`createImageBitmap`） | `ok` |
| 转换 | SVG | 主线程：Blob URL + `<img>` 解码（图片上下文不执行脚本、不加载外部资源，Blob URL 随即撤销，不插入 DOM）→ `OffscreenCanvas` 白底绘制，最长边缩放到 [512, 1024] px → PNG。源文件 > 10 MB 视为不支持；画布被污染等错误按 `failed` 处理 | `converted`（`format: svg`） |
| 转换 | TIFF | worker 内 UTIF.js 3.1.0（MIT，photopea）+ pako 1.x（MIT/Zlib）解码最大的一页（多页 TIFF 常带缩略图）→ RGBA → `ImageData` → 与其他格式相同的缩放与白底合成；> 64 MP 拒绝；支持无压缩、LZW、PackBits、Deflate、TIFF 内嵌 JPEG、CCITT。只打进 worker（main.js 中无 UTIF/pako，构建产物已核对） | `converted`（`format: tiff`） |
| 不支持 | HEIC/HEIF、PSD、相机 RAW、无法识别的字节 | 不送 worker，记录原因 | `unsupported`（`format`, `reason`），fingerprint 不变就不再尝试 |
| 失败 | 下载失败、SVG 栅格化失败、受支持格式解码失败（如截断的 JPEG）、推理失败 | 记录原因与次数 | `failed`（`reason`, `attempts`），退避重试：第 1 次失败后 1 分钟、第 2 次后 10 分钟，共 `MAX_ATTEMPTS = 3` 次；之后不再重试，直到 fingerprint 变化 |

注意：图库列表只包含 `IMAGE_EXTENSIONS`（jpg/jpeg/png/gif/bmp/webp/svg/ico/tiff/tif，P4 起加 **avif**：Chromium 原生解码，图库缩略图、预览与 worker 的 `createImageBitmap` 都可用；上传路径、embed 渲染不依赖该列表，不受影响），所以 HEIC 等扩展名的文件不会出现在列表与索引中；`unsupported` 主要来自扩展名与内容不符的文件（如实为 HEIC 的 `.png`）。

不新增 `PREPROCESS_VERSION`：已有格式的解码路径不变，TIFF / SVG 之前都是失败，不存在旧向量。

**状态存储**：`status.json`（`IndexStatusStore`），只记录非 `ok` 条目 `{ fp, status, format?, reason?, attempts?, nextRetryAt?, at }` 与 `confirmedAt`（§9.4）；`ok` = 有向量且无旁注。向量库 `reset`（header 变化）时只保留 `unsupported`。原子写（tmp + rename），2 s 防抖。

**对外接口**：`SemanticIndexService.getStats(scope)` → `{ indexed, ok, converted, unsupported, failed, pending, missing, items: [{ key, status, format?, reason?, attempts? }] }`，供 P4 的详情面板使用。

**用户可见部分**（P3；P4 加入图库状态标签与详情对话框，§9.2）：
- 每次 run 结束的 Notice（`RunSummary`）："已索引 120 张，其中 3 张经转换（SVG/TIFF）、2 张不支持（HEIC）、1 张失败 — 详情见图库中的索引状态或设置"；只有上传钩子且无问题时不提示；backend 错误时提示"语义索引已停止：原因"。
- 设置页"本 vault 的索引"：当前 provider 的计数，可展开的"不支持或失败的文件"表（文件 / 状态（失败次数）/ 原因）与"经转换的文件"列表，以及"清除本 vault 的索引"按钮。

## 附录：P4 构建与测试

- 单元测试 221 → 245 个（新增 `remoteBytes`、`searchMode`、`statusText`、`trafficPrompt`），`pnpm run lint` 0 错误（3 个既有警告），`tsc` 通过。
- main.js：P3 329,785 → P4 代码 360,359 → `charset: "utf8"` 后 339,454 字节；`semantic-worker.js` 640,466 → 640,672 字节（banner +230 字节，utf8 节省约 24 字节）；`THIRD_PARTY_NOTICES.txt` 30,642 字节。worker 哈希因 banner 改变，`assets.generated.ts` 随之更新（已有的开发安装需重新 `dev:install`）。
- 真实 GPU / Obsidian 中的 UI 验收按 §10 由维护者手工完成（见 §11 第 18 条）。

## 附录：P3 实测数据

环境同 P2（Intel Core Ultra 5 125H / Intel Arc iGPU，Windows 11，Electron 39.6.0 测试工具，Obsidian 同款 `webPreferences`）。直接运行插件源码中的 `SemanticIndexService` + `SemanticSearchService` + `WorkerEmbeddingBackend` + `svgRasterizer`，worker 为本次构建的 `dist/semantic-worker.js`（含 UTIF.js，经 `dev:install` 放入 `runtime/2.1.0/`）。Local 风格目录 `img/` 下 5 个文件：`cats.jpg`、`astronaut.png`、`red-circle.svg`（含 `<script>` 与外部 `<image href="https://…">`）、`corgi.tiff`（由 corgi.jpg 生成的无压缩 RGB TIFF）、`phone.png`（实为 HEIC 头）。会话级拦截所有 http(s) 请求。

| 项目 | 结果 |
|---|---|
| 网络请求 | **0**（SVG 的外部引用未被加载，脚本未执行） |
| 一次 run（含 worker 冷启动、着色器编译、5 个文件） | 11.7 s |
| RunSummary | 已索引 4（经转换 2：TIFF、SVG），不支持 1（HEIC），失败 0 |
| 文本检索 top-1（英 4 / 中 2 条） | 6/6：`a red circle`→svg 0.802，`a corgi dog`→tiff 0.808，`cats lying on a couch`→jpg 0.780，`an astronaut`→png 0.797，`红色的圆形`→svg 0.791，`一只柯基犬`→tiff 0.762；第二名 ≤ 0.661 |
| 找相似（corgi.tiff） | 排除自身，返回其余 3 张 |
| 外部删除 cats.jpg 后完整列表 ×2 | 第 1 次：隐藏但仍在库中；第 2 次：清除 |
| 索引目录内容 | `meta.json`、`status.json`、`vectors.bin` |

主线程 flush 阻塞（Node，1 万条 × 256 维，每次追加 8 条）：同步 13–20 ms → `asyncIo` 7–14 ms（§11 第 14 条）。

构建产物：main.js 267,523 → 329,785 字节；`semantic-worker.js` 554,113 → 640,466 字节（+86 KB，UTIF.js + pako）。

## 附录：P2 实测数据

环境同 P0（Intel Core Ultra 5 125H / Intel Arc iGPU，Windows 11）。测试工具：Electron 39.6.0，Obsidian 同款 `webPreferences` 与 `--enable-features=SharedArrayBuffer`，页面在 `app://` 下；直接调用插件源码中的 `WorkerEmbeddingBackend` / `loadVerifiedRuntime`，运行构建产物 `dist/semantic-worker.js`（经 `dev:install` 放入默认 modelDir 的 `runtime/2.1.0/`），模型为默认 modelDir 中经 SHA-256 全量校验的 10 个文件。会话级 `webRequest` 拦截所有 http(s)/ws 请求：整次运行**拦截到 0 个请求**（worker 根本没有尝试联网）。token budget 70，256 维。

| 指标 | 结果 |
|---|---|
| 运行时校验（3 文件 SHA-256，27 MB） | 50–205 ms |
| index worker 冷加载（worker 内 / 宿主总计） | 3.3–4.6 s / 3.8–4.8 s；会话 `[model, vision_encoder]` |
| query worker 冷加载 | 4.3 s / 4.6 s；会话 `[model]` |
| 首张图片（含着色器编译） | 5.8 s |
| 单图 @70 token（含解码，10 张） | 中位 353–376 ms，p90 475–535 ms |
| 批量 8 @70 token | 282–302 ms/张（1 批）；10 张 → 2 批（8+2） |
| 批量 vs 单张 | 余弦 1.0000（8/8） |
| 文本查询（index worker / query worker） | 中位 45 / 63 ms，p90 49–60 / 83 ms；12 条批量 109 ms；批量 vs 单条余弦 1.0 |
| 输出向量 | `Float32Array`，256 维，范数 0.99999999–1.00000001 |
| 检索 top-1（P0 的 6 对图文） | 英文 6/6，中文 6/6；正确对相似度 0.75–0.81，最小间隔 英 0.092 / 中 0.075 |
| 坏图 | 该张 `decode` 错误，同批其他图正常 |
| 离线失败路径 | 宿主不提供 config.json → `init` 以 `model-load` 失败（"file was not found locally"），无网络请求 |
| 运行时缺失 | `runtime-verify`，worker 不启动 |
| recycle 后重启（含重新校验、加载、着色器） | 5.4 s |
| 峰值私有内存 | 渲染进程 1.18 GB，GPU 进程 1.52 GB（批量 8） |
| 自检逻辑（`runSelfTest`，合成红圆 + cats + invoice × 3 条查询） | 3/3 对角线最高（0.803 / 0.669 / 0.688） |

与 P0 的差异：单图与批量略慢于 P0（309 / 235 ms），因为计时包含主线程到 worker 的传输、`createImageBitmap` 解码与白底合成；检索结果一致。

## 附录：P0 实测数据

环境：Obsidian 1.14.4（Electron 39.6.0 / Chrome 142），Intel Core Ultra 5 125H，Intel Arc iGPU（Meteor Lake），32 GB RAM，Windows 11；`@huggingface/transformers` 4.3.1，`dtype q4`。来源：[P0]。

| 指标 | WebGPU（iGPU） |
|---|---|
| 冷加载（不含下载） | ≈ 3.0 s（processor ≈ 0.8 s + sessions ≈ 2.2 s）；首次推理再加 ≈ 2.5 s 着色器编译 |
| 单图 280 token | 中位 1.43 s（p90 1.49 s） |
| 单图 70 token | 中位 309 ms（p90 379 ms） |
| 批量 8 @ 70 token | 235 ms/张（≈ 4.3 张/s）；280 token 批量无收益 |
| 文本查询 | 中位 37 ms（p90 42 ms）；12 条批量 91 ms |
| 内存 | 渲染进程 ≈ 1.1 GB；GPU 进程 1.08 GB（批量时 2.4 GB） |
| 检索 | 6/6 top-1，768/256 维 × 中英文 × 70/280 token 全部一致；正确对均值 ≈ 0.73，错误对 ≈ 0.53 |
| 下载 | 315.8 MB，131 s（该网络环境），10 个文件 |

CPU/wasm 对照（仅用于说明 D2）：补丁图后 70 token 2.54 s/张（4 线程），280 token 约 25 s/张，渲染进程峰值 3.4 GB。

模型文件（10 个，约 316 MB）：`config.json`、`processor_config.json`、`preprocessor_config.json`、`tokenizer_config.json`、`chat_template.jinja`、`tokenizer.json`（32.2 MB）、`onnx/model_q4.onnx`（0.49 MB）、`onnx/model_q4.onnx_data`（174.0 MB）、`onnx/vision_encoder_q4.onnx`（0.16 MB）、`onnx/vision_encoder_q4.onnx_data`（109.0 MB）。

Runtime 资产：worker bundle 547 KB（minified）、`ort-wasm-simd-threaded.asyncify.wasm` 25.6 MB、`ort-wasm-simd-threaded.asyncify.mjs` 52 KB。

已知坑（均在 [P0] 中验证）：`IS_NODE_ENV` 误判（需 `define: { process: 'undefined' }`）；`crossOriginIsolated=false` 时 ORT 默认单线程（WebGPU 路径无影响）；`model.dispose()` 后重载会泄漏，需回收 worker；批量需 `processor(null, imgs.map(i => [i]))`。
