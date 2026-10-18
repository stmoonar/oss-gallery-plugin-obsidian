/**
 * Downloads, verifies and deletes the semantic search runtime + model files
 * (docs/semantic-search.md §8.2).
 *
 * - Each file streams into `<name>.part`, is hashed while downloading, and is
 *   renamed into place only when size and SHA-256 match. Up to 3 retries.
 * - Resume is per file: files already present with a matching hash are kept,
 *   including files copied in by hand (offline install).
 * - The startup/status check only compares presence and size; `verify()`
 *   rehashes everything.
 * - Deleting removes only files this plugin knows about (the manifests and
 *   the install record), never the whole directory: it may be shared.
 *
 * Free of Obsidian imports so it can be exercised from plain Node.
 */
import * as fs from "fs";
import * as path from "path";
import type { AssetEntry } from "./assets";
import {
	DownloadError,
	hashFile,
	httpsDownload,
	HttpsDownloadOptions,
	HttpsDownloadResult,
} from "./httpsDownload";
import type { ResolvedModelDir } from "./modelDir";
import type { WebGpuProbeResult } from "./webGpuProbe";

export type InstallState =
	| { kind: "checking" }
	/** WebGPU probe failed. `filesPresent` still lets the user delete old files. */
	| { kind: "unsupported"; probe: Extract<WebGpuProbeResult, { ok: false }>; filesPresent: boolean }
	| { kind: "invalid-dir" }
	/**
	 * No model file on disk (runtime files alone don't count). `remaining` are
	 * the manifest files still to download; `hasFiles` is true when anything of
	 * ours (runtime files, a `.part`, the install record) can be deleted.
	 */
	| { kind: "not-installed"; remaining: string[]; hasFiles: boolean }
	/** Some files present, but a full install never verified (e.g. interrupted download). */
	| { kind: "incomplete"; remaining: string[] }
	/** Fully installed before; files are now missing, truncated or failed verification. */
	| { kind: "needs-repair"; missing: string[]; mismatched: string[] }
	| {
		kind: "downloading";
		bytesDone: number;
		bytesTotal: number;
		currentFile: string;
		fileIndex: number;
		fileCount: number;
	}
	| { kind: "verifying"; bytesDone: number; bytesTotal: number; currentFile: string }
	| { kind: "deleting" }
	| { kind: "installed" };

export type OperationResult =
	| { ok: true }
	| { ok: false; cancelled: boolean; error?: DownloadError };

export interface VerifyResult {
	ok: boolean;
	missing: string[];
	mismatched: string[];
	cancelled?: boolean;
}

export interface DeleteResult {
	removedFiles: number;
	failed: string[];
}

export type Downloader = (
	url: string,
	destPath: string,
	options: HttpsDownloadOptions
) => Promise<HttpsDownloadResult>;

export interface ModelDownloadManagerOptions {
	/** Current manifests (runtime for this plugin version + model). */
	getAssets: () => AssetEntry[];
	getModelDir: () => ResolvedModelDir;
	probe: () => Promise<WebGpuProbeResult>;
	downloader?: Downloader;
	maxRetries?: number;
	retryDelayMs?: number;
	/** A lock untouched for this long is considered abandoned. */
	staleLockMs?: number;
}

/** Records every file we installed, across plugin versions and vaults. */
export const INSTALL_RECORD_FILE = ".oss-gallery-files.json";
/** Held while a download runs so two vaults don't write the same `.part`. */
export const LOCK_FILE = ".oss-gallery-download.lock";
const PART_SUFFIX = ".part";
const LOCK_HEARTBEAT_MS = 30_000;

type Listener = (state: InstallState) => void;

/** Is there anything of ours on disk that "Delete model" would remove? */
export function stateHasFiles(state: InstallState): boolean {
	switch (state.kind) {
		case "not-installed":
			return state.hasFiles;
		case "incomplete":
		case "needs-repair":
		case "installed":
			return true;
		case "unsupported":
			return state.filesPresent;
		default:
			return false;
	}
}

/** Manifest files a download from this state would fetch (empty when unknown). */
export function remainingFiles(state: InstallState): string[] {
	switch (state.kind) {
		case "not-installed":
		case "incomplete":
			return state.remaining;
		case "needs-repair":
			return [...state.missing, ...state.mismatched];
		default:
			return [];
	}
}

interface InstallRecord {
	files: string[];
	/** ISO time of the first full verified install; absent when never completed. */
	completedAt?: string;
}

