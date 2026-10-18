import { describe, expect, it } from "vitest";
import {
	estimateRebuild,
	formatApproxMegabytes,
	formatMissingSummary,
	providerOptionLabel,
	sanitizeErrorMessage,
	semanticDownloadSize,
	withTimeout,
} from "../../src/settings/settingsUx";
import { getAllAssets, totalSize } from "../../src/semantic/assets";
import { mirrorMayHelp, usesMirror } from "../../src/semantic/mirrors";

const TEMPLATES = { uploadOnly: "{label} (upload only)", notConfigured: "{label} – not set up" };

describe("providerOptionLabel", () => {
	it("keeps the plain label for a configured full provider", () => {
		expect(providerOptionLabel({ label: "S3", uploadOnly: false, configured: true }, TEMPLATES)).toBe("S3");
	});

	it("marks upload-only and unconfigured providers", () => {
		expect(providerOptionLabel({ label: "Imgur", uploadOnly: true, configured: true }, TEMPLATES))
			.toBe("Imgur (upload only)");
		expect(providerOptionLabel({ label: "Imgur", uploadOnly: true, configured: false }, TEMPLATES))
			.toBe("Imgur (upload only) – not set up");
		expect(providerOptionLabel({ label: "GitHub", uploadOnly: false, configured: false }, TEMPLATES))
			.toBe("GitHub – not set up");
	});
});

describe("formatMissingSummary", () => {
	it("joins the labels into the template", () => {
		expect(formatMissingSummary(["Bucket", "Secret key"], "Missing: {fields}", ", ")).toBe("Missing: Bucket, Secret key");
	});

	it("is empty when nothing is missing", () => {
		expect(formatMissingSummary([], "Missing: {fields}", ", ")).toBe("");
	});
});

describe("sanitizeErrorMessage", () => {
	it("replaces credential values, also URL-encoded", () => {
		const secret = "AKIAEXAMPLE/abc+def";
		const text = `Bad key ${secret} in https://h/x?k=${encodeURIComponent(secret)} and ${secret}`;
		const out = sanitizeErrorMessage(text, [secret]);
		expect(out).not.toContain(secret);
		expect(out).not.toContain(encodeURIComponent(secret));
		expect(out).toContain("Bad key ***");
	});

	it("drops URL query strings (signatures, tokens) but keeps the path", () => {
		const out = sanitizeErrorMessage("GET https://bucket.example.com/a.png?X-Amz-Signature=abc&token=zzz failed", []);
		expect(out).toBe("GET https://bucket.example.com/a.png?*** failed");
	});

	it("hides authorization header values and signature parameters", () => {
		expect(sanitizeErrorMessage("Authorization: Bearer ghp_123456", [])).toBe("Authorization: Bearer ***");
		expect(sanitizeErrorMessage("header UPYUN op:c2lnbmF0dXJl rejected", [])).toBe("header UPYUN *** rejected");
		expect(sanitizeErrorMessage("Signature=deadbeef, other", [])).toBe("Signature=***, other");
	});

	it("leaves ordinary words alone", () => {
		const text = "GitHub authentication failed. Please check your token. Configure Qiniu settings and OSS bucket first";
		expect(sanitizeErrorMessage(text, ["", "ab"])).toBe(text);
	});

	it("cuts long messages", () => {
		const out = sanitizeErrorMessage("x".repeat(500), [], 50);
		expect(out).toHaveLength(50);
		expect(out.endsWith("…")).toBe(true);
	});

	it("replaces the longest secret first", () => {
		expect(sanitizeErrorMessage("abcd-efgh", ["abcd", "abcd-efgh"])).toBe("***");
	});
});

describe("semantic download size", () => {
	it("is computed from the asset manifest, in whole megabytes", () => {
		const assets = getAllAssets("1.0.0");
		const total = totalSize(assets);
		expect(semanticDownloadSize(assets)).toBe(`${Math.round(total / 1_000_000)} MB`);
		// Sanity: the q4 model plus runtime is a few hundred MB.
		expect(total).toBeGreaterThan(100_000_000);
	});

	it("never rounds down to 0 MB", () => {
		expect(formatApproxMegabytes(1000)).toBe("1 MB");
		expect(formatApproxMegabytes(343_400_000)).toBe("343 MB");
	});
});

describe("estimateRebuild", () => {
	it("downloads nothing for Local", () => {
		expect(estimateRebuild(5, [{ size: 10 }], true)).toEqual({ indexed: 5, downloadBytes: 0, unknownSizeCount: 0 });
	});

	it("is unknown before the first listing", () => {
		expect(estimateRebuild(3, null, false).downloadBytes).toBeNull();
	});

	it("sums listed sizes and counts unknown ones", () => {
		expect(estimateRebuild(2, [{ size: 100 }, { size: 0 }, { size: 50 }], false))
			.toEqual({ indexed: 2, downloadBytes: 150, unknownSizeCount: 1 });
	});
});

describe("mirror hints", () => {
	it("suggests a mirror only for source-related failures", () => {
		expect(mirrorMayHelp("network")).toBe(true);
		expect(mirrorMayHelp("http")).toBe(true);
		expect(mirrorMayHelp("hash-mismatch")).toBe(false);
		expect(mirrorMayHelp("fs")).toBe(false);
		expect(mirrorMayHelp(undefined)).toBe(false);
	});

	it("knows whether a mirror is set", () => {
		expect(usesMirror({ hfEndpoint: "", githubMirror: "" })).toBe(false);
		expect(usesMirror({ hfEndpoint: "https://hf-mirror.com", githubMirror: "" })).toBe(true);
	});
});

describe("withTimeout", () => {
	function fakeTimers() {
		const pending = new Map<number, () => void>();
		let next = 1;
		return {
			pending,
			timers: {
				set: (fn: () => void) => {
					const id = next++;
					pending.set(id, fn);
					return id;
				},
				clear: (handle: unknown) => {
					pending.delete(handle as number);
				},
			},
		};
	}

	it("resolves and clears the timer", async () => {
		const { pending, timers } = fakeTimers();
		await expect(withTimeout(Promise.resolve(7), 1000, () => new Error("late"), timers)).resolves.toBe(7);
		expect(pending.size).toBe(0);
	});

	it("rejects with the timeout error when the timer fires first", async () => {
		const { pending, timers } = fakeTimers();
		const never = new Promise<number>(() => {});
		const result = withTimeout(never, 1000, () => new Error("late"), timers);
		[...pending.values()][0]();
		await expect(result).rejects.toThrow("late");
	});

	it("passes through rejections", async () => {
		const { timers } = fakeTimers();
		await expect(withTimeout(Promise.reject(new Error("boom")), 1000, () => new Error("late"), timers))
			.rejects.toThrow("boom");
	});
});
