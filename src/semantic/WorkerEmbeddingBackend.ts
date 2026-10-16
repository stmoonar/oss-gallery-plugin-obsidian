/**
 * Main-thread host of a semantic worker (docs/semantic-search.md §4.3).
 *
 * One instance = one mode (`query` or `index`) = at most one live worker.
 * - Before every worker start the runtime files are re-hashed and the exact
 *   verified bytes are used: the worker script through a Blob URL, the ORT
 *   wasm/mjs through the init message (binary mode, no URLs).
 * - Requests are serialized: one in flight per worker.
 * - The worker is terminated after `idleTimeoutMs` without requests and
 *   restarted transparently on the next request.
 * - D13: a worker is never asked to dispose and reload; recycling = terminate.
 *   Terminating rejects the in-flight and queued requests ("terminated").
 */
import type { Timers } from "../utils/timers";
import type { BackendInitInfo, EmbeddingBackend } from "./EmbeddingBackend";
import {
	EmbeddingConfig,
	EmbeddingError,
	EmbeddingMode,
	EmbedImagesResult,
	EmbedTextResult,
	ImageEmbedding,
	ImageInput,
	InitPayload,
	InitResult,
	isWorkerResponse,
	PingResult,
	PROTOCOL_VERSION,
	WorkerRequestType,
	WorkerResultMap,
} from "./protocol";
import { loadVerifiedRuntime, VerifiedRuntime } from "./runtimeFiles";

/** The query worker stays warm for searches; the index worker is one-shot. */
export const QUERY_IDLE_TIMEOUT_MS = 5 * 60_000;
export const INDEX_IDLE_TIMEOUT_MS = 30_000;

/**
 * Watchdog per request: a worker that does not answer in time (hung GPU
 * driver, decoder stuck on a poison image) is terminated and the request
 * rejects with "worker-crashed". Generous on purpose; 0 disables a limit.
 */
export interface RequestTimeouts {
	/** init: runtime already verified; model load + WebGPU session setup. */
	initMs: number;
	/** embedText and ping. */
	textMs: number;
	/** embedImages: base + perImageMs × images. */
	imageBaseMs: number;
	imagePerItemMs: number;
}

export const DEFAULT_REQUEST_TIMEOUTS: Readonly<RequestTimeouts> = {
	initMs: 10 * 60_000,
	textMs: 2 * 60_000,
	imageBaseMs: 2 * 60_000,
	imagePerItemMs: 30_000,
};

export interface WorkerLike {
	postMessage(message: unknown, transfer: Transferable[]): void;
	terminate(): void;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: { message?: string }) => void) | null;
}

export type { Timers };

export interface WorkerEmbeddingBackendOptions {
	modelDir: string;
	pluginVersion: string;
	/** 0 disables the idle timeout. Default depends on the mode. */
	idleTimeoutMs?: number;
	/** Verified runtime for a start; default re-hashes files in modelDir. */
	loadRuntime?: (mode: EmbeddingMode) => Promise<VerifiedRuntime>;
	/** Starts a worker from the verified script; default uses a Blob URL. */
	createWorker?: (script: ArrayBuffer) => WorkerLike;
	timers?: Timers;
	/** Called after a worker was terminated (idle, crash, dispose, explicit). */
	onTerminated?: (reason: TerminateReason) => void;
	/** Per-request watchdog limits (default DEFAULT_REQUEST_TIMEOUTS). */
	requestTimeouts?: Partial<RequestTimeouts>;
}

export type TerminateReason = "idle" | "dispose" | "crash" | "init-failed" | "recycle" | "timeout";

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	/** Watchdog timer of this request. */
	timer: number | null;
}

const windowTimers: Timers = {
	setTimeout: (fn, ms) => window.setTimeout(fn, ms),
	clearTimeout: (id) => window.clearTimeout(id),
};

