/**
 * Semantic search over a scope's index (docs/semantic-search.md §4.7, §7.6).
 *
 * - Text: the query worker (text model only, D12) embeds the query; the
 *   store ranks by dot product. The worker stays warm for 5 minutes.
 * - Similar: uses the stored vector of an indexed image, no worker.
 * Results are always restricted to `remote` (the objects currently listed),
 * and tombstoned entries never appear, so a lagging index can never show a
 * deleted image.
 */
import type { OssImage } from "../types/oss";
import type { EmbeddingBackend } from "./EmbeddingBackend";
import type { IndexScope } from "./fingerprint";
import type { EmbeddingConfig } from "./protocol";
import type { VectorStore } from "./VectorStore";

export interface SemanticHit {
	object: OssImage;
	score: number;
}

export interface SearchServiceDeps {
	/** Open the scope's store for reading; null when there is no index. */
	getStore(scope: IndexScope): VectorStore | null;
	/** A fresh query-mode backend (not initialized), or null. */
	createQueryBackend(): EmbeddingBackend | null;
	embeddingConfig(): EmbeddingConfig;
}

export class SemanticSearchService {
	private backend: EmbeddingBackend | null = null;
	private backendInit: Promise<unknown> | null = null;
	private backendBudget: number | null = null;
	private backendReady = false;

	constructor(private readonly deps: SearchServiceDeps) {}

	private async queryBackend(): Promise<EmbeddingBackend> {
		const cfg = this.deps.embeddingConfig();
		if (this.backend && this.backendBudget !== cfg.imageTokenBudget) {
			this.dispose();
		}
		if (!this.backend) {
			const backend = this.deps.createQueryBackend();
			if (!backend) {
				throw new Error("Semantic search is not available");
			}
			this.backend = backend;
			this.backendBudget = cfg.imageTokenBudget;
			this.backendInit = backend.init("query", cfg);
		}
		const backend = this.backend;
		try {
			await this.backendInit;
			if (this.backend === backend) {
				this.backendReady = true;
			}
		} catch (error) {
			if (this.backend === backend) {
				this.dispose();
			}
			throw error;
		}
		return backend;
	}

	private rank(store: VectorStore, query: ArrayLike<number>, remote: OssImage[], k: number, exclude?: string): SemanticHit[] {
		const byKey = new Map(remote.map((o) => [o.key, o]));
		const allow = (key: string): boolean => key !== exclude && byKey.has(key);
		return store.search(query, k, allow).flatMap((hit) => {
			const object = byKey.get(hit.key);
			return object ? [{ object, score: hit.score }] : [];
		});
	}

	/** Rank `remote` objects by similarity to `text` (top `k`, default all). */
	async searchByTextScored(scope: IndexScope, text: string, remote: OssImage[], k = remote.length): Promise<SemanticHit[]> {
		const store = this.deps.getStore(scope);
		if (!store || text.trim() === "") {
			return [];
		}
		const backend = await this.queryBackend();
		let vector: Float32Array;
		try {
			[vector] = await backend.embedText([text.trim()]);
		} catch (error) {
			// e.g. the worker was terminated from outside: start fresh next time.
			if (this.backend === backend) {
				this.dispose();
			}
			throw error;
		}
		return this.rank(store, vector, remote, k);
	}

	async searchByText(scope: IndexScope, text: string, remote: OssImage[], k?: number): Promise<OssImage[]> {
		return (await this.searchByTextScored(scope, text, remote, k)).map((h) => h.object);
	}

	/** Objects similar to the indexed image `key` (itself excluded). Empty when it isn't indexed. */
	searchSimilarScored(scope: IndexScope, key: string, remote: OssImage[], k = remote.length): SemanticHit[] {
		const store = this.deps.getStore(scope);
		const entry = store?.get(key);
		if (!store || !entry || entry.missingSince !== undefined) {
			return [];
		}
		return this.rank(store, entry.vec, remote, k, key);
	}

	searchSimilar(scope: IndexScope, key: string, remote: OssImage[], k?: number): OssImage[] {
		return this.searchSimilarScored(scope, key, remote, k).map((h) => h.object);
	}

	/**
	 * Is the query worker loaded? A cold query first starts the worker and
	 * loads the text model (~1.5 s), which the UI announces. Backends that
	 * recycle themselves when idle report it through `isRunning()`.
	 */
	isWarm(): boolean {
		const backend = this.backend;
		if (!backend || !this.backendReady) {
			return false;
		}
		return "isRunning" in backend && typeof backend.isRunning === "function"
			? Boolean((backend.isRunning as () => unknown).call(backend))
			: true;
	}

	/** Terminate the query worker (D13). The next search starts a new one. */
	dispose(): void {
		const backend = this.backend;
		this.backend = null;
		this.backendInit = null;
		this.backendBudget = null;
		this.backendReady = false;
		if (backend) {
			void backend.dispose();
		}
	}
}
