import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getIndexIdentity, INDEX_IDENTITY } from "../../src/providers/indexIdentity";
import { computeScopeId, fingerprint, makeIndexScope } from "../../src/semantic/fingerprint";
import { clearVaultIndex, SizeFs, vaultIdFor, vaultIndexSize } from "../../src/semantic/indexFiles";
import { defaultIndexDir, defaultModelDir, PlatformEnv, resolveIndexDir } from "../../src/semantic/modelDir";
import { SAFE_ID } from "../../src/semantic/VectorStore";
import { DEFAULT_SETTINGS, ProviderSettingsMap } from "../../src/types/settings";
import { makeTempDir, removeDir } from "./helpers";

const WIN: PlatformEnv = { platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, homedir: "C:\\Users\\me" };
const LINUX: PlatformEnv = { platform: "linux", env: {}, homedir: "/home/me" };

describe("index directory", () => {
	it("defaults to <appDir>/indexes next to the models", () => {
		expect(defaultIndexDir(WIN)).toBe("C:\\Users\\me\\AppData\\Local\\obsidian-oss-gallery\\indexes");
		expect(path.win32.dirname(defaultIndexDir(WIN))).toBe(path.win32.dirname(defaultModelDir(WIN)));
		expect(defaultIndexDir(LINUX)).toBe("/home/me/.cache/obsidian-oss-gallery/indexes");
	});

	it("resolves '' to the default, expands ~ and rejects relative paths", () => {
		expect(resolveIndexDir("", LINUX)).toEqual({ ok: true, dir: defaultIndexDir(LINUX), isDefault: true });
		expect(resolveIndexDir("~/idx", LINUX)).toEqual({ ok: true, dir: "/home/me/idx", isDefault: false });
		expect(resolveIndexDir(" D:\\idx ", WIN)).toEqual({ ok: true, dir: "D:\\idx", isDefault: false });
		expect(resolveIndexDir("idx", LINUX)).toEqual({ ok: false, error: "relative-path" });
	});
});

describe("vaultIdFor", () => {
	it("uses app.appId when it is a usable string", () => {
		expect(vaultIdFor("a1b2c3d4e5f60718", "/v")).toBe("a1b2c3d4e5f60718");
	});

	it("sanitizes appId to [A-Za-z0-9_-] and caps the length", () => {
		expect(vaultIdFor("my vault/../x", "/v")).toBe("my_vault____x");
		expect(vaultIdFor("x".repeat(100), "/v")).toHaveLength(64);
	});

	it("falls back to a hash of the vault path", () => {
		const a = vaultIdFor(undefined, "/home/me/Vault");
		expect(a).toMatch(/^v[0-9a-f]{16}$/);
		expect(vaultIdFor(42, "/home/me/Vault")).toBe(a);
		expect(vaultIdFor("../..", "/home/me/Vault")).toBe(a);
		expect(vaultIdFor("", "/home/me/Vault")).toBe(a);
		expect(vaultIdFor(undefined, "/home/me/Other")).not.toBe(a);
		for (const id of [a, vaultIdFor("my vault/../x", "/v")]) {
			expect(SAFE_ID.test(id)).toBe(true);
		}
	});
});

