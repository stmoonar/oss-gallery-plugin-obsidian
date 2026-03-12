import { setIcon } from "obsidian";
import { t } from "../i18n";

export interface SearchComponentOptions {
	onSearch: (searchText: string) => void;
	onToggleRegex?: (enabled: boolean) => void;
	placeholder?: string;
}

export class SearchComponent {
	private container: HTMLElement;
	private searchInput: HTMLInputElement;
	private searchBtn: HTMLButtonElement;
	private regexBtn: HTMLButtonElement | null = null;
	private useRegex: boolean = false;

	constructor(container: HTMLElement, options: SearchComponentOptions) {
		this.container = container;
		this.createComponent(options);
	}

	/**
	 * 创建搜索组件
	 */
	private createComponent(options: SearchComponentOptions): void {
		// 创建搜索容器
		const searchContainer = this.container.createEl("div", {
			cls: "search-container",
		});

		// 创建搜索框包装器
		const searchInputWrapper = searchContainer.createEl("div", {
			cls: "search-input-wrapper",
		});

		// 创建搜索输入框
		this.searchInput = searchInputWrapper.createEl("input", {
			cls: "oss-gallery-search",
			attr: {
				type: "text",
				placeholder: options.placeholder || "Search by URL...",
			},
		});

		// 创建正则表达式切换按钮
		this.regexBtn = searchInputWrapper.createEl("button", {
			cls: "oss-gallery-icon-btn clickable-icon regex-btn-inline",
			attr: {
				title: t("Toggle regex search"),
				type: "button",
			},
		});
		setIcon(this.regexBtn, "regex");

		// 创建搜索按钮
		this.searchBtn = searchContainer.createEl("button", {
			cls: "oss-gallery-icon-btn mod-cta search-btn",
		});
		setIcon(this.searchBtn, "search");

		// 绑定事件
		this.bindEvents(options);
	}

	/**
	 * 绑定事件
	 */
	private bindEvents(options: SearchComponentOptions): void {
		// 搜索框键盘事件
		this.searchInput.onkeydown = (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				options.onSearch(this.searchInput.value);
			} else if (e.key === "Escape") {
				if (this.searchInput.value) {
					this.searchInput.value = "";
				}
			}
		};

		// 搜索按钮点击事件
		this.searchBtn.onclick = () => {
			options.onSearch(this.searchInput.value);
		};

		// 正则表达式切换按钮事件
		if (this.regexBtn && options.onToggleRegex) {
			this.regexBtn.onclick = (e) => {
				e.preventDefault();
				this.toggleRegex();
				options.onToggleRegex?.(this.useRegex);
			};
		}
	}

	/**
	 * 切换正则表达式模式
	 */
	private toggleRegex(): void {
		this.useRegex = !this.useRegex;
		if (this.useRegex) {
			this.regexBtn?.addClass("active");
			this.regexBtn?.addClass("mod-cta");
		} else {
			this.regexBtn?.removeClass("active");
			this.regexBtn?.removeClass("mod-cta");
		}
	}

	/**
	 * 获取搜索文本
	 */
	getValue(): string {
		return this.searchInput.value;
	}

	/**
	 * 设置搜索文本
	 */
	setValue(value: string): void {
		this.searchInput.value = value;
	}

	/**
	 * 清空搜索框
	 */
	clear(): void {
		this.searchInput.value = "";
	}

	/**
	 * 获取是否使用正则表达式
	 */
	isRegexEnabled(): boolean {
		return this.useRegex;
	}

	/**
	 * 设置正则表达式模式
	 */
	setRegexEnabled(enabled: boolean): void {
		this.useRegex = enabled;
		if (enabled) {
			this.regexBtn?.addClass("active");
			this.regexBtn?.addClass("mod-cta");
		} else {
			this.regexBtn?.removeClass("active");
			this.regexBtn?.removeClass("mod-cta");
		}
	}

	/**
	 * 聚焦到搜索框
	 */
	focus(): void {
		this.searchInput.focus();
	}

	/**
	 * 销毁组件
	 */
	destroy(): void {
		// 移除事件监听器
		this.searchInput.onkeydown = null;
		this.searchBtn.onclick = null;
		if (this.regexBtn) {
			this.regexBtn.onclick = null;
		}

		// 移除元素
		this.container.remove();
	}
}
