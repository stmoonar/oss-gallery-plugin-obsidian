/**
 * Read-only transformers.js custom cache backed by the model directory
 * (docs/semantic-search.md §4.3). It maps the pinned Hugging Face resolve URLs
 * (`https://huggingface.co/<model>/resolve/<revision>/<file>`) to the on-disk
 * layout written by ModelDownloadManager (`<modelDir>/huggingface.co/...`).
 *
 * Only the files the host listed (already size-checked, hashed at install /
 * verify time) are served. Anything else is a miss, and with
 * `env.allowRemoteModels = false` a miss makes the load fail instead of
 * reaching the network. `put` never writes: the worker does not download.
 *
 * Free of transformers.js and Node imports so it can be unit-tested; the fs
 * functions are injected.
 */
import type { ModelFileRef } from "../protocol";

export interface CacheFs {
	readFile(absPath: string): Promise<Uint8Array>;
	/** Size in bytes, or null when the file does not exist. */
	size(absPath: string): Promise<number | null>;
	join(...parts: string[]): string;
}

export interface FsModelCacheStats {
	hits: string[];
	misses: string[];
	rejectedPuts: number;
}

export interface FsModelCache {
	match(key: string): Promise<Response | undefined>;
	put(key: string, response: Response): Promise<void>;
	readonly stats: FsModelCacheStats;
}

const HTTPS = "https://";
const MAIN_SEGMENT = "/resolve/main/";

export class ModelFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelFileError";
	}
}

/**
 * Local name for a cache key, or null when the key is not an allowed model
 * file. With `revision`, `/resolve/main/` keys are served from the pinned
 * revision: transformers.js 4.3.1 checks whether tokenizer_config.json /
 * preprocessor_config.json exist without passing the caller's revision
 * (get_tokenizer_files / get_processor_files), so those probes always ask
 * for `main`. Only the pinned files exist locally, so it is the same file.
 */
export function cacheKeyToName(key: string, allowed: ReadonlySet<string>, revision?: string): string | null {
	if (typeof key !== "string" || !key.startsWith(HTTPS)) {
		return null;
	}
	let name = key.slice(HTTPS.length).replace(/[?#].*$/, "");
	if (revision && name.includes(MAIN_SEGMENT)) {
		name = name.replace(MAIN_SEGMENT, `/resolve/${revision}/`);
	}
	return allowed.has(name) ? name : null;
}

export function createFsModelCache(
	modelDir: string,
	files: readonly ModelFileRef[],
	fs: CacheFs,
	options: { revision?: string } = {}
): FsModelCache {
	const sizes = new Map(files.map((f) => [f.name, f.size]));
	const allowed = new Set(sizes.keys());
	const stats: FsModelCacheStats = { hits: [], misses: [], rejectedPuts: 0 };

	return {
		stats,
		async match(key: string): Promise<Response | undefined> {
			const name = cacheKeyToName(key, allowed, options.revision);
			if (name === null) {
				stats.misses.push(String(key));
				return undefined;
			}
			const abs = fs.join(modelDir, ...name.split("/"));
			const expected = sizes.get(name);
			const actual = await fs.size(abs);
			if (actual === null) {
				// Listed but gone: fail loudly rather than let the loader treat it as optional.
				throw new ModelFileError(`Model file missing: ${name}`);
			}
			if (actual !== expected) {
				throw new ModelFileError(`Model file has the wrong size: ${name}`);
			}
			const bytes = await fs.readFile(abs);
			stats.hits.push(name);
			return new Response(bytes as Uint8Array<ArrayBuffer>, {
				headers: { "content-length": String(bytes.byteLength) },
			});
		},
		put(): Promise<void> {
			stats.rejectedPuts++;
			return Promise.resolve();
		},
	};
}
