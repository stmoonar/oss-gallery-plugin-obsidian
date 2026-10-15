# 语义搜索（Semantic Search）设计文档

状态：设计已定，P0 spike 完成，P1 已实施（分支 `feat/semantic-search`），P2–P4 待实施。
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
| D7 | 索引文件存插件目录（不进 `data.json`），每个 scope 一份 | 体积小（约 1 KB/图）可被同步；`data.json` 不适合放二进制 |
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
│    ├─ SemanticIndexService ──── VectorStore ──► <pluginDir>/semantic-index/     │
│    │     ▲  (per scope, serial queue)          │     <scopeId>/{meta.json,      │
│    │     │ reconcile/enqueue                   │               vectors.bin}     │
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
        图片字节来源：Local = fs 读取；远程 = fetch(url)；上传 = 内存中的 File
```

## 4. 模块与接口

新增目录 `src/semantic/`（不放入现有 `src/services/` 以便整体 lazy-load）。以下为接口草图，签名可在实现时微调，语义不变。

### 4.1 现有接口的改动（P3）

当前 `IStorageProvider.listImages(prefix?)` 返回 `Promise<OssImage[]>`（`src/types/oss.ts`）。改为：

```ts
// src/types/oss.ts
export interface OssImage {
    key: string;
    url: string;
    lastModified?: Date;
    size: number;
    /** S3 系 etag / GitHub blob sha。用于 fingerprint；缺省则退化为 size+lastModified。 */
    etag?: string;
}

export interface ListResult {
    items: OssImage[];
    /** false = 列表被截断或部分请求失败；此时绝不能据此判定"已删除"。 */
    complete: boolean;
}

interface IStorageProvider {
    listImages(prefix?: string): Promise<ListResult>;
}
```

- 所有 provider 的 `listImages` 都要改：Aliyun / Tencent / Qiniu / S3Compatible（`MAX_LIST_PAGES`）、GitHub / Upyun（`MAX_LIST_REQUESTS`）、SmMs（自有 `SEE_MAX_PAGES`）、Local、Imgur（返回 `{ items: [], complete: true }`）。
- 凡调用 `warnListingCapped(...)` 的分支，同时置 `complete = false`；中途请求抛错但已返回部分结果的分支同样置 `false`。
- `src/providers/shared/listing.ts` 可新增辅助 `ListingCollector`，统一 push 与 `markIncomplete()`。
- `SyncService.sync()` 返回值增加 `complete: boolean`；`SyncService.fetchRemoteObjects` 透传。`detectChanges` 的 `deleted` 在 `complete === false` 时对索引侧无意义（视图侧现有行为不在本特性范围内）。
- 各 provider 填充 `etag`：S3 系 `<ETag>`、Aliyun/Tencent/Qiniu 列表自带的 etag/hash 字段、GitHub 取 tree entry 的 `sha`。取不到则留空。

### 4.2 Fingerprint

```ts
export function fingerprint(o: OssImage): string {
    if (o.etag) return `e:${o.etag}`;               // GitHub 的 sha 也放 etag 字段
    return `s:${o.size}:${o.lastModified?.getTime() ?? 0}`;
}
```

### 4.3 EmbeddingBackend（P2）

```ts
export interface EmbeddingConfig {
    modelId: string;            // 'onnx-community/embeddinggemma-2-ONNX'
    revision: string;           // 固定 commit hash，= src/semantic/assets.ts 的 MODEL_REVISION（见 §8.1）
    dtype: 'q4';
    dims: 256;                  // 截断后维度
    imageTokenBudget: 70 | 140 | 280;
    preprocessVersion: number;  // 自增；改变缩放/裁剪逻辑时 +1
}

