/**
 * Bytes of a remote image for indexing (docs/semantic-search.md §4.5, §11.16).
 *
 * Always through Obsidian's `requestUrl` (injected here so it can be tested
 * without Obsidian): unlike `fetch()` from the `app://obsidian.md` origin it
 * needs no bucket CORS rules and uses the system proxy. The first attempt is
 * the URL the gallery displays (`OssImage.url`, which is whatever the
 * provider lists, presigned or not). When that is refused (401/403, typical
 * for private buckets) and the provider can sign a GET for the key, a signed
 * request is tried once. The cache key is never the URL (D15).
 */

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

export type RemoteFetchFailure = "access-denied" | "not-found" | "http" | "network" | "no-url";

/** Turns a failure into the reason shown in the index status details. */
export type FailureDescriber = (kind: RemoteFetchFailure, status: number | undefined, detail: string) => string;

export class RemoteFetchError extends Error {
	constructor(
		readonly kind: RemoteFetchFailure,
		readonly status: number | undefined,
		message: string
	) {
		super(message);
		this.name = "RemoteFetchError";
	}
}

export interface RemoteFetchOptions {
	request: ByteRequester;
	/** Signed GET for a key (private buckets), or null when the provider can't sign. */
	signedGet?: (key: string) => SignedGet | null;
	describe?: FailureDescriber;
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

function failureKind(status: number): RemoteFetchFailure {
	if (status === 401 || status === 403) {
		return "access-denied";
	}
	return status === 404 ? "not-found" : "http";
}

function isOk(status: number): boolean {
	return status >= 200 && status < 300;
}

/**
 * Download `obj` (its listed URL, then a signed GET when access is denied).
 * Throws RemoteFetchError with a user-facing message.
 */
export async function fetchRemoteImageBytes(
	obj: { key: string; url: string },
	options: RemoteFetchOptions
): Promise<ArrayBuffer> {
	const describe = options.describe ?? describeFetchFailureEn;
	const fail = (kind: RemoteFetchFailure, status?: number, detail = ""): RemoteFetchError =>
		new RemoteFetchError(kind, status, describe(kind, status, detail));

	const send = async (target: SignedGet): Promise<ByteResponse> => {
		try {
			return await options.request({
				url: target.url,
				method: "GET",
				headers: target.headers,
				throw: false,
			});
		} catch (error) {
			throw fail("network", undefined, error instanceof Error ? error.message : String(error));
		}
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
	const kind = failureKind(response.status);
	if (kind === "access-denied") {
		const target = signed();
		if (target) {
			const retry = await send(target);
			if (isOk(retry.status)) {
				return retry.arrayBuffer;
			}
			throw fail(failureKind(retry.status), retry.status);
		}
	}
	throw fail(kind, response.status);
}
