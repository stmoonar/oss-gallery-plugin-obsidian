import { IOssProvider, OssImage } from "./oss";

export interface FileInputEvent extends Event {
	target: HTMLInputElement & {
		files: FileList;
	};
}

export interface ImagePreviewOptions {
	onNavigate?: (direction: "prev" | "next") => void;
}

export interface SearchResult {
	matchedObjects: OssImage[];
	totalCount: number;
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

export interface RenderImageOptions {
	container: HTMLElement;
	objectName: string;
	index: number;
	onPreview?: (index: number) => void;
	onCopy?: (url: string) => void;
	onDelete?: (objectName: string, element: HTMLElement) => void;
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