export interface EmbeddingBackend {
    /** mode 'query' 只加载 text；'index' 加载 text+vision。 */
    init(mode: 'query' | 'index', cfg: EmbeddingConfig): Promise<void>;
    embedText(queries: string[]): Promise<Float32Array[]>;          // 内部加前缀、截断、归一化
    embedImages(images: Blob[]): Promise<Float32Array[]>;           // 批量；返回已截断+归一化向量
    dispose(): Promise<void>;                                       // = terminate worker，不是复用
}
```

实现 `TransformersWorkerBackend`：主线程只做 `postMessage`；worker 内：

```ts
const config = await AutoConfig.from_pretrained(id);
config.audio_config = null;                    // 索引与查询都不要 audio
if (mode === 'query') config.vision_config = null;
const model = await AutoModel.from_pretrained(id, { config, device: 'webgpu',
    dtype: { model: 'q4', vision_encoder: 'q4' }, revision });
processor.image_processor.max_soft_tokens = cfg.imageTokenBudget;
// 批量：processor(null, imgs.map(i => [i]))   // 平铺列表会被当成一个样本 [P0 §3]
```

环境配置（worker 内，见 [P0 §7、§8]）：

```ts
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = fsCache;       // match: 读 fs → new Response(buf)；put: 写 .tmp 再 rename
env.backends.onnx.wasm.wasmPaths = { mjs: <local url>, wasm: <local url> };
```

- `fsCache` 目录结构镜像 URL（`<modelDir>/huggingface.co/onnx-community/.../onnx/model_q4.onnx_data`），与 P0 一致。
- 主线程到 worker 的协议：`{id, type:'init'|'embedText'|'embedImages'|'dispose', payload}` → `{id, ok, result|error}`；图片以 `ArrayBuffer` transfer 传入。
- 若未来 Obsidian 去掉 `nodeIntegrationInWorker`，退回"主线程代理 fs"方案 [P0 §7]，接口不变。

### 4.4 VectorStore（P2）

```ts
export interface VectorStore {
    open(scopeId: string, expectedHeader: IndexHeader): Promise<void>; // header 不符 → 清空重建
    get(key: string): { fp: string; vec: Float32Array; missingSince?: number } | undefined;
    upsert(key: string, fp: string, vec: Float32Array): void;
    markMissing(key: string, now: number): void;        // 软删除（tombstone）
    restore(key: string): void;
    remove(key: string): void;                          // 立即清除
    visibleKeys(): Set<string>;                         // 不含 tombstone
    search(q: Float32Array, k: number, allow: Set<string>): { key: string; score: number }[];
    flush(): Promise<void>;                             // 原子写 meta
    compactIfNeeded(): Promise<void>;
}
```

- `search` 为暴力点积（向量已归一化）。1 万张 × 256 维 ≈ 10 MB，主线程可接受；若超 5 万张再移入 worker（见 §10）。
- `allow` = 当前内存中的远程对象 key 集合（§7.6）。

### 4.5 SemanticIndexService（P3）

插件级单例（在 `main.ts` 中创建，生命周期随插件），**按 scope 隔离**，不属于某个 `OssGalleryView`（因为 `SyncService` 目前由每个 view 实例各自 `initializeServices()` 创建）。

```ts
export interface IndexScope { id: string; providerId: string; listPrefix: string; }

