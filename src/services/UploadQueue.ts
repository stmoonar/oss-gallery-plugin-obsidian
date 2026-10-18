import { nextUploadPercent, UploadAction, UploadProgressStore } from "./UploadProgressStore";

/**
 * Upload queue behind the progress cards. No Obsidian imports: everything
 * that touches notes, the provider or notices goes through `UploadQueueHost`,
 * so the state machine can be unit tested.
 *
 * Lifecycle of a job (one placeholder in one note):
 *   queued -> uploading -> done (placeholder replaced, job released)
 *                       -> failed (placeholder and file kept; Retry puts it
 *                          back in the queue, Save to vault / Remove release it)
 *   queued | uploading -> cancelled (placeholder removed, job released)
 *
 * The File is only referenced while the job exists, so a failed upload keeps
 * its bytes in memory exactly as long as its card can still act on them.
 */

/** Thrown into a running upload when the user cancels it. */
export class UploadCancelledError extends Error {
	constructor() {
		super("Upload cancelled");
		this.name = "UploadCancelledError";
	}
}

export function isUploadCancelled(error: unknown): boolean {
	return error instanceof UploadCancelledError;
}

/**
 * Settle with `promise`, or reject with UploadCancelledError as soon as
 * `signal` aborts. Providers upload through Obsidian's requestUrl, which
 * cannot be aborted: the request may still finish in the background, its
 * result is discarded.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		// Keep a late rejection of the abandoned request from going unhandled.
		promise.catch(() => undefined);
		return Promise.reject(new UploadCancelledError());
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new UploadCancelledError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		);
	});
}

export interface UploadResult {
	/** Public URL of the uploaded object (offered for copying if the placeholder is gone). */
	url: string;
	/** Text that replaces the placeholder. */
	text: string;
}

export interface SavedToVault {
	/** Link text that replaces the placeholder. */
	text: string;
	/** Vault path of the new attachment. */
	path: string;
}

export interface UploadQueueHost<T> {
	/** Upload the file; report progress as 0-100. */
	upload(file: File, onProgress: (percent: number) => void, signal: AbortSignal): Promise<UploadResult>;
	/** Replace the job's placeholder in its note. False when it is gone. */
	replacePlaceholder(target: T, id: string, text: string): Promise<boolean>;
	/**
	 * Same, but synchronous where possible (open editors) and best effort
	 * otherwise; used on unload, when nothing can be awaited.
	 */
	replacePlaceholderNow(target: T, id: string, text: string): void;
	/** Save the file as a vault attachment next to the target note. */
	saveToVault(target: T, file: File): Promise<SavedToVault>;
	/** Text left in the note for a job still pending when the plugin unloads. */
	interruptedText(name: string): string;
	/** Short, secret-free reason for a failed card. */
	describeError(error: unknown): string;

	onUploaded?(name: string): void;
	onFailed?(name: string, message: string, error: unknown): void;
	/** Upload finished but its placeholder had been removed from the note. */
	onPlaceholderLost?(name: string, url: string): void;
	/** A running upload was cancelled (the request may still finish remotely). */
	onCancelled?(name: string): void;
	onSavedToVault?(name: string, path: string, placed: boolean): void;
	onSaveToVaultFailed?(name: string, message: string, error: unknown): void;
}

type JobState =
	| "queued"
	| "uploading"
	| "failed"
	/** Placeholder being replaced; no more actions accepted. */
	| "closing";

interface UploadJob<T> {
	id: string;
	file: File;
	target: T;
	state: JobState;
	controller: AbortController | null;
}

export interface UploadQueueOptions {
	/** Uploads running at the same time (1 keeps GitHub commits from racing). */
	concurrency?: number;
}

export class UploadQueue<T> {
	private readonly jobs = new Map<string, UploadJob<T>>();
	private readonly waiting: string[] = [];
	private running = 0;
	private disposed = false;
	private readonly concurrency: number;

	constructor(
		private readonly store: UploadProgressStore,
		private readonly host: UploadQueueHost<T>,
		options: UploadQueueOptions = {}
	) {
		this.concurrency = Math.max(1, options.concurrency ?? 1);
		store.setActionHandler((id, action) => this.handleAction(id, action));
	}

	/**
	 * Register a job and its progress entry. Call before the placeholder is
	 * written so the first render already shows the card, then `enqueue`.
	 */
	add(id: string, file: File, target: T): void {
		if (this.disposed) return;
		this.jobs.set(id, { id, file, target, state: "queued", controller: null });
		this.store.start(id, file);
	}

	/** Start (or queue) the given jobs in order. */
	enqueue(ids: string[]): void {
		for (const id of ids) {
			const job = this.jobs.get(id);
			if (job && job.state === "queued" && !this.waiting.includes(id)) {
				this.waiting.push(id);
			}
		}
		this.pump();
	}

	has(id: string): boolean {
		return this.jobs.has(id);
	}

	/** Failed jobs (their files are still held in memory). */
	failedJobs(): Array<{ id: string; target: T }> {
		return Array.from(this.jobs.values())
			.filter((job) => job.state === "failed")
			.map(({ id, target }) => ({ id, target }));
	}

