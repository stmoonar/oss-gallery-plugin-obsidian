export type UploadStatus = "uploading" | "done" | "failed";

export interface UploadEntry {
	id: string;
	name: string;
	mime: string;
	/** 0-100, rounded. */
	percent: number;
	status: UploadStatus;
	/** Object URL of the local file, only for images. Revoked on removal. */
	previewUrl?: string;
}

/** Called with the id of the entry that changed (or was removed). */
export type UploadProgressListener = (id: string) => void;

/**
 * In-memory upload progress shared by the editor extension and the reading
 * mode post processor. Nothing in here is ever written to a note.
 */
export class UploadProgressStore {
	private readonly entries = new Map<string, UploadEntry>();
	private readonly listeners = new Set<UploadProgressListener>();

	get(id: string): UploadEntry | undefined {
		return this.entries.get(id);
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	start(id: string, file: File): void {
		const mime = file.type;
		this.entries.set(id, {
			id,
			name: file.name,
			mime,
			percent: 0,
			status: "uploading",
			previewUrl: mime.startsWith("image/") ? URL.createObjectURL(file) : undefined,
		});
		this.notify(id);
	}

	update(id: string, patch: Partial<Pick<UploadEntry, "percent" | "status">>): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		const next = { ...entry, ...patch };
		if (next.percent === entry.percent && next.status === entry.status) return;
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
