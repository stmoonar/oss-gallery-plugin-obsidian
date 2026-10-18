import { describe, expect, it } from "vitest";
import {
	raceAbort,
	UploadCancelledError,
	UploadQueue,
	UploadQueueHost,
	UploadResult,
} from "../../src/services/UploadQueue";
import { UploadProgressStore } from "../../src/services/UploadProgressStore";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let pending promise chains settle (no timers needed). */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A note as a string: `target` is just a label here. */
function createHarness() {
	let note = "";
	const uploads: Array<{ file: File; result: Deferred<UploadResult>; signal: AbortSignal; progress(p: number): void }> = [];
	const events: string[] = [];

	const replace = (id: string, text: string): boolean => {
		const pattern = new RegExp(`\\[[^\\]\\n]*\\]\\(#${id}\\)\\n?`);
		if (!pattern.test(note)) return false;
		note = note.replace(pattern, () => text);
		return true;
	};

	const host: UploadQueueHost<string> = {
		upload: (file, onProgress, signal) => {
			const result = deferred<UploadResult>();
			uploads.push({ file, result, signal, progress: onProgress });
			return result.promise;
		},
		replacePlaceholder: (_target, id, text) => Promise.resolve(replace(id, text)),
		replacePlaceholderNow: (_target, id, text) => {
			const pattern = new RegExp(`\\[[^\\]\\n]*\\]\\(#${id}\\)`);
			note = note.replace(pattern, () => text);
		},
		saveToVault: (_target, file) =>
			Promise.resolve({ text: `![[${file.name}]]\n`, path: `attachments/${file.name}` }),
		interruptedText: (name) => `(Upload of ${name} did not finish)`,
		describeError: (error) => (error instanceof Error ? error.message : String(error)),
		onUploaded: (name) => events.push(`uploaded:${name}`),
		onFailed: (name, message) => events.push(`failed:${name}:${message}`),
		onPlaceholderLost: (name, url) => events.push(`lost:${name}:${url}`),
		onCancelled: (name) => events.push(`cancelled:${name}`),
		onSavedToVault: (name, path, placed) => events.push(`saved:${name}:${path}:${placed}`),
		onSaveToVaultFailed: (name, message) => events.push(`save-failed:${name}:${message}`),
	};

	const store = new UploadProgressStore();
	const queue = new UploadQueue(store, host);

	const add = (id: string, name: string) => {
		const file = new File(["data"], name, { type: "application/pdf" });
		queue.add(id, file, "note");
		note += `[Uploading ${name}…](#${id})\n`;
		return file;
	};

	return {
		store,
		queue,
		uploads,
		events,
		add,
		get note() {
			return note;
		},
		set note(value: string) {
			note = value;
		},
	};
}

describe("raceAbort", () => {
	it("resolves with the promise when not aborted", async () => {
		const controller = new AbortController();
		await expect(raceAbort(Promise.resolve(1), controller.signal)).resolves.toBe(1);
	});

	it("rejects with UploadCancelledError as soon as the signal aborts", async () => {
		const controller = new AbortController();
		const pending = deferred<number>();
		const raced = raceAbort(pending.promise, controller.signal);
		controller.abort();
		await expect(raced).rejects.toBeInstanceOf(UploadCancelledError);
		// A late settle of the abandoned request does nothing.
		pending.resolve(2);
	});

	it("rejects immediately for an already aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const failing = Promise.reject(new Error("late"));
		await expect(raceAbort(failing, controller.signal)).rejects.toBeInstanceOf(UploadCancelledError);
	});
});

