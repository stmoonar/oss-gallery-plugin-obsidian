import { describe, expect, it } from "vitest";
import { FakeTimers, flushMicrotasks } from "./helpers";
import {
	ByteRequest,
	ByteResponse,
	FetchAbortedError,
	fetchRemoteImageBytes,
	MAX_INDEX_IMAGE_BYTES,
	RemoteFetchError,
	SignedGet,
} from "../../src/services/remoteBytes";

/** A mocked Obsidian requestUrl: answers by URL, records every request. */
function mockRequest(answers: Record<string, number | Error>) {
	const calls: ByteRequest[] = [];
	const request = (req: ByteRequest): Promise<ByteResponse> => {
		calls.push(req);
		const answer = answers[req.url];
		if (answer instanceof Error) {
			return Promise.reject(answer);
		}
		const status = answer ?? 404;
		const bytes = new TextEncoder().encode(`body of ${req.url}`);
		return Promise.resolve({ status, arrayBuffer: bytes.buffer.slice(0) });
	};
	return { request, calls };
}

const text = (b: ArrayBuffer) => new TextDecoder().decode(b);
const OBJ = { key: "2025/cat.png", url: "https://cdn.example/2025/cat.png" };
const SIGNED: SignedGet = { url: "https://s3.example/bucket/2025/cat.png", headers: { Authorization: "AWS4-HMAC-SHA256 sig" } };

async function failure(p: Promise<unknown>): Promise<RemoteFetchError> {
	try {
		await p;
	} catch (error) {
		expect(error).toBeInstanceOf(RemoteFetchError);
		return error as RemoteFetchError;
	}
	throw new Error("expected a failure");
}

describe("fetchRemoteImageBytes (requestUrl, §4.5)", () => {
	it("200: downloads the listed URL once, without throwing on HTTP errors", async () => {
		const m = mockRequest({ [OBJ.url]: 200 });
		const bytes = await fetchRemoteImageBytes(OBJ, { request: m.request, signedGet: () => SIGNED });
		expect(text(bytes)).toBe(`body of ${OBJ.url}`);
		expect(m.calls).toEqual([{ url: OBJ.url, method: "GET", headers: {}, throw: false }]);
	});

	it("uses a presigned listed URL as given (query string kept)", async () => {
		const presigned = { key: OBJ.key, url: `${OBJ.url}?X-Amz-Signature=abc&X-Amz-Expires=900` };
		const m = mockRequest({ [presigned.url]: 200 });
		await fetchRemoteImageBytes(presigned, { request: m.request });
		expect(m.calls.map((c) => c.url)).toEqual([presigned.url]);
	});

	it("403 without a signer: failed with an access-denied reason", async () => {
		const m = mockRequest({ [OBJ.url]: 403 });
		const error = await failure(fetchRemoteImageBytes(OBJ, { request: m.request }));
		expect(error.kind).toBe("access-denied");
		expect(error.status).toBe(403);
		expect(error.message).toMatch(/Access denied \(HTTP 403\).*bucket permissions/);
	});

	it("403 with a signer: retries once with the signed GET (private bucket)", async () => {
		const m = mockRequest({ [OBJ.url]: 403, [SIGNED.url]: 200 });
		const keys: string[] = [];
		const bytes = await fetchRemoteImageBytes(OBJ, {
			request: m.request,
			signedGet: (key) => {
				keys.push(key);
				return SIGNED;
			},
		});
		expect(text(bytes)).toBe(`body of ${SIGNED.url}`);
		expect(keys).toEqual([OBJ.key]);
		expect(m.calls[1]).toEqual({ url: SIGNED.url, method: "GET", headers: SIGNED.headers, throw: false });
	});

	it("403 on both: access denied, no further attempts", async () => {
		const m = mockRequest({ [OBJ.url]: 401, [SIGNED.url]: 403 });
		const error = await failure(fetchRemoteImageBytes(OBJ, { request: m.request, signedGet: () => SIGNED }));
		expect(error.kind).toBe("access-denied");
		expect(error.status).toBe(403);
		expect(m.calls).toHaveLength(2);
	});

	it("404: not found, the signer is not tried", async () => {
		const m = mockRequest({ [OBJ.url]: 404 });
		let signed = 0;
		const error = await failure(fetchRemoteImageBytes(OBJ, {
			request: m.request,
			signedGet: () => {
				signed++;
				return SIGNED;
			},
		}));
		expect(error.kind).toBe("not-found");
		expect(error.message).toMatch(/Not found \(HTTP 404\)/);
		expect(signed).toBe(0);
	});

	it("other HTTP errors and network errors get their own reasons", async () => {
		const http = await failure(fetchRemoteImageBytes(OBJ, { request: mockRequest({ [OBJ.url]: 500 }).request }));
		expect(http.kind).toBe("http");
		expect(http.message).toBe("Download failed (HTTP 500)");
		const net = await failure(fetchRemoteImageBytes(OBJ, {
			request: mockRequest({ [OBJ.url]: new Error("getaddrinfo ENOTFOUND cdn.example") }).request,
		}));
		expect(net.kind).toBe("network");
		expect(net.message).toBe("Network error: getaddrinfo ENOTFOUND cdn.example");
	});

	it("objects without a URL use the signed GET, or fail clearly", async () => {
		const noUrl = { key: OBJ.key, url: "" };
		const m = mockRequest({ [SIGNED.url]: 200 });
		expect(text(await fetchRemoteImageBytes(noUrl, { request: m.request, signedGet: () => SIGNED })))
			.toBe(`body of ${SIGNED.url}`);
		const error = await failure(fetchRemoteImageBytes(noUrl, { request: m.request, signedGet: () => null }));
		expect(error.kind).toBe("no-url");
	});

	it("a signer that throws counts as no signer", async () => {
		const m = mockRequest({ [OBJ.url]: 403 });
		const error = await failure(fetchRemoteImageBytes(OBJ, {
			request: m.request,
			signedGet: () => {
				throw new Error("not configured");
			},
		}));
		expect(error.kind).toBe("access-denied");
	});

	it("uses the localized describer", async () => {
		const m = mockRequest({ [OBJ.url]: 403 });
		const error = await failure(fetchRemoteImageBytes(OBJ, {
			request: m.request,
			describe: (kind, status) => `${kind}:${status}`,
		}));
		expect(error.message).toBe("access-denied:403");
	});
});

