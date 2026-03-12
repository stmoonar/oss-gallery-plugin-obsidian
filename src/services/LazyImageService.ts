import { LazyImageOptions } from "../types/gallery";

export class LazyImageService {
	private observer: IntersectionObserver;
	private imageElements: Set<HTMLImageElement> = new Set();
	private options: Required<
		Pick<
			LazyImageOptions,
			"rootMargin" | "threshold" | "retryCount" | "timeout"
		>
	> &
		LazyImageOptions;

	constructor(options: LazyImageOptions = {}) {
		this.options = {
			rootMargin: options.rootMargin ?? "50px",
			threshold: options.threshold ?? 0.1,
			retryCount: options.retryCount ?? 3,
			timeout: options.timeout ?? 8000,
			onImageLoaded: options.onImageLoaded,
		};

		const { rootMargin, threshold } = this.options;

		this.observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						const img = entry.target as HTMLImageElement;
						const src = img.dataset.src;

						if (src && img.src !== src) {
							void this.loadImageWithRetry(
								src,
								img,
								this.options.retryCount,
								this.options.timeout
							);
							img.removeAttribute("data-src");
							this.observer.unobserve(img);
						}
					}
				});
			},
			{
				rootMargin,
				threshold,
			}
		);
	}

	/**
	 * 观察图片元素
	 */
	observe(img: HTMLImageElement): void {
		if (img.dataset.src) {
			this.imageElements.add(img);

			// 使用 requestIdleCallback 延迟 observe，避免阻塞 UI
			if ("requestIdleCallback" in window) {
				requestIdleCallback(() => {
					if (img.dataset.src) {
						this.observer.observe(img);
					}
				});
			} else {
				setTimeout(() => {
					if (img.dataset.src) {
						this.observer.observe(img);
					}
				}, 0);
			}
		}
	}

	/**
	 * 停止观察图片元素
	 */
	unobserve(img: HTMLImageElement): void {
		this.observer.unobserve(img);
		this.imageElements.delete(img);
	}

	/**
	 * 批量观察图片元素
	 */
	observeAll(
		images: NodeListOf<HTMLImageElement> | HTMLImageElement[]
	): void {
		images.forEach((img) => this.observe(img));
	}

	/**
	 * 带重试机制的图片加载
	 */
	private async loadImageWithRetry(
		url: string,
		img: HTMLImageElement,
		maxRetries: number,
		timeout: number
	): Promise<void> {
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				await this.loadImage(url, img, timeout);
				img.classList.add("loaded");
				this.options.onImageLoaded?.(img, url);
				return;
			} catch (error) {
				if (attempt === maxRetries) {
					img.classList.add("error");
					img.src = this.getPlaceholderUrl();
					console.error(
						"Image load failed after retries:",
						url,
						error
					);
					return;
				}

				// 指数退避
				const delay = Math.min(1000 * Math.pow(2, attempt - 1), 3000);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	/**
	 * 加载图片
	 */
	private loadImage(
		url: string,
		img: HTMLImageElement,
		timeout: number
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				reject(new Error(`Image load timeout: ${url}`));
			}, timeout);

			img.onload = () => {
				clearTimeout(timeoutId);
				resolve();
			};

			img.onerror = () => {
				clearTimeout(timeoutId);
				reject(new Error(`Failed to load image: ${url}`));
			};

			img.src = url;
		});
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
	 * 清理断开的图片元素
	 */
	cleanup(): void {
		this.imageElements.forEach((img) => {
			if (!img.isConnected) {
				this.imageElements.delete(img);
				img.src = ""; // 释放内存
			}
		});
	}

	/**
	 * 销毁服务
	 */
	destroy(): void {
		this.observer.disconnect();
		this.imageElements.clear();
	}
}
