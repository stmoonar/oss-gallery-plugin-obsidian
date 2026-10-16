/**
 * Bytes of a remote image, for semantic indexing (docs/semantic-search.md
 * §4.5, §11.16) and for gallery tiles that make a local thumbnail
 * (src/thumbnails). Neutral module: imports neither of them.
 *
 * Always through Obsidian's `requestUrl` (injected here so it can be tested
 * without Obsidian): unlike `fetch()` from the `app://obsidian.md` origin it
 * needs no bucket CORS rules and uses the system proxy. The first attempt is
 * the URL the gallery displays (`OssImage.url`, which is whatever the
 * provider lists, presigned or not). When that is refused with a 4xx other
 * than 404 (401/403 for private buckets; R2 and some S3-compatible endpoints
 * answer an anonymous GET with 400) and the provider can sign a GET for the
 * key, a signed request is tried once. The cache key is never the URL (D15).
 *
 * Guards: a download is raced against a timeout and an abort signal
 * (requestUrl itself cannot be aborted; the request is abandoned), and
 * objects above MAX_INDEX_IMAGE_BYTES (listed size, then response size) are
 * refused ("too-large").
 */
import type { Timers } from "../utils/timers";

export interface ByteRequest {
	url: string;
	method: "GET";
	headers?: Record<string, string>;
	/** Obsidian's requestUrl option: report HTTP errors as a status instead of throwing. */
	throw: false;
}

export interface ByteResponse {
	status: number;
	arrayBuffer: ArrayBuffer;
}

export type ByteRequester = (request: ByteRequest) => Promise<ByteResponse>;

/** A ready-to-send signed GET (URL + signed headers). */
export interface SignedGet {
	url: string;
	headers: Record<string, string>;
}

/** Largest object the indexer downloads or reads (requestUrl buffers the whole body). */
export const MAX_INDEX_IMAGE_BYTES = 50 * 1024 * 1024;
/** One download (one request) may take this long. */
export const DOWNLOAD_TIMEOUT_MS = 3 * 60_000;

export type RemoteFetchFailure = "access-denied" | "not-found" | "http" | "network" | "no-url";
/** Every RemoteFetchError kind; "too-large" has its own describer (describeTooLarge). */
export type RemoteFetchErrorKind = RemoteFetchFailure | "too-large";

/** Turns a failure into the reason shown in the index status details. */
export type FailureDescriber = (kind: RemoteFetchFailure, status: number | undefined, detail: string) => string;
/** Reason for an object above the size cap (`bytes` = listed or downloaded size). */
export type TooLargeDescriber = (bytes: number, limit: number) => string;

export class RemoteFetchError extends Error {
	constructor(
		readonly kind: RemoteFetchErrorKind,
		readonly status: number | undefined,
		message: string
	) {
		super(message);
		this.name = "RemoteFetchError";
	}
}

/** The download was abandoned because the abort signal fired. */
export class FetchAbortedError extends Error {
	constructor() {
		super("Download cancelled");
		this.name = "FetchAbortedError";
	}
}

/** The part of AbortSignal used here (tests pass an AbortController's signal). */
export interface AbortSignalLike {
	readonly aborted: boolean;
	addEventListener(type: "abort", listener: () => void): void;
	removeEventListener(type: "abort", listener: () => void): void;
}

export interface RemoteFetchOptions {
	request: ByteRequester;
	/** Signed GET for a key (private buckets), or null when the provider can't sign. */
	signedGet?: (key: string) => SignedGet | null;
	describe?: FailureDescriber;
	describeTooLarge?: TooLargeDescriber;
	/** Per request; default DOWNLOAD_TIMEOUT_MS, 0 disables. */
	timeoutMs?: number;
	/** Default MAX_INDEX_IMAGE_BYTES. */
	maxBytes?: number;
	/** Cancel (indexing stopped): rejects with FetchAbortedError. */
	signal?: AbortSignalLike;
	timers?: Timers;
}

/** Default (English) reasons; the plugin passes localized ones. */
export const describeFetchFailureEn: FailureDescriber = (kind, status, detail) => {
	switch (kind) {
		case "access-denied":
			return `Access denied (HTTP ${status ?? "?"}): check the bucket permissions or make the images publicly readable`;
		case "not-found":
			return "Not found (HTTP 404): the image was deleted or its public URL is wrong";
		case "http":
			return `Download failed (HTTP ${status ?? "?"})`;
		case "network":
			return `Network error: ${detail}`;
		case "no-url":
			return "No download URL for this image";
	}
};

