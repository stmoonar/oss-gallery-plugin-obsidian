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
 * images (traffic confirmation, docs/semantic-search.md §9.4).
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
}

interface StatusFile {
	format: number;
	confirmedAt?: number;
	entries: Record<string, StatusEntry>;
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