export class SemanticIndexService {
    beginListing(scope: IndexScope): number;                          // 返回单调递增 token
    reconcile(token: number, scope: IndexScope, r: ListResult): void; // 见 §7；过期 token 直接丢弃
    onUploaded(scope: IndexScope, obj: OssImage, bytes: ArrayBuffer): void;
    onDeleted(scope: IndexScope, key: string): void;
    estimate(scope: IndexScope): { pendingCount: number; pendingBytes: number; indexedCount: number };
    start(scope): void; pause(): void; cancel(): void;               // provider 切换时 cancel
    onProgress(cb: (p: { done: number; total: number; state: 'idle'|'running'|'paused' }) => void): () => void;
}
```

- 内部为串行低优先级队列，批大小 8；暂停/取消可中断。
- **取字节**：Local 用 `fs` 读取（需把 `LocalProvider.resolveWithinStorage` 由 private 暴露为 `readBytes(key)` 之类的公共方法，保持路径越界检查）；远程用 `fetch(obj.url)`；上传用手头 `File`。
- 变更检测：复用 `SyncService` 的 diff 语义，但 `detectChanges` 目前是 private 且只比较 `lastModified`。索引侧以 `fingerprint()` 为准自行比较（`VectorStore.get(key).fp !== fingerprint(obj)`），不依赖 view 的 `SyncChanges`。

### 4.6 Scope id

```ts
scopeId = sha256(JSON.stringify({ providerId, identity, listPrefix })).slice(0, 16)
```

`identity` 为 provider 配置中决定"桶/仓库/目录"的字段：bucket、endpoint、region、repo+branch、Local 的 `storagePath`、path 等。凭证（key/secret/token）**不得**参与哈希。建议在 `ProviderRegistryEntry`（`src/providers/registry.ts`）新增可选 `getIndexIdentity?(settings): object`，registry 仍是 provider 元数据的唯一来源；缺省则 `semantic` 能力视为不可用。同时 `ProviderCapabilities` 不新增字段：是否可建索引 = `capabilities.list`。

### 4.7 SemanticSearchService

```ts
export class SemanticSearchService {
    searchByText(scope, q: string, remote: OssImage[], k?: number): Promise<OssImage[]>;
    searchSimilar(scope, key: string, remote: OssImage[], k?: number): OssImage[];  // 用已存向量，无需 worker
}
```

`SearchService.search(objects, text, useRegex)`（`src/services/SearchService.ts`）保持不变；语义模式由 `OssGalleryView.handleSearch` 分派到 `SemanticSearchService`，返回的 `OssImage[]` 按 score 降序，不再按 `lastModified` 排序。

## 5. 数据格式

目录：`<vault>/.obsidian/plugins/oss-gallery/semantic-index/<scopeId>/`

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
    "2025/10/a.png": { "fp": "e:\"abc\"", "slot": 17 },
    "2025/10/b.png": { "fp": "s:48213:1760000000000", "slot": 18,
                        "missingSince": 1760100000000, "missCount": 1 }
  },
  "freeSlots": [3, 9]                // 空洞（已 remove 的槽位）
}
```

### vectors.bin

- 无头部；第 `i` 个槽位位于字节偏移 `i * 1024`，内容为 256 个 little-endian float32。
- **只追加**：新向量写在文件末尾（或复用 `freeSlots`）；已存在的槽位不原地改写，更新 = 追加新槽位 + 旧槽位入 `freeSlots`。
- `meta.json` 是提交点：先 append vectors.bin 并 fsync，再原子写 meta。启动时若文件长度 > `slotCount*1024`，截断多余尾部。

### 约束

- header 任一字段与当前配置不同 → 整个 scope 作废并重建（含修改 token budget）。
- **原子写**：写 `meta.json.tmp` 再 `rename`；compaction 写 `vectors.bin.tmp` + `meta.json.tmp`，先 rename vectors 再 rename meta（崩溃后靠 header 校验与长度检查兜底，最坏重建）。
- **Compaction**：`freeSlots.length / slotCount > 0.3` 时触发，在空闲时执行。
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
| 插件内删除（`SyncService.deleteObject` 成功后） | `onDeleted` → `VectorStore.remove` 立即清除，不走 tombstone |
| 插件内上传成功 | `onUploaded` → 用手头 `File` 字节入队 add，零额外流量 |
| 外部变更（别的客户端、手动删除等） | 只能通过完整列表对账（§7.2–7.5）发现，不做猜测 |

### 7.2 完整性门槛

`reconcile(token, scope, { items, complete })`：