function mb(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export const describeTooLargeEn: TooLargeDescriber = (bytes, limit) =>
	`Too large to index (${mb(bytes)}, limit ${mb(limit)})`;

function failureKind(status: number): RemoteFetchFailure {
	if (status === 401 || status === 403) {
		return "access-denied";
	}
	return status === 404 ? "not-found" : "http";
}

function isOk(status: number): boolean {
	return status >= 200 && status < 300;
}

/** A refused anonymous GET that a signed GET may get past (any 4xx but 404). */
function worthSigning(status: number): boolean {
	return status >= 400 && status < 500 && status !== 404;
}

const globalTimers: Timers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
	clearTimeout: (id) => clearTimeout(id),
};

/**
 * Settle with `work`, or reject when `timeoutMs` passes (`onTimeout()`) or
 * `signal` aborts (FetchAbortedError). The losing promise is left running.
 */
export function raceWithTimeout<T>(
	work: Promise<T>,
	options: { timeoutMs: number; signal?: AbortSignalLike; timers?: Timers; onTimeout: () => Error }
): Promise<T> {
	const signal = options.signal;
	if (signal?.aborted) {
		work.catch(() => undefined);
		return Promise.reject(new FetchAbortedError());
	}
	const timers = options.timers ?? globalTimers;
	return new Promise<T>((resolve, reject) => {
		let timer: number | null = null;
		const cleanup = (): void => {
			if (timer !== null) {
				timers.clearTimeout(timer);
				timer = null;
			}
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = (): void => {
			cleanup();
			reject(new FetchAbortedError());
		};
		signal?.addEventListener("abort", onAbort);
		if (options.timeoutMs > 0) {
			timer = timers.setTimeout(() => {
				timer = null;
				cleanup();
				reject(options.onTimeout());
			}, options.timeoutMs);
		}
		work.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		);
	});
}

/**
 * Download `obj` (its listed URL, then a signed GET when refused).
 * Throws RemoteFetchError with a user-facing message, or FetchAbortedError.
 */
export async function fetchRemoteImageBytes(
	obj: { key: string; url: string; size?: number },
	options: RemoteFetchOptions
): Promise<ArrayBuffer> {
	const describe = options.describe ?? describeFetchFailureEn;
	const describeTooLarge = options.describeTooLarge ?? describeTooLargeEn;
	const maxBytes = options.maxBytes ?? MAX_INDEX_IMAGE_BYTES;
	const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
	const fail = (kind: RemoteFetchFailure, status?: number, detail = ""): RemoteFetchError =>
		new RemoteFetchError(kind, status, describe(kind, status, detail));
	const tooLarge = (bytes: number): RemoteFetchError =>
		new RemoteFetchError("too-large", undefined, describeTooLarge(bytes, maxBytes));

	if (obj.size !== undefined && obj.size > maxBytes) {
		throw tooLarge(obj.size);
	}

	const send = async (target: SignedGet): Promise<ByteResponse> => {
		let response: ByteResponse;
		try {
			response = await raceWithTimeout(
				options.request({ url: target.url, method: "GET", headers: target.headers, throw: false }),
				{
					timeoutMs,
					signal: options.signal,
					timers: options.timers,
					onTimeout: () => fail("network", undefined, `timed out after ${Math.round(timeoutMs / 1000)} s`),
				}
			);
		} catch (error) {
			if (error instanceof RemoteFetchError || error instanceof FetchAbortedError) {
				throw error;
			}
			throw fail("network", undefined, error instanceof Error ? error.message : String(error));
		}
		if (isOk(response.status) && response.arrayBuffer.byteLength > maxBytes) {
			throw tooLarge(response.arrayBuffer.byteLength);
		}
		return response;
	};
	const signed = (): SignedGet | null => {
		try {
			return options.signedGet?.(obj.key) ?? null;
		} catch {
			return null;
		}
	};

	if (!obj.url) {
		const target = signed();
		if (!target) {
			throw fail("no-url");
		}
		const response = await send(target);
		if (isOk(response.status)) {
			return response.arrayBuffer;
		}
		throw fail(failureKind(response.status), response.status);
	}

	const response = await send({ url: obj.url, headers: {} });
	if (isOk(response.status)) {
		return response.arrayBuffer;
	}
	if (worthSigning(response.status)) {
		const target = signed();
		if (target) {
			const retry = await send(target);
			if (isOk(retry.status)) {
				return retry.arrayBuffer;
			}
			throw fail(failureKind(retry.status), retry.status);
		}
	}
	throw fail(failureKind(response.status), response.status);
}