function isBusy(state: InstallState): boolean {
	return state.kind === "downloading" || state.kind === "verifying" || state.kind === "deleting";
}

/** Relative "/"-separated path inside the model dir, or null when unsafe. */
function safeRelativePath(name: string): string | null {
	if (typeof name !== "string" || name === "" || name.includes("\\") || name.includes("\0")) {
		return null;
	}
	if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
		return null;
	}
	const parts = name.split("/");
	if (parts.some((p) => p === "" || p === "." || p === "..")) {
		return null;
	}
	return name;
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function statSize(file: string): Promise<number | null> {
	try {
		const st = await fs.promises.stat(file);
		return st.isFile() ? st.size : null;
	} catch {
		return null;
	}
}

async function unlinkIfExists(file: string): Promise<boolean> {
	try {
		await fs.promises.unlink(file);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return false;
		}
		throw error;
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = window.setTimeout(done, ms);
		function done(): void {
			window.clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done);
	});
}

export class ModelDownloadManager {
	private state: InstallState = { kind: "checking" };
	private readonly listeners = new Set<Listener>();
	private abortController: AbortController | null = null;
	private lastError: DownloadError | null = null;
	private readonly downloader: Downloader;
	private readonly maxRetries: number;
	private readonly retryDelayMs: number;
	private readonly staleLockMs: number;

	constructor(private readonly options: ModelDownloadManagerOptions) {
		this.downloader = options.downloader ?? httpsDownload;
		this.maxRetries = options.maxRetries ?? 3;
		this.retryDelayMs = options.retryDelayMs ?? 1000;
		this.staleLockMs = options.staleLockMs ?? 2 * 60_000;
	}

	getState(): InstallState {
		return this.state;
	}

	/** The error of the last failed download, cleared when a new one starts. */
	getLastError(): DownloadError | null {
		return this.lastError;
	}