	/**
	 * Forget a failed job whose placeholder the user deleted, so its file
	 * does not stay in memory. Its card is gone with the placeholder.
	 */
	releaseFailed(id: string): void {
		const job = this.jobs.get(id);
		if (job?.state === "failed" && !this.store.get(id)?.busy) this.release(id);
	}

	handleAction(id: string, action: UploadAction): void {
		const job = this.jobs.get(id);
		if (!job || this.disposed) return;
		switch (action) {
			case "cancel":
				void this.cancel(job);
				break;
			case "retry":
				this.retry(job);
				break;
			case "save-local":
				void this.saveToVault(job);
				break;
			case "dismiss":
				void this.dismiss(job);
				break;
		}
	}

	/**
	 * Plugin unload: stop waiting for uploads and leave a readable note in
	 * place of every placeholder that can no longer finish (the progress
	 * card cannot render without this session's state).
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.store.setActionHandler(null);
		this.waiting.length = 0;
		for (const job of Array.from(this.jobs.values())) {
			job.controller?.abort();
			if (job.state === "closing") continue;
			try {
				this.host.replacePlaceholderNow(job.target, job.id, this.host.interruptedText(job.file.name));
			} catch (error) {
				console.error("OSS Gallery: could not mark an unfinished upload", error);
			}
		}
		this.jobs.clear();
	}

	private pump(): void {
		while (!this.disposed && this.running < this.concurrency && this.waiting.length > 0) {
			const id = this.waiting.shift();
			const job = id ? this.jobs.get(id) : undefined;
			if (!job || job.state !== "queued") continue;
			this.running++;
			void this.run(job).finally(() => {
				this.running--;
				this.pump();
			});
		}
	}

	private async run(job: UploadJob<T>): Promise<void> {
		const controller = new AbortController();
		job.controller = controller;
		job.state = "uploading";
		this.store.update(job.id, { status: "uploading", percent: null, error: undefined });

		let result: UploadResult;
		try {
			result = await raceAbort(
				this.host.upload(
					job.file,
					(percent) => {
						if (controller.signal.aborted) return;
						const current = this.store.get(job.id)?.percent ?? null;
						this.store.update(job.id, { percent: nextUploadPercent(current, percent) });
					},
					controller.signal
				),
				controller.signal
			);
		} catch (error) {
			job.controller = null;
			// Cancelled: cancel() removes the placeholder and releases the job.
			if (this.disposed || isUploadCancelled(error)) return;
			const message = this.host.describeError(error);
			job.state = "failed";
			this.store.update(job.id, { status: "failed", error: message, busy: false });
			this.host.onFailed?.(job.file.name, message, error);
			return;
		}

		job.controller = null;
		if (this.disposed) return;
		job.state = "closing";
		this.store.update(job.id, { percent: 100, status: "done" });
		this.host.onUploaded?.(job.file.name);
		let placed = false;
		try {
			placed = await this.host.replacePlaceholder(job.target, job.id, result.text);
		} finally {
			this.release(job.id);
		}
		if (!placed) this.host.onPlaceholderLost?.(job.file.name, result.url);
	}

	private async cancel(job: UploadJob<T>): Promise<void> {
		if (job.state !== "queued" && job.state !== "uploading") return;
		const wasRunning = job.state === "uploading";
		job.state = "closing";
		const index = this.waiting.indexOf(job.id);
		if (index !== -1) this.waiting.splice(index, 1);
		job.controller?.abort();
		await this.removePlaceholderAndRelease(job);
		if (wasRunning) this.host.onCancelled?.(job.file.name);
	}

	private retry(job: UploadJob<T>): void {
		if (job.state !== "failed" || this.store.get(job.id)?.busy) return;
		job.state = "queued";
		this.store.update(job.id, { status: "queued", percent: null, error: undefined, busy: false });
		this.enqueue([job.id]);
	}

	private async saveToVault(job: UploadJob<T>): Promise<void> {
		if (job.state !== "failed" || this.store.get(job.id)?.busy) return;
		this.store.update(job.id, { busy: true });
		let saved: SavedToVault;
		try {
			saved = await this.host.saveToVault(job.target, job.file);
		} catch (error) {
			this.store.update(job.id, { busy: false });
			this.host.onSaveToVaultFailed?.(job.file.name, this.host.describeError(error), error);
			return;
		}
		// Unloaded while saving: the attachment exists, but the placeholder
		// was already marked as interrupted.
		if (this.jobs.get(job.id) !== job) return;
		job.state = "closing";
		let placed = false;
		try {
			placed = await this.host.replacePlaceholder(job.target, job.id, saved.text);
		} finally {
			this.release(job.id);
		}
		this.host.onSavedToVault?.(job.file.name, saved.path, placed);
	}

	private async dismiss(job: UploadJob<T>): Promise<void> {
		if (job.state !== "failed" || this.store.get(job.id)?.busy) return;
		job.state = "closing";
		await this.removePlaceholderAndRelease(job);
	}

	/** Remove the placeholder first so the card never flashes back to plain text. */
	private async removePlaceholderAndRelease(job: UploadJob<T>): Promise<void> {
		try {
			await this.host.replacePlaceholder(job.target, job.id, "");
		} finally {
			this.release(job.id);
		}
	}

	private release(id: string): void {
		this.jobs.delete(id);
		// Also revokes the thumbnail object URL.
		this.store.remove(id);
	}
}
