/**
 * Streaming HTTPS download with Node's `https` module.
 *
 * Not `requestUrl` (no streaming, no progress, whole body in memory) and not
 * `fetch` (GitHub release assets redirect to a CDN without CORS headers for
 * the app://obsidian.md origin). Redirects are followed manually, HTTPS only.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as https from "https";
import type { IncomingMessage } from "http";
import { Transform, Writable } from "stream";
import { pipeline } from "stream/promises";

export type DownloadErrorCode =
	| "cancelled"
	| "http"
	| "network"
	| "too-many-redirects"
	| "insecure-redirect"
	| "size-mismatch"
	| "hash-mismatch"
	| "locked"
	| "fs";

export class DownloadError extends Error {
	constructor(
		readonly code: DownloadErrorCode,
		message: string,
		readonly status?: number
	) {
		super(message);
		this.name = "DownloadError";
	}

	/** Worth another attempt: transient network/server trouble or corruption in transit. */
	get retryable(): boolean {
		switch (this.code) {
			case "network":
			case "size-mismatch":
			case "hash-mismatch":
				return true;
			case "http":
				return this.status === undefined || this.status === 408 || this.status === 429 || this.status >= 500;
			default:
				return false;
		}
	}
}

export interface HttpsDownloadOptions {
	signal: AbortSignal;
	/** Expected body length; longer bodies are cut off early. */
	expectedSize: number;
	onBytes?: (n: number) => void;
	maxRedirects?: number;
	/** Socket inactivity timeout. */
	idleTimeoutMs?: number;
}

export interface HttpsDownloadResult {
	size: number;
	sha256: string;
	finalUrl: string;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const USER_AGENT = "obsidian-oss-gallery";

function isAbortError(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function toDownloadError(error: unknown, signal: AbortSignal): DownloadError {
	if (error instanceof DownloadError) {
		return error;
	}
	if (isAbortError(error, signal)) {
		return new DownloadError("cancelled", "Download cancelled");
	}
	const message = error instanceof Error ? error.message : String(error);
	return new DownloadError("network", message);
}

function get(url: URL, signal: AbortSignal, idleTimeoutMs: number): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		const req = https.get(
			url,
			{
				signal,
				headers: {
					"User-Agent": USER_AGENT,
					"Accept-Encoding": "identity",
				},
			},
			resolve
		);
		req.setTimeout(idleTimeoutMs, () => {
			req.destroy(new DownloadError("network", `Timed out after ${idleTimeoutMs} ms`));
		});
		req.on("error", reject);
	});
}

/** Follow redirects (HTTPS only) until a 200 response. */
async function openStream(
	url: string,
	signal: AbortSignal,
	maxRedirects: number,
	idleTimeoutMs: number
): Promise<{ response: IncomingMessage; finalUrl: string }> {
	let current = new URL(url);
	for (let hop = 0; hop <= maxRedirects; hop++) {
		if (current.protocol !== "https:") {
			throw new DownloadError("insecure-redirect", `Refusing non-HTTPS URL ${current.origin}`);
		}
		const response = await get(current, signal, idleTimeoutMs);
		const status = response.statusCode ?? 0;
		if (status >= 300 && status < 400 && response.headers.location) {
			response.resume();
			current = new URL(response.headers.location, current);
			continue;
		}
		if (status !== 200) {
			response.resume();
			throw new DownloadError("http", `HTTP ${status} from ${current.host}`, status);
		}
		return { response, finalUrl: current.toString() };
	}
	throw new DownloadError("too-many-redirects", `More than ${maxRedirects} redirects`);
}

/**
 * Stream `url` into `destPath` (truncating it) while computing SHA-256.
 * The caller verifies the hash and renames the file into place.
 */
export async function httpsDownload(
	url: string,
	destPath: string,
	options: HttpsDownloadOptions
): Promise<HttpsDownloadResult> {
	const { signal, expectedSize, onBytes } = options;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

	try {
		const { response, finalUrl } = await openStream(url, signal, maxRedirects, idleTimeoutMs);
		const declared = Number(response.headers["content-length"]);
		if (Number.isFinite(declared) && declared !== expectedSize) {
			response.resume();
			throw new DownloadError(
				"size-mismatch",
				`Server reports ${declared} bytes, expected ${expectedSize}`
			);
		}

		const hash = createHash("sha256");
		let size = 0;
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				size += chunk.length;
				if (size > expectedSize) {
					callback(new DownloadError("size-mismatch", `More than ${expectedSize} bytes received`));
					return;
				}
				hash.update(chunk);
				onBytes?.(chunk.length);
				callback(null, chunk);
			},
		});

		await pipeline(response, meter, fs.createWriteStream(destPath), { signal });
		return { size, sha256: hash.digest("hex"), finalUrl };
	} catch (error) {
		throw toDownloadError(error, signal);
	}
}

/** SHA-256 of a file on disk, streamed. */
export async function hashFile(
	filePath: string,
	signal?: AbortSignal,
	onBytes?: (n: number) => void
): Promise<string> {
	const hash = createHash("sha256");
	const sink = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			onBytes?.(chunk.length);
			callback();
		},
	});
	await pipeline(fs.createReadStream(filePath), sink, signal ? { signal } : {});
	return hash.digest("hex");
}
