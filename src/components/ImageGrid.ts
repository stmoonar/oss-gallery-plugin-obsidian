import { Notice, setIcon } from "obsidian";
import { t } from "../i18n";
import { LazyImageService } from "../services/LazyImageService";
import { OssImage } from "../types/oss";

export class ImageGrid {
	private lazyImageService: LazyImageService;
	private imageElements: Set<HTMLImageElement> = new Set();
	private static readonly MAX_DISPLAY_DIMENSION = 4096;
	private static readonly MAX_PIXEL_COUNT = 12_000_000;

	constructor(
		private container: HTMLElement,
		private options: {
			getObjectUrl: (objectName: string) => Promise<string>;
			canDelete?: boolean;
			onPreview?: (index: number) => void;
			onCopy?: (url: string) => void;
			onDelete?: (objectName: string, element: HTMLElement) => void;
		}
	) {
		this.lazyImageService = new LazyImageService({
			onImageLoaded: (img) => {
				this.optimizeLargeImage(img).catch((err) => {
					console.warn("Optimize image failed", err);
				});
			},
		});
	}

	async renderImages(objects: OssImage[], batchSize = 10): Promise<void> {
		this.cleanup();

		for (let i = 0; i < objects.length; i += batchSize) {
			const batch = objects.slice(i, i + batchSize);
			await Promise.all(
				batch.map((obj, idx) => this.renderImageItem(obj.key, i + idx))
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	private async renderImageItem(
		objectName: string,
		imageIndex: number
	): Promise<void> {
		const objectUrl = await this.options.getObjectUrl(objectName);

		const imgDiv = this.container.createEl("div", {
			cls: "minio-gallery-item",
		});

		const img = imgDiv.createEl("img", {
			attr: {
				"data-src": objectUrl,
				src: this.getPlaceholderUrl(),
				loading: "lazy",
				alt: objectName,
				decoding: "async",
				crossorigin: "anonymous",
			},
		});
		img.dataset.originalUrl = objectUrl;

		this.imageElements.add(img);
		this.lazyImageService.observe(img);

		img.onclick = () => {
			this.options.onPreview?.(imageIndex);
		};

		const buttonContainer = imgDiv.createEl("div", {
			cls: "minio-gallery-buttons",
		});

		this.createCopyButton(buttonContainer, objectUrl);
		if (this.options.canDelete !== false) {
			this.createDeleteButton(buttonContainer, objectName, imgDiv);
		}
	}

	private async optimizeLargeImage(img: HTMLImageElement): Promise<void> {
		if (img.dataset.optimized === "true") return;

		const naturalWidth = img.naturalWidth;
		const naturalHeight = img.naturalHeight;
		if (!naturalWidth || !naturalHeight) return;

		const largestSide = Math.max(naturalWidth, naturalHeight);
		const pixelCount = naturalWidth * naturalHeight;
		if (
			largestSide <= ImageGrid.MAX_DISPLAY_DIMENSION &&
			pixelCount <= ImageGrid.MAX_PIXEL_COUNT
		) {
			return;
		}

		if (typeof createImageBitmap !== "function") {
			return;
		}

		const dimensionScale = ImageGrid.MAX_DISPLAY_DIMENSION / largestSide;
		const pixelScale = Math.sqrt(ImageGrid.MAX_PIXEL_COUNT / pixelCount);
		const scale = Math.min(1, dimensionScale, pixelScale);
		if (scale >= 1) {
			return;
		}

		const targetWidth = Math.max(1, Math.round(naturalWidth * scale));
		const targetHeight = Math.max(1, Math.round(naturalHeight * scale));

		try {
			const bitmap = await createImageBitmap(img, {
				resizeWidth: targetWidth,
				resizeHeight: targetHeight,
				resizeQuality: "high",
			});

			const canvas = document.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				bitmap.close();
				return;
			}

			ctx.drawImage(bitmap, 0, 0);
			bitmap.close();

			img.src = canvas.toDataURL("image/jpeg", 0.85);
			img.dataset.optimized = "true";
		} catch (error) {
			console.warn("Downscale large image failed", error);
		}
	}

	private createCopyButton(container: HTMLElement, url: string): void {
		const copyBtn = container.createEl("button", {
			cls: "minio-gallery-icon-btn copy-btn",
		});
		setIcon(copyBtn, "copy");

		copyBtn.onclick = async () => {
			await navigator.clipboard.writeText(url);
			new Notice(t("URL copied"));
			this.options.onCopy?.(url);
		};
	}

	private createDeleteButton(
		container: HTMLElement,
		objectName: string,
		imgDiv: HTMLElement
	): void {
		const deleteBtn = container.createEl("button", {
			cls: "minio-gallery-icon-btn delete-btn",
		});
		setIcon(deleteBtn, "trash");

		deleteBtn.onclick = async () => {
			this.options.onDelete?.(objectName, imgDiv);
		};
	}

	private getPlaceholderUrl(): string {
		return (
			"data:image/svg+xml;base64," +
			btoa(`
	            <svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
	                <rect width="100" height="100" fill="#ccc"/>
	                <text x="50" y="50" text-anchor="middle" dy=".3em" fill="#666" font-size="12">Loading...</text>
	            </svg>
	        `)
		);
	}

	private cleanup(): void {
		this.container.empty();
		this.imageElements.forEach((img) => {
			this.lazyImageService.unobserve(img);
		});
		this.lazyImageService.cleanup();
		this.imageElements.clear();
	}

	destroy(): void {
		this.cleanup();
		this.lazyImageService.destroy();
	}

	getImageCount(): number {
		return this.imageElements.size;
	}
}
