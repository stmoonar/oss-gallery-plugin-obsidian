import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import { setDestructiveButton } from "../utils/buttonStyle";

/** "Clear thumbnails": deletes the local thumbnail cache only (never the semantic index or the model). */
export class ClearThumbnailsModal extends Modal {
	constructor(app: App, private readonly dir: string, private readonly onConfirm: () => void) {
		super(app);
		this.containerEl.addClass("oss-gallery-semantic-modal");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(t("Clear thumbnails"));
		const p = contentEl.createEl("p");
		p.createSpan({ text: `${t("Clear thumbnails description")} ` });
		p.createEl("code", { text: this.dir });
		contentEl.createEl("p", { cls: "oss-gallery-semantic-warning", text: t("Clear thumbnails warning") });
		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText(t("Cancel")).onClick(() => this.close()))
			.addButton((btn) => setDestructiveButton(btn
				.setButtonText(t("Clear thumbnails"))
				.onClick(() => {
					this.close();
					this.onConfirm();
				}), true));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
