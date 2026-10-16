import { setIcon } from "obsidian";
import { t } from "../i18n";
import {
	applyAvailability,
	INITIAL_SEARCH_MODE,
	SearchModeState,
	SemanticAvailability,
	toggleRegex,
	toggleSemantic,
} from "./searchMode";

export interface SearchComponentOptions {
	onSearch: (searchText: string) => void;
	onToggleRegex?: (enabled: boolean) => void;
	/** Shows the semantic toggle (docs/semantic-search.md §9.1). */
	onToggleSemantic?: (enabled: boolean) => void;
	/** Escape in an empty box (e.g. leave "find similar"). */
	onEscapeEmpty?: () => void;
	placeholder?: string;
	semanticPlaceholder?: string;
}

export class SearchComponent {
	private container: HTMLElement;
	private searchContainer: HTMLElement;
	private searchInput: HTMLInputElement;
	private clearBtn: HTMLElement;
	private searchBtn: HTMLButtonElement;
	private regexBtn: HTMLButtonElement | null = null;
	private semanticBtn: HTMLButtonElement | null = null;
	private mode: SearchModeState = INITIAL_SEARCH_MODE;
	private availability: SemanticAvailability = { ok: false, reason: "checking" };
	private readonly placeholder: string;
	private readonly semanticPlaceholder: string;

	constructor(container: HTMLElement, private readonly options: SearchComponentOptions) {
		this.container = container;
		this.placeholder = options.placeholder || "Search by URL...";
		this.semanticPlaceholder = options.semanticPlaceholder || this.placeholder;
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
				placeholder: this.placeholder,
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

		// 语义搜索切换按钮：放在输入框外、搜索按钮之前（输入框内已有正则与清除按钮）
		if (options.onToggleSemantic) {
			this.semanticBtn = searchContainer.createEl("button", {
				cls: "clickable-icon oss-gallery-toolbar-btn oss-gallery-semantic-btn",
				attr: {
					type: "button",
					"aria-pressed": "false",
					"aria-disabled": "true",
				},
			});
			setIcon(this.semanticBtn, "sparkles");
			this.updateSemanticButton(t("Semantic search"));
		}

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
				} else if (options.onEscapeEmpty) {
					e.preventDefault();
					options.onEscapeEmpty();
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

		// 正则表达式切换按钮事件（语义模式下禁用）
		if (this.regexBtn && options.onToggleRegex) {
			this.regexBtn.onclick = (e) => {
				e.preventDefault();
				const next = toggleRegex(this.mode);
				if (next !== this.mode) {
					this.setMode(next);
					options.onToggleRegex?.(this.mode.regex);
				}
			};
		}

		if (this.semanticBtn && options.onToggleSemantic) {
			this.semanticBtn.onclick = (e) => {
				e.preventDefault();
				this.toggleSemanticMode();
			};
		}
	}

	private toggleSemanticMode(): void {
		const before = this.mode;
		const next = toggleSemantic(before, this.availability);
		if (next === before) {
			return;
		}
		this.setMode(next);
		if (before.regex && !next.regex) {
			this.options.onToggleRegex?.(false);
		}
		this.options.onToggleSemantic?.(next.semantic);
		this.searchInput.focus();
	}

	private setMode(mode: SearchModeState): void {
		this.mode = mode;
		this.regexBtn?.toggleClass("is-active", mode.regex);
		this.regexBtn?.setAttr("aria-pressed", String(mode.regex));
		this.regexBtn?.toggleClass("is-disabled", mode.semantic);
		this.regexBtn?.setAttr("aria-disabled", String(mode.semantic));
		this.searchInput.placeholder = mode.semantic ? this.semanticPlaceholder : this.placeholder;
		this.searchContainer.toggleClass("oss-gallery-is-semantic", mode.semantic);
		if (this.semanticBtn) {
			this.semanticBtn.toggleClass("is-active", mode.semantic);
			this.semanticBtn.setAttr("aria-pressed", String(mode.semantic));
		}
	}

	/** Disabled look + tooltip (kept focusable so the tooltip explains why). */
	private updateSemanticButton(label: string): void {
		const btn = this.semanticBtn;
		if (!btn) {
			return;
		}
		btn.setAttr("aria-label", label);
		btn.setAttr("aria-disabled", String(!this.availability.ok));
		btn.toggleClass("is-disabled", !this.availability.ok);
	}

	/**
	 * Feature state for the current provider. `label` is the toggle's tooltip
	 * (what it does, or why it is unavailable). Leaving availability turns
	 * semantic mode off and reports it.
	 */
	setSemanticAvailability(availability: SemanticAvailability, label: string): void {
		this.availability = availability;
		this.updateSemanticButton(label);
		const next = applyAvailability(this.mode, availability);
		if (next !== this.mode) {
			this.setMode(next);
			this.options.onToggleSemantic?.(false);
		}
	}

	/** Switch semantic mode on from code (status bar, "find similar"); false if unavailable. */
	enableSemantic(): boolean {
		if (this.mode.semantic) {
			return true;
		}
		if (!this.availability.ok) {
			return false;
		}
		this.toggleSemanticMode();
		return this.mode.semantic;
	}

	isSemanticEnabled(): boolean {
		return this.mode.semantic;
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
		return this.mode.regex;
	}

	/**
	 * 设置正则表达式模式
	 */
	setRegexEnabled(enabled: boolean): void {
		if (this.mode.semantic && enabled) {
			return;
		}
		this.setMode({ ...this.mode, regex: enabled });
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
		if (this.semanticBtn) {
			this.semanticBtn.onclick = null;
		}

		// 只移除自己创建的容器，传入的父容器（工具栏）不属于本组件
		this.searchContainer.remove();
	}
}
