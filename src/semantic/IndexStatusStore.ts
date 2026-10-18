/**
 * Per-scope index status sidecar (status.json next to meta.json).
 *
 * Only objects that are not plainly "ok" are recorded:
 * - converted: indexed after a conversion (SVG rasterized, TIFF decoded);
 * - unsupported: the format cannot be indexed (HEIC, PSD, RAW, unknown
 *   bytes); not retried until the object's fingerprint changes;
 * - failed: download/decode/inference error; retried with backoff up to
 *   MAX_ATTEMPTS, then left alone until the fingerprint changes.
 * Plus `confirmedAt`: when the user last agreed to download this scope's
 * images (traffic confirmation, docs/semantic-search.md §9.4), and
 * `inflight`: keys of the batch being indexed, written before the batch
 * starts. Keys still listed there on the next open were being indexed when
 * the app closed or crashed (poison image, OOM); the index service counts
 * that as a failed attempt (takeInterrupted).
 *
 * The file is small and rewritten atomically (tmp + rename) after a debounce.
 */
import * as nodeFs from "fs";
import * as path from "path";
import type { Timers } from "./WorkerEmbeddingBackend";

export const STATUS_FILE = "status.json";
const STATUS_FORMAT = 1;

export type IndexEntryStatus = "ok" | "converted" | "unsupported" | "failed";

export interface StatusEntry {
	/** Fingerprint the status applies to; a changed object is tried again. */
	fp: string;
	status: Exclude<IndexEntryStatus, "ok">;
	/** Detected source format (svg, tiff, heic...). */
	format?: string;
	reason?: string;
	/** failed: attempts so far. */
	attempts?: number;
	/** failed: not retried before this time (ms). */
	nextRetryAt?: number;
	/** When the status was recorded (ms). */
	at: number;
	/** failed: the worker crashed / hung / the app died with it in the batch; retried alone. */
	crashed?: boolean;
}

export interface InFlightEntry {
	fp: string;
	at: number;
}

interface StatusFile {
	format: number;
	confirmedAt?: number;
	entries: Record<string, StatusEntry>;
	inflight?: Record<string, InFlightEntry>;
}

export interface StatusFs {
	existsSync(p: string): boolean;
	mkdirSync(p: string, options: { recursive: true }): unknown;
	readFileSync(p: string): Buffer;
	writeFileSync(p: string, data: string): void;
	renameSync(from: string, to: string): void;
}

export interface IndexStatusStoreOptions {
	fs?: StatusFs;
	timers?: Timers;
	/** 0 = write only on flush()/close(). */
	flushDelayMs?: number;
}

function isStatusEntry(v: unknown): v is StatusEntry {
	if (typeof v !== "object" || v === null) {
		return false;
	}
	const r = v as Record<string, unknown>;
	return typeof r.fp === "string"
		&& (r.status === "converted" || r.status === "unsupported" || r.status === "failed")
		&& typeof r.at === "number";
}

export class IndexStatusStore {
	private readonly entries = new Map<string, StatusEntry>();
	private readonly inflight = new Map<string, InFlightEntry>();
	/** In-flight markers found on open (a previous session died mid-batch). */
	private interrupted = new Map<string, InFlightEntry>();
	private confirmed: number | undefined;
	private dirty = false;
	private timer: number | null = null;
	private readonly fs: StatusFs;
	private readonly file: string;

	private constructor(readonly dir: string, private readonly options: IndexStatusStoreOptions) {
		this.fs = options.fs ?? nodeFs;
		this.file = path.join(dir, STATUS_FILE);
	}

	/** Open (never throws for bad data: an unreadable file starts empty). */
	static open(dir: string, options: IndexStatusStoreOptions = {}): IndexStatusStore {
		const store = new IndexStatusStore(dir, options);
		store.load();
		return store;
	}

