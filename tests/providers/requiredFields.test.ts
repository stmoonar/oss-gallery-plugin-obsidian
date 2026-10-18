import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));
vi.mock("obsidian", () => {
	class FileSystemAdapter {
		getBasePath(): string {
			return "/vault";
		}
	}
	return {
		requestUrl,
		Setting: class {},
		Platform: { isDesktopApp: true },
		FileSystemAdapter,
		normalizePath: (p: string) => p,
		moment: { locale: () => "en" },
	};
});

import { FileSystemAdapter } from "obsidian";
import en from "../../src/locale/en";
import zhCN from "../../src/locale/zh-cn";
import zhTW from "../../src/locale/zh-tw";
import { providerRegistry } from "../../src/providers/registry";
import {
	missingRequiredFields,
	providerSecrets,
	REQUIRED_FIELDS,
	requiredFieldsOf,
} from "../../src/providers/requiredFields";
import { S3Provider } from "../../src/providers/S3Provider";
import { QiniuProvider } from "../../src/providers/QiniuProvider";
import { DEFAULT_QINIU_SETTINGS, DEFAULT_S3_SETTINGS, DEFAULT_SETTINGS } from "../../src/types/settings";

// isConfigured of Local with a vault-relative path needs a file-system vault.
const app = { vault: { adapter: new (FileSystemAdapter as unknown as new () => object)() } } as never;

describe("required fields", () => {
	it("lists the empty required fields", () => {
		const missing = missingRequiredFields("qiniu", { accessKey: "a", secretKey: " ", bucket: "b", url: "" });
		expect(missing.map((m) => m.field)).toEqual(["secretKey", "url"]);
	});

	it("marks the Qiniu and Upyun URL fields as required", () => {
		expect(REQUIRED_FIELDS.qiniu.some((f) => f.field === "url")).toBe(true);
		expect(REQUIRED_FIELDS.upyun.some((f) => f.field === "url")).toBe(true);
	});

	it("uses labels that exist in every locale", () => {
		for (const specs of Object.values(REQUIRED_FIELDS)) {
			for (const spec of specs) {
				expect(en[spec.label], spec.label).toBeTruthy();
				expect(zhCN[spec.label], spec.label).toBeTruthy();
				expect(zhTW[spec.label], spec.label).toBeTruthy();
			}
		}
	});

	it("knows every provider of the default settings", () => {
		expect(Object.keys(REQUIRED_FIELDS).sort()).toEqual(Object.keys(DEFAULT_SETTINGS.providers).sort());
	});

	it("lists every required field of an unconfigured provider, in settings order", () => {
		expect(missingRequiredFields("s3", DEFAULT_SETTINGS.providers.s3).map((m) => m.label)).toEqual([
			"Endpoint",
			"Access Key ID",
			"Secret Access Key",
			"Bucket",
		]);
		expect(missingRequiredFields("smms", undefined).map((m) => m.field)).toEqual(["token"]);
	});

	it("counts whitespace as empty", () => {
		const github = { ...DEFAULT_SETTINGS.providers.github, repo: "me/img", token: "  " };
		expect(missingRequiredFields("github", github).map((m) => m.field)).toEqual(["token"]);
	});

	it("returns nothing for a complete or unknown provider", () => {
		expect(missingRequiredFields("imgur", { clientId: "x", proxy: "" })).toEqual([]);
		expect(missingRequiredFields("nope", {})).toEqual([]);
		expect(missingRequiredFields("toString", {})).toEqual([]);
		expect(requiredFieldsOf("constructor")).toEqual([]);
	});

	it("matches isConfigured for every registry provider", () => {
		for (const entry of providerRegistry.getAll(app)) {
			const specs = REQUIRED_FIELDS[entry.id];
			expect(specs, `required fields of ${entry.id}`).toBeDefined();
			const filled: Record<string, unknown> = { ...entry.defaultSettings };
			for (const spec of specs) {
				filled[spec.field] = "value";
			}
			expect(entry.isConfigured(filled as never, app), `${entry.id} filled`).toBe(true);
			expect(missingRequiredFields(entry.id, filled)).toEqual([]);
			for (const spec of specs) {
				const without = { ...filled, [spec.field]: "" };
				expect(entry.isConfigured(without as never, app), `${entry.id} without ${spec.field}`).toBe(false);
				expect(missingRequiredFields(entry.id, without).map((m) => m.field)).toEqual([spec.field]);
			}
		}
	});

	it("collects credential values only", () => {
		expect(providerSecrets({ bucket: "b", accessKeyId: "AK", secretAccessKey: " SK ", token: "" }))
			.toEqual(["AK", "SK"]);
	});
});

describe("testConnection", () => {
	beforeEach(() => {
		requestUrl.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("S3: one signed listing request for at most one key", async () => {
		// Node has no DOMParser: an empty <ListBucketResult> document is enough.
		vi.stubGlobal("DOMParser", class {
			parseFromString() {
				return { documentElement: { localName: "ListBucketResult" }, getElementsByTagName: () => [] };
			}
		});
		requestUrl.mockResolvedValue({ status: 200, text: "<ListBucketResult></ListBucketResult>" });
		const provider = new S3Provider({
			...DEFAULT_S3_SETTINGS,
			endpoint: "s3.example.com",
			accessKeyId: "AK",
			secretAccessKey: "SK",
			bucket: "b",
		});
		await provider.testConnection();
		expect(requestUrl).toHaveBeenCalledTimes(1);
		const req = requestUrl.mock.calls[0][0] as { url: string; method: string };
		expect(req.method).toBe("GET");
		expect(req.url).toContain("max-keys=1");
	});

	it("S3: fails without settings and never sends a request", async () => {
		const provider = new S3Provider({ ...DEFAULT_S3_SETTINGS });
		await expect(provider.testConnection()).rejects.toThrow();
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it("Qiniu: requires the CDN domain, then lists one key", async () => {
		const settings = { ...DEFAULT_QINIU_SETTINGS, accessKey: "AK", secretKey: "SK", bucket: "b", url: "" };
		await expect(new QiniuProvider(settings).testConnection()).rejects.toThrow();
		expect(requestUrl).not.toHaveBeenCalled();

		requestUrl.mockResolvedValue({ status: 200, json: { items: [] } });
		await new QiniuProvider({ ...settings, url: "https://cdn.example.com" }).testConnection();
		expect(requestUrl).toHaveBeenCalledTimes(1);
		expect((requestUrl.mock.calls[0][0] as { url: string }).url).toContain("limit=1");
	});
});