	isBusy(): boolean {
		return isBusy(this.state);
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private setState(state: InstallState): void {
		this.state = state;
		for (const listener of this.listeners) {
			try {
				listener(state);
			} catch (error) {
				console.error("OSS Gallery: semantic state listener failed", error);
			}
		}
	}

	private resolveDir(): string | null {
		const resolved = this.options.getModelDir();
		return resolved.ok ? resolved.dir : null;
	}

	private localPath(dir: string, name: string): string {
		return path.join(dir, ...name.split("/"));
	}

	/**
	 * Probe + cheap presence/size check. Does nothing while an operation runs
	 * (its own state is more accurate).
	 */
	async refresh(): Promise<InstallState> {
		if (this.isBusy()) {
			return this.state;
		}
		const probe = await this.options.probe();
		const files = await this.quickCheck();
		// An operation may have started while we were checking.
		if (this.isBusy()) {
			return this.state;
		}
		this.setState(probe.ok ? files : this.unsupported(probe, files));
		return this.state;
	}

	private unsupported(
		probe: Extract<WebGpuProbeResult, { ok: false }>,
		files: InstallState
	): InstallState {
		return {
			kind: "unsupported",
			probe,
			filesPresent: stateHasFiles(files),
		};
	}

	/** Leave an operation: back to the probe + presence/size state. */
	private async settle(): Promise<void> {
		const probe = await this.options.probe();
		const files = await this.quickCheck();
		this.setState(probe.ok ? files : this.unsupported(probe, files));
	}

	private async quickCheck(): Promise<InstallState> {
		const dir = this.resolveDir();
		if (!dir) {
			return { kind: "invalid-dir" };
		}
		const missing: string[] = [];
		const mismatched: string[] = [];
		for (const asset of this.options.getAssets()) {
			const size = await statSize(this.localPath(dir, asset.name));
			if (size === null) {
				missing.push(asset.name);
			} else if (size !== asset.size) {
				mismatched.push(asset.name);
			}
		}
		return this.classify(dir, missing, mismatched);
	}

	/**
	 * Turn the presence/size (or hash) findings into one of the user-facing
	 * states (docs/semantic-search.md §8.2):
	 * - nothing wrong -> installed;
	 * - no model file and no `.part` -> not-installed (runtime files alone
	 *   don't count);
	 * - installed once before and no interrupted download -> needs-repair;
	 * - otherwise -> incomplete (never finished, or a `.part` is left over).
	 */
	private async classify(dir: string, missing: string[], mismatched: string[]): Promise<InstallState> {
		if (missing.length === 0 && mismatched.length === 0) {
			return { kind: "installed" };
		}
		const assets = this.options.getAssets();
		const absent = new Set(missing);
		const present = assets.filter((a) => !absent.has(a.name));
		let hasPart = false;
		for (const asset of assets) {
			if ((await statSize(this.localPath(dir, asset.name) + PART_SUFFIX)) !== null) {
				hasPart = true;
				break;
			}
		}
		const hasModelFile = present.some((a) => a.source === "huggingface");
		if (!hasModelFile && !hasPart) {
			const hasRecord = (await statSize(path.join(dir, INSTALL_RECORD_FILE))) !== null;
			return {
				kind: "not-installed",
				remaining: [...missing, ...mismatched],
				hasFiles: present.length > 0 || hasRecord,
			};
		}
		const record = await this.readInstallRecord(dir);
		if (record.completedAt !== undefined && !hasPart) {
			return { kind: "needs-repair", missing, mismatched };
		}
		return { kind: "incomplete", remaining: [...missing, ...mismatched] };
	}

	cancel(): void {
		this.abortController?.abort();
	}

	/**
	 * Download every file that is not already present and verified. Resolves
	 * with `{ ok: true }` only when all files are installed and hashed.
	 */
	async download(): Promise<OperationResult> {
		if (this.isBusy()) {
			return { ok: false, cancelled: false, error: new DownloadError("locked", "Another operation is running") };
		}
		const dir = this.resolveDir();
		if (!dir) {
			this.setState({ kind: "invalid-dir" });
			return { ok: false, cancelled: false, error: new DownloadError("fs", "Invalid model directory") };
		}
		const probe = await this.options.probe();
		if (!probe.ok) {
			this.setState(this.unsupported(probe, await this.quickCheck()));
			return { ok: false, cancelled: false };
		}

		const assets = this.options.getAssets();
		const controller = new AbortController();
		this.abortController = controller;
		this.lastError = null;
		const bytesTotal = assets.reduce((sum, a) => sum + a.size, 0);
		let bytesDone = 0;
		const progress = (fileIndex: number, currentFile: string): void => {
			this.setState({
				kind: "downloading",
				bytesDone,
				bytesTotal,
				currentFile,
				fileIndex,
				fileCount: assets.length,
			});
		};
		progress(0, assets[0]?.name ?? "");

		let releaseLock: (() => Promise<void>) | null = null;
		try {
			await fs.promises.mkdir(dir, { recursive: true });
			releaseLock = await this.acquireLock(dir);

			for (let i = 0; i < assets.length; i++) {
				const asset = assets[i];
				progress(i, asset.name);
				const target = this.localPath(dir, asset.name);

				if (await this.isVerified(target, asset, controller.signal)) {
					bytesDone += asset.size;
					await this.recordInstalled(dir, asset.name);
					continue;
				}

				const fileStart = bytesDone;
				await this.downloadWithRetries(asset, target, controller.signal, (n) => {
					bytesDone += n;
					progress(i, asset.name);
				}, () => {
					bytesDone = fileStart;
				});
				bytesDone = fileStart + asset.size;
				await this.recordInstalled(dir, asset.name);
			}

			progress(assets.length - 1, "");
			await this.markCompleted(dir);
			this.abortController = null;
			this.setState({ kind: "installed" });
			return { ok: true };
		} catch (error) {
			const cancelled = controller.signal.aborted;
			const err = error instanceof DownloadError
				? error
				: new DownloadError(cancelled ? "cancelled" : "fs", error instanceof Error ? error.message : String(error));
			this.lastError = cancelled ? null : err;
			this.abortController = null;
			await this.settle();
			return { ok: false, cancelled, error: cancelled ? undefined : err };
		} finally {
			if (releaseLock) {
				await releaseLock();
			}
		}
	}

	/** Existing file with the right size and hash? Removes it when wrong. */
	private async isVerified(target: string, asset: AssetEntry, signal: AbortSignal): Promise<boolean> {
		const size = await statSize(target);
		if (size === null) {
			return false;
		}
		if (size === asset.size && (await hashFile(target, signal)) === asset.sha256) {
			return true;
		}
		if (signal.aborted) {
			throw new DownloadError("cancelled", "Download cancelled");
		}
		await unlinkIfExists(target);
		return false;
	}

	private async downloadWithRetries(
		asset: AssetEntry,
		target: string,
		signal: AbortSignal,
		onBytes: (n: number) => void,
		onRestart: () => void
	): Promise<void> {
		const part = target + PART_SUFFIX;
		await fs.promises.mkdir(path.dirname(target), { recursive: true });

		for (let attempt = 0; ; attempt++) {
			try {
				const result = await this.downloader(asset.url, part, {
					signal,
					expectedSize: asset.size,
					onBytes,
				});
				if (result.size !== asset.size) {
					throw new DownloadError("size-mismatch", `${asset.name}: got ${result.size} bytes, expected ${asset.size}`);
				}
				if (result.sha256 !== asset.sha256) {
					throw new DownloadError("hash-mismatch", `${asset.name}: SHA-256 mismatch`);
				}
				// Belt and braces: what reached the disk is what we hashed.
				if ((await statSize(part)) !== asset.size) {
					throw new DownloadError("size-mismatch", `${asset.name}: size on disk differs`);
				}
				await fs.promises.rename(part, target);
				return;
			} catch (error) {
				await unlinkIfExists(part).catch(() => undefined);
				const err = error instanceof DownloadError
					? error
					: new DownloadError("fs", error instanceof Error ? error.message : String(error));
				if (signal.aborted) {
					throw new DownloadError("cancelled", "Download cancelled");
				}
				if (!err.retryable || attempt >= this.maxRetries) {
					throw err;
				}
				onRestart();
				await sleep(this.retryDelayMs * 2 ** attempt, signal);
				if (signal.aborted) {
					throw new DownloadError("cancelled", "Download cancelled");
				}
			}
		}
	}

	/**
	 * Exclusive lock file with a heartbeat. A lock older than `staleLockMs`
	 * (crashed Obsidian) is taken over.
	 */
	private async acquireLock(dir: string): Promise<() => Promise<void>> {
		const lockPath = path.join(dir, LOCK_FILE);
		const content = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
		try {
			await fs.promises.writeFile(lockPath, content, { flag: "wx" });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				throw error;
			}
			const st = await fs.promises.stat(lockPath).catch(() => null);
			if (st && Date.now() - st.mtimeMs < this.staleLockMs) {
				throw new DownloadError("locked", "Another download into this directory is in progress");
			}
			await fs.promises.writeFile(lockPath, content);
		}
		const heartbeat = window.setInterval(() => {
			const now = new Date();
			fs.promises.utimes(lockPath, now, now).catch(() => undefined);
		}, LOCK_HEARTBEAT_MS);
		return async () => {
			window.clearInterval(heartbeat);
			await unlinkIfExists(lockPath).catch(() => undefined);
		};
	}

