/**
 * - queued: waiting for its turn in the upload queue
 * - uploading: transfer in progress
 * - done: uploaded, the placeholder is about to be replaced
 * - failed: kept in the note with Retry / Save to vault / Remove
 */
export type UploadStatus = "queued" | "uploading" | "done" | "failed";

/** Buttons on an upload card. */
export type UploadAction = "cancel" | "retry" | "save-local" | "dismiss";

export interface UploadEntry {
	id: string;
	name: string;
	mime: string;
	/**
	 * 0-100, rounded, only once the provider reported real transfer progress.
	 * null: no progress known (requestUrl cannot report any), so the card
	 * shows an indeterminate bar instead of a percentage that never moves.
	 */
	percent: number | null;
	status: UploadStatus;
	/** Failure reason shown on a failed card (already filtered for secrets). */
	error?: string;
	/** True while a card action (e.g. saving to the vault) is running. */
	busy?: boolean;
	/** Object URL of the local file, only for images. Revoked on removal. */
	previewUrl?: string;
}

export type UploadEntryPatch = Partial<Pick<UploadEntry, "percent" | "status" | "error" | "busy">>;

/**
 * Percent to show after the provider reported `reported` (0-100).
 * While nothing real is known (`current` null), 0 and 100 carry no
 * information: providers report them around a request that cannot report
 * progress, and the card status already says started / finished. The first
 * value strictly in between switches the card to a determinate bar.
 */
export function nextUploadPercent(current: number | null, reported: number): number | null {
	if (!Number.isFinite(reported)) return current;
	const value = Math.min(100, Math.max(0, Math.round(reported)));
	if (current === null && (value <= 0 || value >= 100)) return null;
	return value;
}

/** Called with the id of the entry that changed (or was removed). */
export type UploadProgressListener = (id: string) => void;

export type UploadActionHandler = (id: string, action: UploadAction) => void;

/**
 * In-memory upload progress shared by the editor extension and the reading
 * mode post processor. Nothing in here is ever written to a note.
 */
export class UploadProgressStore {
	private readonly entries = new Map<string, UploadEntry>();
	private readonly listeners = new Set<UploadProgressListener>();
	private actionHandler: UploadActionHandler | null = null;

	get(id: string): UploadEntry | undefined {
		return this.entries.get(id);
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	/** Register an entry; it starts as "queued" until its upload begins. */
	start(id: string, file: File): void {
		const mime = file.type;
		this.entries.set(id, {
			id,
			name: file.name,
			mime,
			percent: null,
			status: "queued",
			previewUrl: mime.startsWith("image/") ? URL.createObjectURL(file) : undefined,
		});
		this.notify(id);
	}

	update(id: string, patch: UploadEntryPatch): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		const next = { ...entry, ...patch };
		if (
			next.percent === entry.percent &&
			next.status === entry.status &&
			next.error === entry.error &&
			next.busy === entry.busy
		) {
			return;
		}
		this.entries.set(id, next);
		this.notify(id);
	}

	remove(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.entries.delete(id);
		if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
		this.notify(id);
	}

	/** Drop every entry (plugin unload). */
	clear(): void {
		for (const id of Array.from(this.entries.keys())) {
			this.remove(id);
		}
	}

	subscribe(listener: UploadProgressListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Where card buttons are routed (the upload queue). */
	setActionHandler(handler: UploadActionHandler | null): void {
		this.actionHandler = handler;
	}

	/** Called by a card button. Ignored for unknown ids. */
	requestAction(id: string, action: UploadAction): void {
		if (!this.entries.has(id)) return;
		this.actionHandler?.(id, action);
	}

	private notify(id: string): void {
		for (const listener of Array.from(this.listeners)) {
			try {
				listener(id);
			} catch (error) {
				console.error("OSS Gallery: upload progress listener failed", error);
			}
		}
	}
}
