import { setIcon } from "obsidian";
import { t } from "../i18n";

export interface SearchComponentOptions {
	onSearch: (searchText: string) => void;
	onToggleRegex?: (enabled: boolean) => void;
	placeholder?: string;
}

export class SearchComponent {
	private container: HTMLElement;
	private searchContainer: HTMLElement;
	private searchInput: HTMLInputElement;
	private clearBtn: HTMLElement;
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
		const searchContainer = this.container.createDiv({
			cls: "oss-gallery-search-container",
		});
		this.searchContainer = searchContainer;

		// 复用 Obsidian 原生的 search-input-container（清除按钮 + 右侧装饰按钮定位）
		const searchInputWrapper = searchContainer.createDiv({
			cls: "search-input-container oss-gallery-search-input-wrapper",
		});

		// 创建搜索输入框
		this.searchInput = searchInputWrapper.createEl("input", {
			cls: "oss-gallery-search",
			attr: {
				type: "search",
				enterkeyhint: "search",
				spellcheck: "false",
				placeholder: options.placeholder || "Search by URL...",
			},
		});

		// 原生清除按钮（输入框为空时由 Obsidian 样式自动隐藏）
		this.clearBtn = searchInputWrapper.createDiv({
			cls: "search-input-clear-button",
			attr: { "aria-label": t("Clear search") },
		});

		// 创建正则表达式切换按钮
		this.regexBtn = searchInputWrapper.createEl("button", {
			cls: "clickable-icon input-right-decorator oss-gallery-regex-btn",
			attr: {
				type: "button",
				"aria-label": t("Use regular expression"),
				"aria-pressed": "false",
			},
		});
		setIcon(this.regexBtn, "regex");

		// 创建搜索按钮
		this.searchBtn = searchContainer.createEl("button", {
			cls: "clickable-icon oss-gallery-toolbar-btn oss-gallery-search-btn",
			attr: {
				type: "button",
				"aria-label": t("Search"),
			},
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
					e.preventDefault();
					this.searchInput.value = "";
					// 清空后同步复位搜索结果
					options.onSearch("");
				}
			}
		};

		// 清除按钮：与 Escape 行为一致
		this.clearBtn.onclick = () => {
			this.searchInput.value = "";
			options.onSearch("");
			this.searchInput.focus();
		};

		// 搜索按钮点击事件
		this.searchBtn.onclick = () => {
			options.onSearch(this.searchInput.value);
		};

		// 正则表达式切换按钮事件
		if (this.regexBtn && options.onToggleRegex) {
			this.regexBtn.onclick = (e) => {
				e.preventDefault();
				this.setRegexEnabled(!this.useRegex);
				options.onToggleRegex?.(this.useRegex);
			};
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
		this.regexBtn?.toggleClass("is-active", enabled);
		this.regexBtn?.setAttr("aria-pressed", String(enabled));
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
		this.clearBtn.onclick = null;
		this.searchBtn.onclick = null;
		if (this.regexBtn) {
			this.regexBtn.onclick = null;
		}

		// 只移除自己创建的容器，传入的父容器（工具栏）不属于本组件
		this.searchContainer.remove();
	}
}