	private async readInstallRecord(dir: string): Promise<InstallRecord> {
		try {
			const raw = await fs.promises.readFile(path.join(dir, INSTALL_RECORD_FILE), "utf8");
			const parsed = JSON.parse(raw) as { files?: unknown; completedAt?: unknown } | null;
			const files = Array.isArray(parsed?.files)
				? parsed.files.filter((f): f is string => typeof f === "string" && safeRelativePath(f) !== null)
				: [];
			const completedAt = typeof parsed?.completedAt === "string" && parsed.completedAt !== ""
				? parsed.completedAt
				: undefined;
			return { files, completedAt };
		} catch {
			return { files: [] };
		}
	}

	private async writeInstallRecord(dir: string, record: InstallRecord): Promise<void> {
		const recordPath = path.join(dir, INSTALL_RECORD_FILE);
		const tmp = recordPath + ".tmp";
		await fs.promises.writeFile(tmp, JSON.stringify({ format: 1, ...record }, null, "	"));
		await fs.promises.rename(tmp, recordPath);
	}

	private async recordInstalled(dir: string, name: string): Promise<void> {
		const record = await this.readInstallRecord(dir);
		if (record.files.includes(name)) {
			return;
		}
		await this.writeInstallRecord(dir, { ...record, files: [...record.files, name] });
	}

	/**
	 * Remember that a full install verified successfully, so a later missing
	 * or damaged file is reported as "needs repair" instead of "incomplete".
	 */
	private async markCompleted(dir: string): Promise<void> {
		const record = await this.readInstallRecord(dir);
		if (record.completedAt === undefined) {
			await this.writeInstallRecord(dir, { ...record, completedAt: new Date().toISOString() });
		}
	}