describe("clearVaultIndex", () => {
	let root: string;
	beforeEach(() => {
		root = makeTempDir("idx-clear-");
	});
	afterEach(() => {
		removeDir(root);
	});

	function write(rel: string, data = "x"): void {
		const file = path.join(root, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, data);
	}

	it("deletes only index files of this vault and then empty directories", () => {
		write("vaultA/scope1/meta.json");
		write("vaultA/scope1/vectors.bin");
		write("vaultA/scope1/status.json");
		write("vaultA/scope1/meta.json.a3.tmp");
		write("vaultA/scope2/meta.json");
		write("vaultA/scope2/notes.txt");
		write("vaultA/readme.md");
		write("vaultA/not a scope/meta.json");
		write("vaultB/scope1/meta.json");
		write("models/config.json");

		const r = clearVaultIndex(root, "vaultA");
		expect(r.deleted).toBe(5);
		expect(r.failed).toEqual([]);
		expect(fs.existsSync(path.join(root, "vaultA", "scope1"))).toBe(false);
		expect(fs.existsSync(path.join(root, "vaultA", "scope2", "notes.txt"))).toBe(true);
		expect(fs.existsSync(path.join(root, "vaultA", "scope2", "meta.json"))).toBe(false);
		expect(fs.existsSync(path.join(root, "vaultA", "readme.md"))).toBe(true);
		expect(fs.existsSync(path.join(root, "vaultA", "not a scope", "meta.json"))).toBe(true);
		expect(fs.existsSync(path.join(root, "vaultB", "scope1", "meta.json"))).toBe(true);
		expect(fs.existsSync(path.join(root, "models", "config.json"))).toBe(true);
	});

	it("removes the vault folder when it ends up empty, never the root", () => {
		write("vaultA/scope1/meta.json");
		clearVaultIndex(root, "vaultA");
		expect(fs.existsSync(path.join(root, "vaultA"))).toBe(false);
		expect(fs.existsSync(root)).toBe(true);
	});

	it("is a no-op for a missing folder and rejects unsafe vault ids", () => {
		expect(clearVaultIndex(root, "nothing")).toEqual({ deleted: 0, failed: [], kept: 0 });
		expect(() => clearVaultIndex(root, "..")).toThrow(/Invalid vault id/);
		expect(() => clearVaultIndex(root, "")).toThrow(/Invalid vault id/);
	});
});

describe("vaultIndexSize", () => {
	let root: string;
	beforeEach(() => {
		root = makeTempDir("idx-size-");
	});
	afterEach(() => {
		removeDir(root);
	});

	function write(rel: string, bytes: number): void {
		const file = path.join(root, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, Buffer.alloc(bytes));
	}

	it("counts exactly the files that clearing would delete", () => {
		write("vaultA/scope1/meta.json", 100);
		write("vaultA/scope1/vectors.bin", 4000);
		write("vaultA/scope1/status.json", 50);
		write("vaultA/scope1/meta.json.a3.tmp", 7);
		write("vaultA/scope1/notes.txt", 999);
		write("vaultA/scope2/vectors.bin", 300);
		write("vaultA/readme.md", 999);
		write("vaultA/not a scope/meta.json", 999);
		write("vaultA/other/notes.txt", 999);
		write("vaultB/scope1/vectors.bin", 999);

		const size = vaultIndexSize(root, "vaultA");
		expect(size.byScope).toEqual({ scope1: 4157, scope2: 300 });
		expect(size.total).toBe(4457);

		// Clearing frees what was counted, and the count drops to zero.
		const cleared = clearVaultIndex(root, "vaultA");
		expect(cleared.deleted).toBe(5);
		expect(vaultIndexSize(root, "vaultA")).toEqual({ total: 0, byScope: {} });
	});

	it("is empty for a missing vault folder and rejects unsafe vault ids", () => {
		expect(vaultIndexSize(root, "nothing")).toEqual({ total: 0, byScope: {} });
		expect(() => vaultIndexSize(root, "..")).toThrow(/Invalid vault id/);
	});

	it("skips symlinks and entries that vanish while counting (injected fs)", () => {
		const p = (...parts: string[]) => path.join("r", ...parts);
		const entries: Record<string, { dir?: string[]; size?: number; link?: boolean }> = {
			[p("v")]: { dir: ["s1", "s2"] },
			[p("v", "s1")]: { dir: ["vectors.bin", "meta.json", "status.json"] },
			[p("v", "s1", "vectors.bin")]: { size: 10 },
			[p("v", "s1", "meta.json")]: { size: 5, link: true },
			// status.json is listed but gone by the time it is stat'ed.
			[p("v", "s2")]: { dir: [], link: true },
		};
		const fake: SizeFs = {
			existsSync: (q) => q in entries,
			lstatSync: (q) => {
				const e = entries[q];
				if (!e) throw new Error("ENOENT");
				return {
					isDirectory: () => e.dir !== undefined && !e.link,
					isFile: () => e.size !== undefined && !e.link,
					isSymbolicLink: () => e.link === true,
					size: e.size ?? 0,
				};
			},
			readdirSync: (q) => entries[q]?.dir ?? [],
		};
		expect(vaultIndexSize("r", "v", fake)).toEqual({ total: 10, byScope: { s1: 10 } });
	});
});