- `complete === false`：**只处理新增与修改**（入队 embed），**不处理任何删除**，也不推进 tombstone 计数。
- 仅对"在本次 `listPrefix` 之下"的已索引 key 做对账；prefix 之外的条目（例如用户改过 base path 前遗留的）保持原样，不被视为删除。

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
- `reconcile` 时若 `token < lastAppliedToken(scope)` 直接丢弃，避免较慢的旧列表覆盖较新的对账结果；
- provider 切换（`updateProvider` 中 `providerSwitched`）时 `cancel()` 当前队列，并使旧 scope 的所有 token 失效。

挂接点：`OssGalleryView.loadGallery` 在 `syncService.sync()` 前后调用 `beginListing` / `reconcile`（仅在 `isCurrentLoad(generation)` 通过之后，与现有逻辑同位）；自动同步路径（约第 454 行附近的 `beginLoad` 分支）同理。

### 7.5 Fingerprint 规则

etag（含 GitHub sha）> `size + lastModified`。变化即重新 embed。注意现有 `SyncService.detectChanges` 的 modified 判定只看 `lastModified`，所以索引侧不要依赖它。

### 7.6 渲染前交集

任何语义结果在渲染前，与当前内存中的 `state.remoteObjects` 的 key 集合取交集（`VectorStore.search(..., allow)`），保证即便索引滞后也不展示已不在图库中的图片。

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
- P1 实现：worker 还需 `target: es2022`、`legalComments: none`，以及把 `node:*` 导入替换为空模块的插件（同 P0 `build.js`）。onnxruntime-web 是 transformers.js 的传递依赖，构建脚本通过 transformers.js 的 `require.resolve('onnxruntime-web/webgpu')` 定位其 `dist/` 并复制 `ort-wasm-simd-threaded.asyncify.{wasm,mjs}`。`release.yml` 上传并 attest 这三个文件。P1 的 worker 是 stub（只答 `ping`），但已 import 将用到的类，体积（546 KB）与最终版相当。
- 依赖：`@huggingface/transformers` 精确锁定 `4.3.1`（其依赖 `onnxruntime-web 1.31.0-dev.20260914-8d85527a0`）；`pnpm-workspace.yaml` 将 `onnxruntime-node`、`protobufjs` 列为 `ignoredBuiltDependencies`（Node 端原生包，插件用不到）。
- 实测 main.js：196,413 → 238,723 字节（+42 KB，全部是 P1 自身代码与三份 locale 字符串，无 transformers.js）。
- 注意：现有配置 `external` 含 `...builtinModules`，所以主线程使用 `fs`/`path`/`crypto` 无需额外处理；worker 端是 browser 平台，`require('fs')` 通过 `(0, eval)('require')` 取得 [P0 §7]。
- ORT 的 mjs 需应用与 transformers.js 相同的补丁 `code.replaceAll('globalThis.process?.versions?.node','false')`，仅在走"binary 模式"时需要；默认走 `wasmPaths` URL 模式（由 transformers.js 处理）[P0 §8]。

### 8.6 下载镜像（P1 已实现）

实现：`src/semantic/mirrors.ts`，设置 `semantic.hfEndpoint` / `semantic.githubMirror`（默认 `''` = 官方）。

- **HF 端点**：替换 `https://huggingface.co`，URL = `<hfEndpoint>/<repo>/resolve/<revision>/<file>`。例：`https://hf-mirror.com`（与官方同布局；2026-10-15 实测：从非中国大陆网络访问时 hf-mirror.com 以 308 跳回 huggingface.co，下载内容 SHA-256 一致；国内直连行为未在本机验证）。
- **GitHub 镜像**："代理前缀"式，URL = `<githubMirror>/<完整 GitHub URL>`，如 `https://gh-proxy.com/https://github.com/stmoonar/oss-gallery-plugin-obsidian/releases/download/<version>/<file>`（2026-10-15 实测 gh-proxy.com 直接返回 200，哈希一致）。
- **校验**：`normalizeMirrorUrl` 只接受 `https://`（`http://` → `not-https`，其余无法解析、含账号密码、查询串或 fragment → `invalid`），去掉末尾 `/`。设置页非法值行内报错且不保存；`loadStoredSettings` 遇非法值回退 `''`。
- **安全性**：镜像只改变字节来源，每个文件仍按清单 SHA-256 + 大小校验，镜像无法改变安装内容；确认对话框显示实际连接的主机。重定向仍只允许 https。
- **不影响已安装文件**：本地路径与哈希不依赖镜像，修改镜像不触发重新检查或下载；正在进行的下载继续使用开始时的 URL。
- 离线替代：手动按 §8.2 第 3 条的布局放入文件后点"校验"/"下载"。开发时可用 `pnpm run dev:install -- --vault <path>` 把 `dist/` 的 runtime 直接放入 `<modelDir>/runtime/<version>/`（并写入安装记录），未发布的 Release URL 不会被访问。

