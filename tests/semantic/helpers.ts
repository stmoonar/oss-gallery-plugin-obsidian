/**
 * Shared test helpers for tests/semantic/*.test.ts (not a test file itself).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Timers } from "../../src/utils/timers";

/** Manually driven `Timers`: nothing fires until the test says so. */
export class FakeTimers implements Timers {
	private nextId = 1;
	readonly pending = new Map<number, { fn: () => void; ms: number }>();
	readonly armed: number[] = [];
	readonly cleared: number[] = [];

	setTimeout(fn: () => void, ms: number): number {
		const id = this.nextId++;
		this.pending.set(id, { fn, ms });
		this.armed.push(ms);
		return id;
	}

	clearTimeout(id: number): void {
		this.cleared.push(id);
		this.pending.delete(id);
	}

	get size(): number {
		return this.pending.size;
	}

	/** Delays of the timers that are currently pending. */
	delays(): number[] {
		return [...this.pending.values()].map((t) => t.ms);
	}

	/** Fire every pending timer (in creation order). */
	fireAll(): void {
		const due = [...this.pending.values()];
		this.pending.clear();
		for (const t of due) {
			t.fn();
		}
	}
}

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

export function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let queued microtasks / promise chains run. */
export async function flushMicrotasks(rounds = 20): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
	}
}

export function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(out).set(bytes);
	return out;
}