describe("scope id (§4.6)", () => {
	it("is stable, order-independent and 16 hex chars", () => {
		const a = computeScopeId("s3", { bucket: "b", endpoint: "e" }, "img/");
		expect(a).toMatch(/^[0-9a-f]{16}$/);
		expect(computeScopeId("s3", { endpoint: "e", bucket: "b" }, "img/")).toBe(a);
		expect(computeScopeId("s3", { bucket: "b", endpoint: "e" }, "")).not.toBe(a);
		expect(computeScopeId("r2", { bucket: "b", endpoint: "e" }, "img/")).not.toBe(a);
		expect(makeIndexScope("local", {}, "").local).toBe(true);
		expect(makeIndexScope("s3", {}, "").local).toBe(false);
	});

	it("never includes credentials and ignores credential changes", () => {
		const secrets = ["SECRETKEY123", "ghp_tokenvalue", "passw0rd!", "AKIAEXAMPLE", "smms-token"];
		const providers = DEFAULT_SETTINGS.providers;
		const withSecrets: ProviderSettingsMap = {
			...providers,
			s3: { ...providers.s3, bucket: "b", endpoint: "e", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "SECRETKEY123" },
			r2: { ...providers.r2, bucket: "b", accountId: "acc", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "SECRETKEY123" },
			minio: { ...providers.minio, bucket: "b", accessKey: "AKIAEXAMPLE", secretKey: "SECRETKEY123" },
			aliyun: { ...providers.aliyun, bucket: "b", accessKeyId: "AKIAEXAMPLE", accessKeySecret: "SECRETKEY123" },
			tencent: { ...providers.tencent, bucket: "b", secretId: "AKIAEXAMPLE", secretKey: "SECRETKEY123" },
			qiniu: { ...providers.qiniu, bucket: "b", accessKey: "AKIAEXAMPLE", secretKey: "SECRETKEY123" },
			upyun: { ...providers.upyun, bucket: "b", operator: "op", password: "passw0rd!" },
			github: { ...providers.github, repo: "me/Repo", token: "ghp_tokenvalue" },
			smms: { token: "smms-token" },
			local: { ...providers.local, storagePath: "/attachments/" },
		};
		for (const id of Object.keys(INDEX_IDENTITY) as Array<keyof ProviderSettingsMap>) {
			const identity = getIndexIdentity(id, withSecrets[id]);
			expect(identity).not.toBeNull();
			const json = JSON.stringify(identity);
			for (const secret of secrets) {
				expect(json).not.toContain(secret);
			}
			// Changing credentials keeps the scope.
			const rotated = JSON.parse(JSON.stringify(withSecrets[id]).split("SECRETKEY123").join("OTHER").split("ghp_tokenvalue").join("ghp_x")) as never;
			expect(computeScopeId(id, getIndexIdentity(id, rotated) ?? {}, "")).toBe(computeScopeId(id, identity ?? {}, ""));
		}
		expect(getIndexIdentity("imgur", providers.imgur)).toBeNull();
		expect(getIndexIdentity("local", withSecrets.local)).toEqual({ storagePath: "attachments", useRelativePath: true });
		expect(getIndexIdentity("github", withSecrets.github)).toEqual({ repo: "me/repo", branch: providers.github.branch });
	});

	it("fingerprint prefers the etag, else size + lastModified", () => {
		expect(fingerprint({ key: "k", url: "", size: 5, etag: "\"abc\"" })).toBe("e:\"abc\"");
		expect(fingerprint({ key: "k", url: "", size: 5, lastModified: new Date(1000) })).toBe("s:5:1000");
		expect(fingerprint({ key: "k", url: "", size: 5 })).toBe("s:5:0");
	});
});
