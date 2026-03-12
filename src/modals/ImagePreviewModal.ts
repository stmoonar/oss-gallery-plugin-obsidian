import { App, Modal, setIcon } from "obsidian";
import { ImagePreviewOptions } from "../types/gallery";

interface PreviewTheme {
	background: string;
	textColor: string;
	textShadow: string;
}

export class ImagePreviewModal extends Modal {
	private imageUrl: string;
	private fileName: string;
	private container: HTMLElement;
	private imgElement: HTMLImageElement | null = null;
	private placeholderElement: HTMLElement | null = null;
	private pathElement: HTMLElement | null = null;
	private onNavigate?: (direction: "prev" | "next") => void;
	private isUpdating: boolean = false;
	private currentTheme: "dark" | "light" = "dark";
	private pendingUpdate: { url: string; fileName?: string } | null = null;
	private loadingSpinner: HTMLElement | null = null;
	private loadingTimer: number | null = null;
	private isLoadingShown: boolean = false;
	private originalImgSrc: string | null = null;
	private static readonly LOADING_DELAY = 500; // 500ms阈值

	// 主题配置
	private readonly themes: Record<string, PreviewTheme> = {
		dark: {
			background: "var(--minio-preview-overlay-bg)",
			textColor: "white",
			textShadow: "0 1px 3px rgba(0, 0, 0, 0.8)",
		},
		light: {
			background: "rgba(255, 255, 255, 0.95)",
			textColor: "black",
			textShadow: "0 1px 3px rgba(255, 255, 255, 0.8)",
		},
	};

	constructor(
		app: App,
		imageUrl: string,
		fileName: string,
		options?: ImagePreviewOptions
	) {
		super(app);
		this.imageUrl = imageUrl;
		this.fileName = fileName;
		this.onNavigate = options?.onNavigate;

		// 初始化时移除默认样式
		this.setupModalStyle();
	}