	/** Full SHA-256 check of every file. */
	async verify(): Promise<VerifyResult> {
		if (this.isBusy()) {
			return { ok: false, missing: [], mismatched: [], cancelled: true };
		}
		const dir = this.resolveDir();
		if (!dir) {
			this.setState({ kind: "invalid-dir" });
			return { ok: false, missing: [], mismatched: [] };
		}
		const assets = this.options.getAssets();
		const controller = new AbortController();
		this.abortController = controller;
		const bytesTotal = assets.reduce((sum, a) => sum + a.size, 0);
		let bytesDone = 0;
		const missing: string[] = [];
		const mismatched: string[] = [];
		try {
			for (const asset of assets) {
				this.setState({ kind: "verifying", bytesDone, bytesTotal, currentFile: asset.name });
				const target = this.localPath(dir, asset.name);
				const size = await statSize(target);
				if (size === null) {
					missing.push(asset.name);
				} else if (size !== asset.size) {
					mismatched.push(asset.name);
				} else {
					const digest = await hashFile(target, controller.signal, (n) => {
						bytesDone += n;
						this.setState({ kind: "verifying", bytesDone, bytesTotal, currentFile: asset.name });
					});
					if (digest !== asset.sha256) {
						mismatched.push(asset.name);
					} else {
						await this.recordInstalled(dir, asset.name);
					}
					continue;
				}
				bytesDone += asset.size;
			}
		} catch (error) {
			this.abortController = null;
			await this.settle();
			if (controller.signal.aborted) {
				return { ok: false, missing, mismatched, cancelled: true };
			}
			throw error;
		}
		this.abortController = null;
		const ok = missing.length === 0 && mismatched.length === 0;
		if (ok) {
			await this.markCompleted(dir);
			this.setState({ kind: "installed" });
		} else {
			this.setState(await this.classify(dir, missing, mismatched));
		}
		return { ok, missing, mismatched };
	}

	/**
	 * Remove the files listed in the manifests and in the install record
	 * (plus their `.part` files, the record and the lock), then any
	 * subdirectories that became empty. Other files are never touched.
	 */
	async deleteFiles(): Promise<DeleteResult> {
		if (this.isBusy()) {
			return { removedFiles: 0, failed: [] };
		}
		const resolved = this.options.getModelDir();
		if (!resolved.ok) {
			this.setState({ kind: "invalid-dir" });
			return { removedFiles: 0, failed: [] };
		}
		const dir = resolved.dir;
		this.setState({ kind: "deleting" });

		const names = new Set<string>();
		for (const asset of this.options.getAssets()) {
			names.add(asset.name);
		}
		for (const name of (await this.readInstallRecord(dir)).files) {
			names.add(name);
		}

		let removedFiles = 0;
		const failed: string[] = [];
		const dirs = new Set<string>();
		const remove = async (file: string, label: string): Promise<void> => {
			try {
				if (await unlinkIfExists(file)) {
					removedFiles++;
				}
			} catch {
				failed.push(label);
			}
		};

		for (const name of names) {
			if (safeRelativePath(name) === null) {
				continue;
			}
			const target = this.localPath(dir, name);
			// Defense in depth: never leave the model directory.
			const rel = path.relative(dir, target);
			if (rel.startsWith("..") || path.isAbsolute(rel)) {
				continue;
			}
			await remove(target, name);
			await remove(target + PART_SUFFIX, name + PART_SUFFIX);
			const parts = name.split("/");
			for (let i = parts.length - 1; i > 0; i--) {
				dirs.add(parts.slice(0, i).join("/"));
			}
		}
		await remove(path.join(dir, INSTALL_RECORD_FILE), INSTALL_RECORD_FILE);
		await remove(path.join(dir, INSTALL_RECORD_FILE + ".tmp"), INSTALL_RECORD_FILE + ".tmp");
		await remove(path.join(dir, LOCK_FILE), LOCK_FILE);

		// Deepest first; rmdir only succeeds on empty directories.
		const ordered = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length);
		for (const rel of ordered) {
			await fs.promises.rmdir(this.localPath(dir, rel)).catch(() => undefined);
		}
		// The default location is ours; a user-chosen directory is left in place.
		if (resolved.isDefault) {
			await fs.promises.rmdir(dir).catch(() => undefined);
			await fs.promises.rmdir(path.dirname(dir)).catch(() => undefined);
		}

		this.lastError = null;
		await this.settle();
		return { removedFiles, failed };
	}
}