	private load(): void {
		if (!this.fs.existsSync(this.file)) {
			return;
		}
		try {
			const parsed = JSON.parse(this.fs.readFileSync(this.file).toString("utf8")) as Partial<StatusFile>;
			if (parsed?.format !== STATUS_FORMAT || typeof parsed.entries !== "object" || parsed.entries === null) {
				return;
			}
			if (typeof parsed.confirmedAt === "number") {
				this.confirmed = parsed.confirmedAt;
			}
			for (const [key, entry] of Object.entries(parsed.entries)) {
				if (isStatusEntry(entry)) {
					this.entries.set(key, entry);
				}
			}
			if (typeof parsed.inflight === "object" && parsed.inflight !== null) {
				for (const [key, e] of Object.entries(parsed.inflight)) {
					if (typeof e?.fp === "string" && typeof e.at === "number") {
						this.interrupted.set(key, { fp: e.fp, at: e.at });
					}
				}
			}
		} catch {
			// Corrupt sidecar: statuses are only hints, start over.
		}
	}

	get(key: string): StatusEntry | undefined {
		return this.entries.get(key);
	}

	set(key: string, entry: StatusEntry): void {
		this.entries.set(key, entry);
		this.changed();
	}

	delete(key: string): void {
		if (this.entries.delete(key)) {
			this.changed();
		}
	}

	keys(): string[] {
		return [...this.entries.keys()];
	}

	all(): Array<[string, StatusEntry]> {
		return [...this.entries.entries()];
	}

	/** After an index reset: vectors are gone, so only "unsupported" stays meaningful. */
	dropEmbeddingResults(): void {
		for (const [key, e] of this.entries) {
			if (e.status !== "unsupported") {
				this.entries.delete(key);
				this.dirty = true;
			}
		}
		if (this.dirty) {
			this.changed();
		}
	}

	/**
	 * Mark keys as being indexed and write the file now, so a crash of the
	 * whole app during the batch is remembered (see takeInterrupted).
	 */
	markInFlight(entries: Array<[string, string]>, now: number): void {
		for (const [key, fp] of entries) {
			this.inflight.set(key, { fp, at: now });
		}
		this.dirty = true;
		this.flush();
	}

	/** The key's batch item was handled (or put back): no longer in flight. */
	clearInFlight(key: string): void {
		if (this.inflight.delete(key)) {
			this.changed();
		}
	}

	inFlightKeys(): string[] {
		return [...this.inflight.keys()];
	}

	/** In-flight markers left by a previous session (returned once). */
	takeInterrupted(): Array<[string, InFlightEntry]> {
		const out = [...this.interrupted.entries()];
		if (out.length > 0) {
			this.interrupted = new Map();
			this.changed();
		}
		return out;
	}

	get confirmedAt(): number | undefined {
		return this.confirmed;
	}

	setConfirmed(now: number): void {
		this.confirmed = now;
		this.changed();
	}

	private changed(): void {
		this.dirty = true;
		const delay = this.options.flushDelayMs ?? 2000;
		if (delay <= 0 || this.timer !== null) {
			return;
		}
		const timers = this.options.timers ?? {
			setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
			clearTimeout: (id: number) => window.clearTimeout(id),
		};
		this.timer = timers.setTimeout(() => {
			this.timer = null;
			try {
				this.flush();
			} catch (error) {
				console.error("OSS Gallery: semantic index status write failed", error);
			}
		}, delay);
	}

	flush(): void {
		if (this.timer !== null) {
			const timers = this.options.timers;
			if (timers) {
				timers.clearTimeout(this.timer);
			} else {
				window.clearTimeout(this.timer);
			}
			this.timer = null;
		}
		if (!this.dirty) {
			return;
		}
		const data: StatusFile = { format: STATUS_FORMAT, entries: Object.fromEntries(this.entries) };
		if (this.inflight.size > 0 || this.interrupted.size > 0) {
			// Markers not taken yet stay on disk until the service handles them.
			data.inflight = { ...Object.fromEntries(this.interrupted), ...Object.fromEntries(this.inflight) };
		}
		if (this.confirmed !== undefined) {
			data.confirmedAt = this.confirmed;
		}
		this.fs.mkdirSync(this.dir, { recursive: true });
		const tmp = `${this.file}.tmp`;
		this.fs.writeFileSync(tmp, JSON.stringify(data));
		this.fs.renameSync(tmp, this.file);
		this.dirty = false;
	}

	close(): void {
		this.flush();
	}
}