## 9. UI

### 9.1 SearchComponent

`src/components/SearchComponent.ts` 现有正则按钮（`regexBtn`，`onToggleRegex`）。仿照新增"语义"按钮：

- `SearchComponentOptions` 增加 `onToggleSemantic?: (enabled: boolean) => void`；组件内 `useSemantic` 与 `setSemanticEnabled / isSemanticEnabled`。
- 语义与正则互斥：开其一自动关另一。
- 仅当 `semantic.enabled && 当前 provider 有索引 scope` 时显示按钮；未索引完成时 tooltip 提示"索引进行中，结果可能不完整"。
- `GalleryState`（`src/types/gallery.ts`）增加 `useSemanticSearch: boolean`。

### 9.2 其它 UI

- 图片右键菜单增加"找相似图片"，结果展示同语义搜索，并在搜索框区域显示"相似于 xxx"，可一键退出。
- 图库顶部显示索引进度条（`done/total`，暂停/继续/取消）。
- 设置页新增"语义搜索"区块：WebGPU 检测状态、启用/下载、删除模型、存储路径、token budget（修改时提示将全量重建）、自动索引开关、当前 scope 的索引统计。
- 所有新增字符串同步更新 `src/locale/en.ts`、`src/locale/zh-cn.ts`、`src/locale/zh-tw.ts`；README（`README.md`、`README-zh.md`）说明功能、WebGPU 要求、下载来源、**写入 vault 之外目录**以及流量。

### 9.3 设置模型

在 `PluginSettings` 新增（全局，不放入 `providers`）：

```ts
semantic: {
    enabled: boolean;
    modelDir: string;           // '' = 平台默认
    imageTokenBudget: 70 | 140 | 280;
    autoIndex: boolean;
    hfEndpoint: string;         // '' = https://huggingface.co；否则为规范化的 https URL（§8.6）
    githubMirror: string;       // '' = 官方；否则为代理前缀 <githubMirror>/https://github.com/...（§8.6）
}
```

P1 默认值：`{ enabled: false, modelDir: '', imageTokenBudget: 70, autoIndex: false, hfEndpoint: '', githubMirror: '' }`；`loadStoredSettings` 对缺失/非法字段逐项回退默认值（镜像 URL 经 `normalizeMirrorUrl` 规范化，非法则回退 `''`）。`enabled` 只由"下载并全部校验通过"或"开关打开时完整校验通过"置为 true；校验失败、删除模型、`modelDir` 改到未安装的目录都会置回 false。

### 9.4 流量提示对话框

远程 provider 首次（或增量较大时）建索引前：

- 估算 = 所有未索引对象的 `size` 之和；Local 为 0（直接读盘），不弹框。
- 显示形如："N 张 / X GB / M 张已有索引"，确认后才开始。`autoIndex` 开启后仅在估算超过阈值（默认 200 MB）时再次确认。
- 后续若支持 provider 端缩略图，改显示"最多 X GB"。

