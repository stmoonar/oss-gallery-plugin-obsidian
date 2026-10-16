import { IOssProvider, OssImage } from "./oss";

export interface ImagePreviewOptions {
	onNavigate?: (direction: "prev" | "next") => void;
}

export interface SyncChanges {
	hasChanges: boolean;
	added: OssImage[];
	deleted: string[];
	modified: OssImage[];
}

/** A ranked semantic result; re-applied to every new listing (docs §7.6). */
export type SemanticResultState =
	| { kind: "semantic"; query: string; hits: { key: string; score: number }[] }
	| { kind: "similar"; key: string; hits: { key: string; score: number }[] };

export interface GalleryState {
	remoteObjects: OssImage[];
	visibleImages: OssImage[];
	isSearching: boolean;
	savedSearchTerm: string;
	useRegexSearch: boolean;
	/** The search box is in semantic mode (per view session). */
	useSemanticSearch: boolean;
	/** Shown semantic / "find similar" result, ranked (null = normal list or text search). */
	semanticResult: SemanticResultState | null;
	/** Key of the image shown in the preview modal (keys survive deletes, indexes do not). */
	currentPreviewKey: string | null;
	isLoading: boolean;
}

export interface LazyImageOptions {
	rootMargin?: string;
	threshold?: number;
	retryCount?: number;
	timeout?: number;
	onImageLoaded?: (img: HTMLImageElement, url: string) => void;
}

export interface ServiceDependencies {
	provider: IOssProvider;
	/** Directory to scope listings to (the global base path), '' for all. */
	listPrefix?: string;
}