/** Blob URL worker (D14). The URL is revoked once the worker has loaded it. */
export function createBlobWorker(script: ArrayBuffer): WorkerLike {
	const url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
	try {
		const worker = new Worker(url);
		const terminate = worker.terminate.bind(worker);
		let revoked = false;
		const revoke = (): void => {
			if (!revoked) {
				revoked = true;
				URL.revokeObjectURL(url);
			}
		};
		// The script is fetched asynchronously; revoke after the first message
		// (the worker is running by then) or on terminate.
		worker.addEventListener("message", revoke, { once: true });
		worker.terminate = () => {
			revoke();
			terminate();
		};
		return worker;
	} catch (error) {
		URL.revokeObjectURL(url);
		throw error;
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export class WorkerEmbeddingBackend implements EmbeddingBackend {
	private mode: EmbeddingMode | null = null;
	private cfg: EmbeddingConfig | null = null;
	private worker: WorkerLike | null = null;
	private starting: Promise<BackendInitInfo> | null = null;
	private lastInit: BackendInitInfo | null = null;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	/** Serializes requests; one in flight at a time. */
	private queue: Promise<unknown> = Promise.resolve();
	/** Incremented on every terminate; queued jobs from an older epoch are cancelled. */
	private epoch = 0;
	private active = 0;
	private idleTimer: number | null = null;
	private disposed = false;
	private readonly timers: Timers;

	constructor(private readonly options: WorkerEmbeddingBackendOptions) {
		this.timers = options.timers ?? windowTimers;
	}

	/** Is a worker process currently alive? */
	isRunning(): boolean {
		return this.worker !== null;
	}

	getMode(): EmbeddingMode | null {
		return this.mode;
	}

	/** Info of the most recent successful worker start. */
	getLastInit(): BackendInitInfo | null {
		return this.lastInit;
	}

	private idleTimeoutMs(): number {
		if (this.options.idleTimeoutMs !== undefined) {
			return this.options.idleTimeoutMs;
		}
		return this.mode === "index" ? INDEX_IDLE_TIMEOUT_MS : QUERY_IDLE_TIMEOUT_MS;
	}

	async init(mode: EmbeddingMode, cfg: EmbeddingConfig): Promise<BackendInitInfo> {
		if (this.disposed) {
			throw new EmbeddingError("terminated", "Backend disposed");
		}
		if (this.mode !== null && this.mode !== mode) {
			throw new EmbeddingError("already-initialized", `Backend is a ${this.mode} backend`);
		}
		this.mode = mode;
		this.cfg = cfg;
		return this.enqueue(() => this.ensureStarted());
	}

	embedText(queries: string[]): Promise<Float32Array[]> {
		return this.request("embedText", { queries }, []).then((r: EmbedTextResult) => r.vectors);
	}

	/**
	 * The `bytes` buffers are transferred to the worker and become detached
	 * (zero-length) in the caller.
	 */
	embedImages(images: ImageInput[]): Promise<ImageEmbedding[]> {
		return this.embedImagesDetailed(images).then((r) => r.items);
	}

	/** Like embedImages, plus worker-side timing and batch count. */
	embedImagesDetailed(images: ImageInput[]): Promise<EmbedImagesResult> {
		const transfer = images.map((i) => i.bytes);
		return this.request("embedImages", { images }, transfer);
	}

	embedTextDetailed(queries: string[]): Promise<EmbedTextResult> {
		return this.request("embedText", { queries }, []);
	}

	ping(): Promise<PingResult> {
		return this.request("ping", undefined, []);
	}

	/** Terminate the worker now (D13 recycle). The next request starts a new one. */
	recycle(): void {
		this.terminate("recycle");
	}

	dispose(): Promise<void> {
		this.disposed = true;
		this.terminate("dispose");
		return Promise.resolve();
	}

	private request<T extends Exclude<WorkerRequestType, "init">>(
		type: T,
		payload: unknown,
		transfer: Transferable[]
	): Promise<WorkerResultMap[T]> {
		if (this.disposed) {
			return Promise.reject(new EmbeddingError("terminated", "Backend disposed"));
		}
		if (!this.mode || !this.cfg) {
			return Promise.reject(new EmbeddingError("not-initialized", "Call init() first"));
		}
		return this.enqueue(async () => {
			await this.ensureStarted();
			return (await this.send(type, payload, transfer)) as WorkerResultMap[T];
		});
	}

	/** Run `job` after every earlier request; cancelled if a terminate happens first. */
	private enqueue<R>(job: () => Promise<R>): Promise<R> {
		const epoch = this.epoch;
		this.active++;
		this.clearIdle();
		const run = async (): Promise<R> => {
			if (this.disposed) {
				throw new EmbeddingError("terminated", "Backend disposed");
			}
			if (epoch !== this.epoch) {
				throw new EmbeddingError("terminated", "Worker terminated before the request ran");
			}
			return job();
		};
		const result = this.queue.then(run, run);
		this.queue = result.then(
			() => undefined,
			() => undefined
		);
		return result.finally(() => {
			this.active--;
			if (this.active === 0) {
				this.armIdle();
			}
		});
	}

	private clearIdle(): void {
		if (this.idleTimer !== null) {
			this.timers.clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	private armIdle(): void {
		this.clearIdle();
		const ms = this.idleTimeoutMs();
		if (ms > 0 && this.worker && !this.disposed) {
			this.idleTimer = this.timers.setTimeout(() => {
				this.idleTimer = null;
				if (this.active === 0) {
					this.terminate("idle");
				}
			}, ms);
		}
	}

	private ensureStarted(): Promise<BackendInitInfo> {
		if (this.worker && this.lastInit && !this.starting) {
			return Promise.resolve(this.lastInit);
		}
		if (!this.starting) {
			const starting = this.start().finally(() => {
				if (this.starting === starting) {
					this.starting = null;
				}
			});
			this.starting = starting;
		}
		return this.starting;
	}

	private async start(): Promise<BackendInitInfo> {
		const mode = this.mode;
		const cfg = this.cfg;
		if (!mode || !cfg) {
			throw new EmbeddingError("not-initialized", "Call init() first");
		}
		const epoch = this.epoch;
		let runtime: VerifiedRuntime;
		try {
			runtime = await (this.options.loadRuntime
				? this.options.loadRuntime(mode)
				: loadVerifiedRuntime(this.options.modelDir, this.options.pluginVersion, mode));
		} catch (error) {
			if (error instanceof EmbeddingError) {
				throw error;
			}
			throw new EmbeddingError("runtime-verify", asError(error).message);
		}
		if (epoch !== this.epoch || this.disposed) {
			throw new EmbeddingError("terminated", "Worker terminated during start");
		}

		const create = this.options.createWorker ?? createBlobWorker;
		const worker = create(runtime.workerScript);
		this.worker = worker;
		worker.onmessage = (event) => this.onMessage(event.data);
		worker.onerror = (event) => {
			const message = event?.message || "Worker error";
			this.terminate("crash", new EmbeddingError("worker-crashed", message));
		};

		const payload: InitPayload = {
			protocol: PROTOCOL_VERSION,
			mode,
			config: cfg,
			modelDir: this.options.modelDir,
			files: runtime.modelFiles,
			wasmBinary: runtime.wasmBinary,
			wasmFactory: runtime.wasmFactory,
		};
		let result: InitResult;
		try {
			result = (await this.send("init", payload, [runtime.wasmBinary])) as InitResult;
		} catch (error) {
			if (this.worker === worker) {
				this.terminate("init-failed");
			}
			throw error;
		}
		this.lastInit = {
			mode,
			sessions: result.sessions,
			loadMs: result.loadMs,
			verifyMs: runtime.verifyMs,
		};
		return this.lastInit;
	}

	/** Watchdog limit for one request (0 = none). */
	private timeoutFor(type: WorkerRequestType, payload: unknown): number {
		const t = { ...DEFAULT_REQUEST_TIMEOUTS, ...this.options.requestTimeouts };
		switch (type) {
			case "init":
				return t.initMs;
			case "embedImages": {
				const images = (payload as { images?: unknown[] } | undefined)?.images;
				const count = Array.isArray(images) ? images.length : 1;
				return t.imageBaseMs > 0 ? t.imageBaseMs + t.imagePerItemMs * count : 0;
			}
			default:
				return t.textMs;
		}
	}

	private send(type: WorkerRequestType, payload: unknown, transfer: Transferable[]): Promise<unknown> {
		const worker = this.worker;
		if (!worker) {
			return Promise.reject(new EmbeddingError("terminated", "Worker is not running"));
		}
		const id = this.nextId++;
		const limitMs = this.timeoutFor(type, payload);
		return new Promise((resolve, reject) => {
			const entry: Pending = { resolve, reject, timer: null };
			this.pending.set(id, entry);
			try {
				worker.postMessage({ id, type, payload }, transfer);
			} catch (error) {
				this.pending.delete(id);
				reject(new EmbeddingError("bad-request", asError(error).message));
				return;
			}
			if (limitMs > 0) {
				entry.timer = this.timers.setTimeout(() => {
					entry.timer = null;
					if (this.pending.get(id) === entry && this.worker === worker) {
						// Hung or stuck: the worker is not reusable (D13).
						this.terminate("timeout", new EmbeddingError(
							"worker-crashed",
							`The worker did not answer within ${Math.round(limitMs / 1000)} s (${type}); it was stopped`
						));
					}
				}, limitMs);
			}
		});
	}

	private clearWatchdog(entry: Pending): void {
		if (entry.timer !== null) {
			this.timers.clearTimeout(entry.timer);
			entry.timer = null;
		}
	}

	private onMessage(data: unknown): void {
		if (!isWorkerResponse(data)) {
			return;
		}
		const pending = this.pending.get(data.id);
		if (!pending) {
			return;
		}
		this.pending.delete(data.id);
		this.clearWatchdog(pending);
		if (data.ok) {
			pending.resolve(data.result);
		} else {
			pending.reject(new EmbeddingError(data.error.code, data.error.message));
		}
	}

	private terminate(reason: TerminateReason, error?: EmbeddingError): void {
		this.epoch++;
		this.clearIdle();
		const worker = this.worker;
		this.worker = null;
		this.lastInit = reason === "dispose" ? null : this.lastInit;
		if (worker) {
			worker.onmessage = null;
			worker.onerror = null;
			worker.terminate();
		}
		const failure = error ?? new EmbeddingError("terminated", `Worker terminated (${reason})`);
		for (const p of this.pending.values()) {
			this.clearWatchdog(p);
			p.reject(failure);
		}
		this.pending.clear();
		if (worker) {
			this.options.onTerminated?.(reason);
		}
	}
}
