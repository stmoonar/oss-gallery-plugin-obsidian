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
	/** 0-100, rounded. */
	percent: number;
	status: UploadStatus;
	/** Failure reason shown on a failed card (already filtered for secrets). */
	error?: string;
	/** True while a card action (e.g. saving to the vault) is running. */
	busy?: boolean;
	/** Object URL of the local file, only for images. Revoked on removal. */
	previewUrl?: string;
}

export type UploadEntryPatch = Partial<Pick<UploadEntry, "percent" | "status" | "error" | "busy">>;

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
			percent: 0,
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