describe("fetchRemoteImageBytes guards (timeout, cancel, size, 4xx signing)", () => {
	it("400 with a signer (R2 anonymous GET): retries signed", async () => {
		const m = mockRequest({ [OBJ.url]: 400, [SIGNED.url]: 200 });
		const bytes = await fetchRemoteImageBytes(OBJ, { request: m.request, signedGet: () => SIGNED });
		expect(text(bytes)).toBe(`body of ${SIGNED.url}`);
		expect(m.calls.map((c) => c.url)).toEqual([OBJ.url, SIGNED.url]);
	});

	it("5xx is not retried signed", async () => {
		const m = mockRequest({ [OBJ.url]: 503, [SIGNED.url]: 200 });
		const error = await failure(fetchRemoteImageBytes(OBJ, { request: m.request, signedGet: () => SIGNED }));
		expect(error.status).toBe(503);
		expect(m.calls).toHaveLength(1);
	});

	it("times out a hung request", async () => {
		const timers = new FakeTimers();
		const hung = (): Promise<ByteResponse> => new Promise(() => undefined);
		const p = failure(fetchRemoteImageBytes(OBJ, { request: hung, timers, timeoutMs: 1000 }));
		await flushMicrotasks();
		expect(timers.delays()).toEqual([1000]);
		timers.fireAll();
		const error = await p;
		expect(error.kind).toBe("network");
		expect(error.message).toMatch(/timed out after 1 s/);
	});

	it("an abort signal interrupts an in-flight request", async () => {
		const timers = new FakeTimers();
		const controller = new AbortController();
		const hung = (): Promise<ByteResponse> => new Promise(() => undefined);
		const p = fetchRemoteImageBytes(OBJ, { request: hung, timers, signal: controller.signal }).then(
			() => null,
			(e: unknown) => e
		);
		await flushMicrotasks();
		controller.abort();
		expect(await p).toBeInstanceOf(FetchAbortedError);
		expect(timers.size).toBe(0);
	});

	it("refuses objects above the cap by listed size (no request) and by response size", async () => {
		const m = mockRequest({ [OBJ.url]: 200 });
		const big = await failure(fetchRemoteImageBytes({ ...OBJ, size: MAX_INDEX_IMAGE_BYTES + 1 }, { request: m.request }));
		expect(big.kind).toBe("too-large");
		expect(big.message).toMatch(/Too large to index/);
		expect(m.calls).toHaveLength(0);
		const small = await failure(fetchRemoteImageBytes({ ...OBJ, size: 0 }, { request: m.request, maxBytes: 4 }));
		expect(small.kind).toBe("too-large");
		expect(m.calls).toHaveLength(1);
	});
});
