import { OssImage } from "../types/oss";
import { LazyImageService } from "../services/LazyImageService";
import { Notice, setIcon } from "obsidian";
import { t } from "../i18n";

export class ImageGrid {
	private lazyImageService: LazyImageService;
	private imageElements: Set<HTMLImageElement> = new Set();
	private static readonly MAX_DISPLAY_DIMENSION = 4096;
	private static readonly MAX_PIXEL_COUNT = 12_000_000; // ~12MP upper bound

	constructor(
		private container: HTMLElement,
		private options: {
			getObjectUrl: (objectName: string) => Promise<string>;
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

	/**
	 * 批量渲染图片
	 */
	async renderImages(objects: OssImage[], batchSize = 10): Promise<void> {
		// 清理旧的图片元素
		this.cleanup();

		for (let i = 0; i < objects.length; i += batchSize) {
			const batch = objects.slice(i, i + batchSize);
			await Promise.all(
				batch.map((obj, idx) => this.renderImageItem(obj.key, i + idx))
			);

			// 让出 UI 线程
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	/**
	 * 渲染单个图片项
	 */
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

		// 添加到图片元素集合
		this.imageElements.add(img);

		// 设置懒加载
		this.lazyImageService.observe(img);

		// 点击事件
		img.onclick = () => {
			this.options.onPreview?.(imageIndex);
		};

		// 创建按钮容器
		const buttonContainer = imgDiv.createEl("div", {
			cls: "minio-gallery-buttons",
		});

		// 复制按钮
		this.createCopyButton(buttonContainer, objectUrl);

		// 删除按钮
		this.createDeleteButton(buttonContainer, objectName, imgDiv);
	}

	/**
	 * 对超大图片进行下采样，减少渲染开销
	 */
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

			const optimizedUrl = canvas.toDataURL("image/jpeg", 0.85);
			img.src = optimizedUrl;
			img.dataset.optimized = "true";
		} catch (error) {
			console.warn("Downscale large image failed", error);
		}
	}

	/**
	 * 创建复制按钮
	 */
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

	/**
	 * 创建删除按钮
	 */
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

	/**
	 * 获取占位图 URL
	 */
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

	/**
	 * 清理图片元素
	 */
	private cleanup(): void {
		// 清理容器
		this.container.empty();

		// 停止观察所有图片
		this.imageElements.forEach((img) => {
			this.lazyImageService.unobserve(img);
		});

		// 清理图片元素
		this.lazyImageService.cleanup();
		this.imageElements.clear();
	}

	/**
	 * 销毁组件
	 */
	destroy(): void {
		this.cleanup();
		this.lazyImageService.destroy();
	}

	/**
	 * 获取当前图片元素数量
	 */
	getImageCount(): number {
		return this.imageElements.size;
	}
}
