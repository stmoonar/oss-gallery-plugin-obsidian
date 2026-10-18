import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import { renderIndexStatusDetails } from "../components/IndexStatusDetails";
import { formatBytes } from "../semantic/format";
import {
	AUTO_CONFIRM_LIMIT_BYTES,
	IndexStats,
	TrafficEstimate,
	TrafficPromptReason,
} from "../semantic/SemanticIndexService";
import { formatCount } from "../semantic/statusText";
import { setDestructiveButton } from "../utils/buttonStyle";

function buttons(containerEl: HTMLElement, confirmText: string, destructive: boolean, onCancel: () => void, onConfirm: () => void): void {
	new Setting(containerEl)
		.addButton((btn) => btn.setButtonText(t("Cancel")).onClick(onCancel))
		.addButton((btn) => {
			btn.setButtonText(confirmText).onClick(onConfirm);
			if (destructive) {
				setDestructiveButton(btn, true);
			} else {
				btn.setCta();
			}
		});
}

/**
 * Traffic confirmation before indexing a remote provider (docs §9.4,
 * decision D17): every image not indexed yet is downloaded once.
 * Resolves true only when the user clicks "Start indexing".
 */
export class SemanticTrafficModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly providerLabel: string,
		private readonly estimate: TrafficEstimate,
		private readonly reason: TrafficPromptReason,
		private readonly resolve: (ok: boolean) => void
	) {
		super(app);
		this.containerEl.addClass("oss-gallery-semantic-modal");
	}

	static ask(app: App, providerLabel: string, estimate: TrafficEstimate, reason: TrafficPromptReason): Promise<boolean> {
		return new Promise((resolve) => new SemanticTrafficModal(app, providerLabel, estimate, reason, resolve).open());
	}

	private finish(ok: boolean): void {
		if (!this.resolved) {
			this.resolved = true;
			this.resolve(ok);
		}
		this.close();
	}

	onOpen(): void {
		const { contentEl } = this;
		const e = this.estimate;
		contentEl.empty();
		this.setTitle(t("Index images for semantic search"));
		if (this.reason !== "manual") {
			// Why automatic indexing stopped to ask (§9.4).
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: this.reason === "auto-first"
					? t("Semantic traffic auto first")
					: t("Semantic traffic auto large").replace("{limit}", formatBytes(AUTO_CONFIRM_LIMIT_BYTES)),
			});
		}
		// "N images / X MB to download / M already indexed", as large figures.
		const figures = contentEl.createDiv({ cls: "oss-gallery-semantic-figures" });
		const figure = (value: string, label: string) => {
			const item = figures.createDiv({ cls: "oss-gallery-semantic-figure" });
			item.createDiv({ cls: "oss-gallery-semantic-figure-value", text: value });
			item.createDiv({ cls: "oss-gallery-semantic-figure-label", text: label });
		};
		figure(formatCount(e.pendingCount), t("Semantic traffic images"));
		figure(`${e.unknownSizeCount ? "≥ " : ""}${formatBytes(e.pendingBytes)}`, t("Semantic traffic download"));
		figure(formatCount(e.indexedCount), t("Semantic traffic indexed"));
		if (e.unknownSizeCount) {
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: t("Semantic traffic unknown size").replace("{count}", formatCount(e.unknownSizeCount)),
			});
		}
		contentEl.createEl("p", {
			text: t("Semantic traffic description").replace("{provider}", this.providerLabel),
		});
		contentEl.createEl("p", {
			cls: "oss-gallery-semantic-warning",
			text: t("Semantic traffic warning"),
		});
		buttons(contentEl, t("Start indexing"), false, () => this.finish(false), () => this.finish(true));
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.resolve(false);
		}
	}
}

export interface IndexDetailsOptions {
	providerLabel: string;
	/** Current stats; re-read when the dialog re-renders (after a retry). */
	getStats(): IndexStats | null;
	summary(stats: IndexStats): string;
	/** On-disk size of the index ('' = none / unknown). */
	sizeText?: () => string;
	/** Scroll the gallery to an image and select it. */
	onReveal(key: string): void;
	/** Reset failed files and start indexing again (null = not possible now). */
	onRetryFailed: (() => void) | null;
}

/**
 * Gallery "index status" details (docs/semantic-search.md §9.2, §12): counts,
 * converted files with their source format, unsupported / failed files with
 * reasons. File names reveal the image in the gallery.
 */
export class SemanticIndexDetailsModal extends Modal {
	constructor(app: App, private readonly options: IndexDetailsOptions) {
		super(app);
		this.containerEl.addClass("oss-gallery-semantic-modal");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(t("Semantic index status"));
		const stats = this.options.getStats();
		if (!stats) {
			contentEl.createEl("p", { text: t("No index for the current provider") });
			return;
		}
		contentEl.createEl("p", { cls: "oss-gallery-semantic-details-summary", text: this.options.summary(stats) });
		const size = this.options.sizeText?.() ?? "";
		if (size) {
			contentEl.createEl("p", { cls: "setting-item-description oss-gallery-semantic-details-size", text: size });
		}
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("Semantic index details description").replace("{provider}", this.options.providerLabel),
		});
		renderIndexStatusDetails(contentEl, stats, {
			open: true,
			onReveal: (key) => {
				this.close();
				this.options.onReveal(key);
			},
		});
		const retry = this.options.onRetryFailed;
		const setting = new Setting(contentEl);
		if (retry && stats.failed > 0) {
			setting.addButton((btn) => btn
				.setButtonText(t("Retry failed").replace("{count}", String(stats.failed)))
				.onClick(() => {
					this.close();
					retry();
				}));
		}
		setting.addButton((btn) => btn.setButtonText(t("Close")).setCta().onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Confirmation for "Clear index for this vault". */
export class SemanticClearIndexModal extends Modal {
	constructor(app: App, private readonly dir: string, private readonly onConfirm: () => void) {
		super(app);
		this.containerEl.addClass("oss-gallery-semantic-modal");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(t("Clear index for this vault"));
		const p = contentEl.createEl("p");
		p.createSpan({ text: `${t("Semantic clear index description")} ` });
		p.createEl("code", { text: this.dir });
		contentEl.createEl("p", { cls: "oss-gallery-semantic-warning", text: t("Semantic clear index warning") });
		buttons(contentEl, t("Clear index"), true, () => this.close(), () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