## 10. 实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 已完成。Spike：模型、延迟、内存、缓存、Blob worker [P0] | RESULTS.md |
| P1 | 下载管理器 + 设置页：WebGPU 检测、opt-in 对话框、SHA-256 校验、fs 存储、进度、删除模型；esbuild 第二入口；Release 资产与清单生成 | 断网/中断/篡改文件均能正确失败与恢复；`pnpm run lint` 通过 |
| P2 | worker 与 `EmbeddingBackend` 接口、`fsCache`、`VectorStore`（格式、原子写、compaction） | 单元测试：崩溃恢复、header 不符重建；本地能嵌入并检索 |
| P3 | `SemanticIndexService`、对账协议、`listImages` → `ListResult`、`etag`、挂接 `OssGalleryView`/上传/删除 | 模拟截断列表不删向量；删除后立即不可见；过期 token 被丢弃 |
| P4 | UI：语义开关、"找相似图片"、流量对话框、进度、i18n（en/zh-cn/zh-tw）、README | 手工在 Local 与一个 S3 兼容 provider 上端到端验证 |

本机无 GPU（项目约定）：涉及 WebGPU 的代码先本地做可跑通的部分（下载、存储、VectorStore、协议，可用假 `EmbeddingBackend`），真实推理到有 GPU 的机器上验证。

## 11. 风险与未决问题

1. **社区审核立场**：Obsidian 社区插件审核对"运行时下载并执行代码"（worker bundle + wasm）的态度未知。缓解：SHA-256 硬编码、opt-in、来源为本项目自己的 Release；最坏退路是仅作为 BRAT/手动安装特性。需在 P1 前确认或提前沟通。
2. **真实图库检索质量**：P0 仅 6 张样例，结果 6/6 top-1 但样本偏容易 [P0 §6]。需用真实图库（截图、文档、照片混合，中英文查询）评估，决定 token budget 默认值是否仍为 70。
3. **iGPU 内存压力**：iGPU 共享系统内存；GPU 进程批量时达 2.4 GB（无批量 1.08 GB），渲染进程约 1.1 GB [P0 §5]。低内存机器可能卡顿。缓解：索引结束即回收 worker；可选降低批大小；设置页给出内存提示。
4. **模型文件布局变化**：`onnx-community` 仓库可能调整文件结构。缓解：URL 固定 revision（commit hash），清单中记录。
5. **`minAppVersion` 与 WebGPU**：manifest 为 `1.7.2`，P0 只在 Obsidian 1.14.4（Electron 39.6.0）验证。旧版 Electron 的 WebGPU 支持不一致，由 `WebGpuProbe` 兜底；是否提高 `minAppVersion` 待定（默认不提高，探测失败即不可用）。
6. **插件目录同步冲突**：多设备通过 Obsidian Sync/iCloud 同步 `semantic-index/` 时，`meta.json` 与 `vectors.bin` 可能出现不一致版本。header + 长度校验可兜底为"重建"，但是否需要 per-device 子目录待定。
7. **暴力检索规模**：当前设计在主线程暴力点积，约 5 万张以内可接受；更大规模需移入 worker 或分块。
8. **跨 vault 共享模型目录**：P1 已加下载锁（§8.2 第 7 条）；删除只删清单与记录中的文件（§8.2 第 5 条），但仍会影响共享该目录的其他 vault（对话框已提示）。删除与另一 vault 的下载之间未加锁。
9. **`listImages` 返回类型变更**是破坏性内部变更，需一次改完 10 个 provider 并更新相关测试。
10. 不再需要：向上游提交 patched `GatherBlockQuantized` 图（无 CPU 路径，此项不适用）。
11. **代理 / 镜像**（P1 新发现）：Node `https` 不走系统代理，Hugging Face / GitHub 在部分地区不可直连或很慢。
    - [x] 可配置镜像：`hfEndpoint`（如 hf-mirror.com）与 `githubMirror`（代理前缀），已在 P1 实现（§8.6）。
    - [ ] **未决**：系统代理 / 自定义代理 agent 仍不支持（`https.get` 不读取系统或 Electron 代理设置）。可考虑读取 `session.resolveProxy` 或允许配置 `https://` / SOCKS 代理。

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
