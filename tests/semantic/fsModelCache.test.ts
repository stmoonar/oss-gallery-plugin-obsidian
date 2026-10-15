import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_ASSETS, MODEL_ID, MODEL_REVISION } from "../../src/semantic/assets";
import { CacheFs, cacheKeyToName, createFsModelCache, ModelFileError } from "../../src/semantic/worker/fsModelCache";
import { makeTempDir, removeDir } from "./helpers";

const REV = "0123abcd";
const BASE = `huggingface.co/org/model/resolve/${REV}`;
const CONFIG = `${BASE}/config.json`;
const WEIGHTS = `${BASE}/onnx/model_q4.onnx`;
const ALLOWED = new Set([CONFIG, WEIGHTS]);

const nodeCacheFs: CacheFs = {
	readFile: async (p) => new Uint8Array(await fs.promises.readFile(p)),
	size: async (p) => {
		try {
			return (await fs.promises.stat(p)).size;
		} catch {
			return null;
		}
	},
	join: (...parts) => path.join(...parts),
};

describe("cacheKeyToName", () => {
	it("maps an https URL of an allowed file to its local name", () => {
		expect(cacheKeyToName(`https://${CONFIG}`, ALLOWED)).toBe(CONFIG);
		expect(cacheKeyToName(`https://${WEIGHTS}`, ALLOWED)).toBe(WEIGHTS);
	});

	it("strips the query string and fragment", () => {
		expect(cacheKeyToName(`https://${CONFIG}?download=true`, ALLOWED)).toBe(CONFIG);
		expect(cacheKeyToName(`https://${CONFIG}#frag`, ALLOWED)).toBe(CONFIG);
		expect(cacheKeyToName(`https://${CONFIG}?a=1#b`, ALLOWED)).toBe(CONFIG);
	});

	it("returns null for non-allowed files and non-https keys", () => {
		expect(cacheKeyToName(`https://${BASE}/other.json`, ALLOWED)).toBeNull();
		expect(cacheKeyToName(`http://${CONFIG}`, ALLOWED)).toBeNull();
		expect(cacheKeyToName(CONFIG, ALLOWED)).toBeNull();
		expect(cacheKeyToName(`https://evil.example/${CONFIG}`, ALLOWED)).toBeNull();
		expect(cacheKeyToName("", ALLOWED)).toBeNull();
	});

	it("aliases /resolve/main/ to the pinned revision only when a revision is given", () => {
		const mainKey = `https://huggingface.co/org/model/resolve/main/config.json`;
		expect(cacheKeyToName(mainKey, ALLOWED, REV)).toBe(CONFIG);
		expect(cacheKeyToName(mainKey, ALLOWED)).toBeNull();
		expect(cacheKeyToName(mainKey, ALLOWED, "")).toBeNull();
		// Other revisions are not aliased.
		expect(cacheKeyToName(`https://huggingface.co/org/model/resolve/feedbeef/config.json`, ALLOWED, REV)).toBeNull();
		// Non-listed files under main stay misses.
		expect(cacheKeyToName(`https://huggingface.co/org/model/resolve/main/other.json`, ALLOWED, REV)).toBeNull();
		// The pinned key itself still works with a revision.
		expect(cacheKeyToName(`https://${CONFIG}`, ALLOWED, REV)).toBe(CONFIG);
	});

	it("aliases the real model's main probes to MODEL_REVISION", () => {
		const allowed = new Set(MODEL_ASSETS.map((a) => a.name));
		const probe = `https://huggingface.co/${MODEL_ID}/resolve/main/tokenizer_config.json`;
		expect(cacheKeyToName(probe, allowed, MODEL_REVISION)).toBe(
			`huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/tokenizer_config.json`
		);
	});
});

describe("createFsModelCache", () => {
	let modelDir: string;
	const configBytes = new TextEncoder().encode('{"model_type":"test"}');
	const weightBytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252]);

	beforeEach(() => {
		modelDir = makeTempDir("fs-cache-test-");
		for (const [name, bytes] of [[CONFIG, configBytes], [WEIGHTS, weightBytes]] as const) {
			const abs = path.join(modelDir, ...name.split("/"));
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, bytes);
		}
	});

	afterEach(() => {
		removeDir(modelDir);
	});

	function cache(sizes: Partial<Record<string, number>> = {}, revision?: string) {
		return createFsModelCache(
			modelDir,
			[
				{ name: CONFIG, size: sizes[CONFIG] ?? configBytes.length },
				{ name: WEIGHTS, size: sizes[WEIGHTS] ?? weightBytes.length },
			],
			nodeCacheFs,
			revision === undefined ? undefined : { revision }
		);
	}

	it("serves listed files from disk", async () => {
		const c = cache();
		const res = await c.match(`https://${WEIGHTS}?download=1`);
		expect(res).toBeInstanceOf(Response);
		expect(res?.headers.get("content-length")).toBe(String(weightBytes.length));
		const body = new Uint8Array((await res?.arrayBuffer()) ?? new ArrayBuffer(0));
		expect(Array.from(body)).toEqual(Array.from(weightBytes));
		expect(await (await c.match(`https://${CONFIG}`))?.text()).toBe('{"model_type":"test"}');
		expect(c.stats.hits).toEqual([WEIGHTS, CONFIG]);
		expect(c.stats.misses).toEqual([]);
	});

	it("records non-listed keys as misses", async () => {
		const c = cache();
		expect(await c.match(`https://${BASE}/tokenizer.json`)).toBeUndefined();
		expect(await c.match("not a url")).toBeUndefined();
		expect(c.stats.misses).toEqual([`https://${BASE}/tokenizer.json`, "not a url"]);
		expect(c.stats.hits).toEqual([]);
	});

	it("rejects a listed file that is missing on disk", async () => {
		fs.unlinkSync(path.join(modelDir, ...CONFIG.split("/")));
		const c = cache();
		await expect(c.match(`https://${CONFIG}`)).rejects.toBeInstanceOf(ModelFileError);
		await expect(c.match(`https://${CONFIG}`)).rejects.toThrow(/missing/);
	});

	it("rejects a listed file with the wrong size", async () => {
		const c = cache({ [WEIGHTS]: weightBytes.length + 1 });
		await expect(c.match(`https://${WEIGHTS}`)).rejects.toBeInstanceOf(ModelFileError);
		await expect(c.match(`https://${WEIGHTS}`)).rejects.toThrow(/wrong size/);
		expect(c.stats.hits).toEqual([]);
	});

	it("serves /resolve/main/ probes from the pinned revision when configured", async () => {
		const mainKey = "https://huggingface.co/org/model/resolve/main/config.json";
		const pinned = cache({}, REV);
		expect(await (await pinned.match(mainKey))?.text()).toBe('{"model_type":"test"}');
		expect(pinned.stats.hits).toEqual([CONFIG]);

		const plain = cache();
		expect(await plain.match(mainKey)).toBeUndefined();
		expect(plain.stats.misses).toEqual([mainKey]);
	});

	it("never writes on put", async () => {
		const c = cache();
		const target = `https://${BASE}/new-file.json`;
		await expect(c.put(target, new Response("data"))).resolves.toBeUndefined();
		await c.put(`https://${CONFIG}`, new Response("overwrite?"));
		expect(c.stats.rejectedPuts).toBe(2);
		expect(fs.existsSync(path.join(modelDir, ...`${BASE}/new-file.json`.split("/")))).toBe(false);
		expect(fs.readFileSync(path.join(modelDir, ...CONFIG.split("/")), "utf8")).toBe('{"model_type":"test"}');
	});
});