describe("UploadQueue", () => {
	it("shows queued jobs as waiting and runs them one at a time", async () => {
		const h = createHarness();
		h.add("oss-upload-1-1", "a.pdf");
		h.add("oss-upload-1-2", "b.pdf");
		expect(h.store.get("oss-upload-1-1")?.status).toBe("queued");
		expect(h.store.get("oss-upload-1-1")?.percent).toBe(0);

		h.queue.enqueue(["oss-upload-1-1", "oss-upload-1-2"]);
		expect(h.uploads).toHaveLength(1);
		expect(h.store.get("oss-upload-1-1")?.status).toBe("uploading");
		expect(h.store.get("oss-upload-1-2")?.status).toBe("queued");

		h.uploads[0].progress(41.6);
		expect(h.store.get("oss-upload-1-1")?.percent).toBe(42);

		h.uploads[0].result.resolve({ url: "https://x/a.pdf", text: "[a](https://x/a.pdf)\n" });
		await flush();
		expect(h.note).toBe("[a](https://x/a.pdf)\n[Uploading b.pdf…](#oss-upload-1-2)\n");
		expect(h.store.has("oss-upload-1-1")).toBe(false);
		expect(h.queue.has("oss-upload-1-1")).toBe(false);
		expect(h.uploads).toHaveLength(2);
		expect(h.events).toContain("uploaded:a.pdf");
	});

	it("keeps a failed upload's placeholder and file, and retries it", async () => {
		const h = createHarness();
		const file = h.add("oss-upload-1-1", "a.pdf");
		h.queue.enqueue(["oss-upload-1-1"]);
		h.uploads[0].result.reject(new Error("403 Forbidden"));
		await flush();

		const entry = h.store.get("oss-upload-1-1");
		expect(entry?.status).toBe("failed");
		expect(entry?.error).toBe("403 Forbidden");
		expect(h.note).toContain("(#oss-upload-1-1)");
		expect(h.events).toContain("failed:a.pdf:403 Forbidden");
		expect(h.queue.failedJobs()).toEqual([{ id: "oss-upload-1-1", target: "note" }]);

		h.store.requestAction("oss-upload-1-1", "retry");
		expect(h.store.get("oss-upload-1-1")?.status).toBe("uploading");
		expect(h.store.get("oss-upload-1-1")?.error).toBeUndefined();
		expect(h.uploads).toHaveLength(2);
		expect(h.uploads[1].file).toBe(file);

		h.uploads[1].result.resolve({ url: "u", text: "done\n" });
		await flush();
		expect(h.note).toBe("done\n");
		expect(h.queue.has("oss-upload-1-1")).toBe(false);
	});

	it("saves a failed upload to the vault and replaces the placeholder with the link", async () => {
		const h = createHarness();
		h.add("oss-upload-1-1", "a.pdf");
		h.queue.enqueue(["oss-upload-1-1"]);
		h.uploads[0].result.reject(new Error("offline"));
		await flush();

		h.store.requestAction("oss-upload-1-1", "save-local");
		await flush();
		expect(h.note).toBe("![[a.pdf]]\n");
		expect(h.store.has("oss-upload-1-1")).toBe(false);
		expect(h.events).toContain("saved:a.pdf:attachments/a.pdf:true");
	});

	it("dismiss removes the placeholder and releases the file", async () => {
		const h = createHarness();
		h.add("oss-upload-1-1", "a.pdf");
		h.queue.enqueue(["oss-upload-1-1"]);
		h.uploads[0].result.reject(new Error("offline"));
		await flush();

		h.store.requestAction("oss-upload-1-1", "dismiss");
		await flush();
		expect(h.note).toBe("");
		expect(h.queue.has("oss-upload-1-1")).toBe(false);
	});

	it("cancel stops waiting, removes the placeholder and starts the next upload", async () => {
		const h = createHarness();
		h.add("oss-upload-1-1", "a.pdf");
		h.add("oss-upload-1-2", "b.pdf");
		h.queue.enqueue(["oss-upload-1-1", "oss-upload-1-2"]);

		h.store.requestAction("oss-upload-1-1", "cancel");
		await flush();
		expect(h.uploads[0].signal.aborted).toBe(true);
		expect(h.note).toBe("[Uploading b.pdf…](#oss-upload-1-2)\n");
		expect(h.events).toContain("cancelled:a.pdf");
		expect(h.uploads).toHaveLength(2);

		// The abandoned request finishing later changes nothing.
		h.uploads[0].result.resolve({ url: "u", text: "late\n" });
		await flush();
		expect(h.note).toBe("[Uploading b.pdf…](#oss-upload-1-2)\n");
	});

	it("cancelling a queued upload never starts it", async () => {
		const h = createHarness();
		h.add("oss-upload-1-1", "a.pdf");
		h.add("oss-upload-1-2", "b.pdf");
		h.queue.enqueue(["oss-upload-1-1", "oss-upload-1-2"]);
		h.store.requestAction("oss-upload-1-2", "cancel");
		await flush();
		expect(h.note).toBe("[Uploading a.pdf…](#oss-upload-1-1)\n");
		expect(h.events).not.toContain("cancelled:b.pdf");

		h.uploads[0].result.resolve({ url: "u", text: "a\n" });
		await flush();
		expect(h.uploads).toHaveLength(1);
	});

	it("reports the URL when the placeholder was removed during the upload", async () => {
		const h = createHarness();
		h.add("oss-upload-1-1", "a.pdf");
		h.queue.enqueue(["oss-upload-1-1"]);
		h.note = "user deleted it\n";
		h.uploads[0].result.resolve({ url: "https://x/a.pdf", text: "a\n" });
		await flush();
		expect(h.events).toContain("lost:a.pdf:https://x/a.pdf");
		expect(h.note).toBe("user deleted it\n");
	});

	it("releaseFailed drops only failed jobs", async () => {
		const h = createHarness();
		h.add("oss-upload-1-1", "a.pdf");
		h.add("oss-upload-1-2", "b.pdf");
		h.queue.enqueue(["oss-upload-1-1", "oss-upload-1-2"]);
		h.queue.releaseFailed("oss-upload-1-1");
		expect(h.queue.has("oss-upload-1-1")).toBe(true);

		h.uploads[0].result.reject(new Error("x"));
		await flush();
		h.queue.releaseFailed("oss-upload-1-1");
		expect(h.queue.has("oss-upload-1-1")).toBe(false);
		expect(h.store.has("oss-upload-1-1")).toBe(false);
	});

	it("dispose leaves a readable marker for every unfinished upload", async () => {
		const h = createHarness();
		h.add("oss-upload-1-1", "a.pdf");
		h.add("oss-upload-1-2", "b.pdf");
		h.queue.enqueue(["oss-upload-1-1", "oss-upload-1-2"]);
		h.uploads[0].result.reject(new Error("x"));
		await flush();

		h.queue.dispose();
		expect(h.note).toBe("(Upload of a.pdf did not finish)\n(Upload of b.pdf did not finish)\n");
		expect(h.queue.has("oss-upload-1-1")).toBe(false);
		// Card buttons no longer reach the queue.
		h.queue.handleAction("oss-upload-1-1", "retry");
		h.store.requestAction("oss-upload-1-1", "retry");
		expect(h.uploads).toHaveLength(2);
	});

	it("ignores actions that do not fit the current state", async () => {
		const h = createHarness();
		h.add("oss-upload-1-1", "a.pdf");
		h.queue.enqueue(["oss-upload-1-1"]);
		h.store.requestAction("oss-upload-1-1", "retry");
		h.store.requestAction("oss-upload-1-1", "dismiss");
		h.store.requestAction("oss-upload-1-1", "save-local");
		await flush();
		expect(h.uploads).toHaveLength(1);
		expect(h.note).toContain("(#oss-upload-1-1)");
		expect(h.store.get("oss-upload-1-1")?.status).toBe("uploading");
	});
});