	/**
	 * 设置模态框样式
	 */
	private setupModalStyle(): void {
		requestAnimationFrame(() => {
			const modalEl = this.modalEl;
			modalEl.style.border = "none";
			modalEl.style.background = "transparent";
			modalEl.style.boxShadow = "none";
			modalEl.style.padding = "0";

			// 移除默认关闭按钮
			const closeBtn = modalEl.querySelector(
				".modal-close-button"
			) as HTMLElement;
			closeBtn?.remove();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("minio-image-preview-modal-content");

		// 创建主容器
		this.container = contentEl.createDiv({
			cls: "minio-image-preview-container",
		});

		// 创建控制栏
		this.createControlBar();

		// 创建占位符
		this.createPlaceholder();

		// 创建图片元素
		this.createImageElement(); // 绑定事件
		this.bindEvents();

		// 显示动画
		this.showAnimation();

		// 初始加载图片
		this.updateImage(this.imageUrl, this.fileName);
	}

	/**
	 * 创建控制栏
	 */
	private createControlBar(): void {
		const controlBar = this.container.createEl("div", {
			cls: "minio-preview-control-bar",
		});

		// 主题切换按钮
		const themeToggleBtn = controlBar.createEl("button", {
			cls: "minio-preview-toggle-bg-btn",
		});
		setIcon(themeToggleBtn, this.currentTheme === "dark" ? "sun" : "moon");
		themeToggleBtn.title = "Toggle background";

		themeToggleBtn.onclick = (e) => {
			e.stopPropagation();
			this.toggleTheme();
			setIcon(
				themeToggleBtn,
				this.currentTheme === "dark" ? "sun" : "moon"
			);
		};

		// 路径显示
		this.pathElement = controlBar.createEl("div", {
			cls: "minio-preview-path",
			text: this.formatUrlToPath(this.imageUrl),
		});

		// 应用当前主题
		this.applyTheme(this.currentTheme);
	}

	private formatUrlToPath(url: string): string {
		try {
			const urlObj = new URL(url);
			return decodeURIComponent(urlObj.pathname).substring(1); // 去掉开头的 /
		} catch {
			return url;
		}
	}

	/**
	 * 创建占位符
	 */
	private createPlaceholder(): void {
		this.placeholderElement = this.container.createEl("div", {
			cls: "minio-preview-placeholder",
		});

		// 使用更美观的图片图标
		this.placeholderElement.innerHTML = `
			<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
			</svg>
		`;

		this.placeholderElement.style.display = "none";
	}

	/**
	 * 创建图片元素
	 */
	private createImageElement(): void {
		this.imgElement = this.container.createEl("img", {
			cls: "minio-image-preview",
			attr: {
				// src: this.imageUrl, // 移除初始 src，由 updateImage 统一处理
				alt: "Preview",
			},
		});

		// 阻止图片点击事件冒泡
		this.imgElement.onclick = (e) => e.stopPropagation();

		// 错误处理
		this.imgElement.onerror = () => {
			// 忽略空 src 的错误
			if (this.imgElement?.getAttribute("src")) {
				console.error("Failed to load preview image:", this.imageUrl);
			}
		};

		this.imgElement.onload = () => {
			console.log("Preview image loaded successfully:", this.imageUrl);
		};
	}

	/**
	 * 绑定事件
	 */
	private bindEvents(): void {
		// 点击背景关闭
		this.container.onclick = () => this.close();

		// 键盘快捷键
		this.scope.register([], "Escape", () => this.close());

		if (this.onNavigate) {
			this.scope.register([], "ArrowLeft", () =>
				this.onNavigate?.("prev")
			);
			this.scope.register([], "ArrowRight", () =>
				this.onNavigate?.("next")
			);
		}
	}

	/**
	 * 显示动画
	 */
	private showAnimation(): void {
		requestAnimationFrame(() => {
			this.container.classList.add("show");
		});
	}

	/**
	 * 处理图片加载错误
	 */
	private handleImageError(): void {
		// 清除所有错误消息
		this.hideErrorMessages();

		// 不要恢复原始图片，保留背景图案
		// if (this.imgElement && this.originalImgSrc) {
		//     this.imgElement.src = this.originalImgSrc;
		//     this.imgElement.style.display = '';
		//     this.imgElement.style.background = '';
		// }

		// 隐藏加载动画
		this.hideLoadingSpinner();

		// 创建错误提示元素
		const errorContainer = this.container.createEl("div", {
			cls: "minio-preview-error",
		});

		errorContainer.innerHTML = `
            <div class="error-icon">⚠️</div>
            <div class="error-message">Failed to load image</div>
            <div class="error-url">${this.imageUrl}</div>
        `;

		this.container.appendChild(errorContainer);

		// 3秒后自动隐藏错误消息
		setTimeout(() => {
			if (errorContainer && errorContainer.parentNode) {
				errorContainer.remove();
			}
		}, 3000);
	}

	/**
	 * 切换主题
	 */
	private toggleTheme(): void {
		this.currentTheme = this.currentTheme === "dark" ? "light" : "dark";
		this.applyTheme(this.currentTheme);
	}

	/**
	 * 应用主题
	 */
	private applyTheme(theme: "dark" | "light"): void {
		const themeConfig = this.themes[theme];

		this.container.style.background = themeConfig.background;

		// 切换 class 以应用特定主题的样式
		this.container.removeClass("dark");
		this.container.removeClass("light");
		this.container.addClass(theme);
	}

	/**
	 * 更新图片
	 */
	updateImage(newUrl: string, newFileName?: string): void {
		// 立即清除之前的错误信息和加载状态
		this.hideErrorMessages();
		this.hideLoadingSpinner();

		// 如果正在更新，保存最新的更新请求
		if (this.isUpdating) {
			this.pendingUpdate = { url: newUrl, fileName: newFileName };
			return;
		}

		if (!this.imgElement) return;

		this.imageUrl = newUrl;
		this.isUpdating = true;

		// 更新文件名（即使不显示也保存）
		if (newFileName) {
			this.fileName = newFileName;
		}

		// 立即更新路径显示
		if (this.pathElement) {
			this.pathElement.textContent = this.formatUrlToPath(newUrl);
		}

		// 延迟显示加载动画
		{
			// 保存原始图片
			this.originalImgSrc = this.imgElement?.src || null;
			this.isLoadingShown = false;

			// 切换到占位符显示
			if (this.imgElement) {
				this.imgElement.style.display = "none";
				this.imgElement.removeAttribute("src");
			}

			if (this.placeholderElement) {
				this.placeholderElement.style.display = "flex";
			}

			// 设置延迟显示加载动画（在背景图案之上）
			this.loadingTimer = window.setTimeout(() => {
				this.showLoadingSpinner();
				this.isLoadingShown = true;
			}, ImagePreviewModal.LOADING_DELAY);

			// 预加载新图片
			const tempImg = new Image();
			tempImg.onload = () => {
				// 清除延迟计时器
				if (this.loadingTimer) {
					clearTimeout(this.loadingTimer);
					this.loadingTimer = null;
				}

				// 恢复图片显示
				if (this.placeholderElement) {
					this.placeholderElement.style.display = "none";
				}

				if (this.imgElement) {
					this.imgElement.style.display = "block";
					this.imgElement.src = newUrl;
				}

				this.hideLoadingSpinner();
				this.isUpdating = false;
				this.isLoadingShown = false;
				this.checkPendingUpdate();
			};

			tempImg.onerror = () => {
				// 清除延迟计时器
				if (this.loadingTimer) {
					clearTimeout(this.loadingTimer);
					this.loadingTimer = null;
				}

				// 保持占位符显示，或者显示错误状态
				// 这里我们保持占位符，并显示错误信息

				this.hideLoadingSpinner();
				this.handleImageError();
				this.isUpdating = false;
				this.isLoadingShown = false;
				this.checkPendingUpdate();
			};

			// 开始加载新图片
			tempImg.src = newUrl;
		}
	}

	/**
	 * 显示加载动画
	 */
	private showLoadingSpinner(): void {
		if (!this.loadingSpinner) {
			this.loadingSpinner = this.container.createEl("div", {
				cls: "minio-preview-loading",
			});
			this.loadingSpinner.innerHTML = `
                <div class="loading-spinner"></div>
                <div class="loading-text">Loading...</div>
            `;
			this.container.appendChild(this.loadingSpinner);
		}

		// 确保只显示一个加载动画
		this.hideErrorMessages();
		this.loadingSpinner.style.display = "flex";
	}

	/**
	 * 隐藏所有错误消息
	 */
	private hideErrorMessages(): void {
		const errorElements = this.container.querySelectorAll(
			".minio-preview-error"
		);
		errorElements.forEach((el) => el.remove());
	}

	/**
	 * 隐藏加载动画
	 */
	private hideLoadingSpinner(): void {
		if (this.loadingSpinner) {
			this.loadingSpinner.style.display = "none";
		}
		this.isLoadingShown = false;
	}

	/**
	 * 检查是否有待处理的更新
	 */
	private checkPendingUpdate(): void {
		if (this.pendingUpdate) {
			const pending = this.pendingUpdate;
			this.pendingUpdate = null;

			// 清理计时器
			if (this.loadingTimer) {
				clearTimeout(this.loadingTimer);
				this.loadingTimer = null;
			}

			// 延迟一点再处理，让当前更新完成
			setTimeout(() => {
				this.updateImage(pending.url, pending.fileName);
			}, 50);
		}
	}

	onClose(): void {
		// 清理计时器
		if (this.loadingTimer) {
			clearTimeout(this.loadingTimer);
			this.loadingTimer = null;
		}

		const { contentEl } = this;
		contentEl.empty();
		this.imgElement = null;
		this.pathElement = null;
		this.loadingSpinner = null;
		// container 不能设置为 null，因为它被其他地方使用
	}
}
