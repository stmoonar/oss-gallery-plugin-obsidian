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

export interface GalleryState {
	remoteObjects: OssImage[];
	visibleImages: OssImage[];
	isSearching: boolean;
	savedSearchTerm: string;
	useRegexSearch: boolean;
	currentPreviewIndex: number | null;
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
}
