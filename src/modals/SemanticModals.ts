import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import {
	AssetEntry,
	MODEL_ID,
	MODEL_REVISION,
	RELEASE_REPO,
	totalSize,
} from "../semantic/assets";
import { formatMegabytes } from "../semantic/format";
import { sourceHosts } from "../semantic/mirrors";
import { setDestructiveButton } from "../utils/buttonStyle";

function renderButtons(
	containerEl: HTMLElement,
	confirmText: string,
	destructive: boolean,
	onCancel: () => void,
	onConfirm: () => void
): void {
	new Setting(containerEl)
		.addButton((btn) => btn
			.setButtonText(t("Cancel"))
			.onClick(onCancel))
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
 * Opt-in consent for the semantic search download (decision D4): lists every
 * file, the total size, the sources (and the hosts actually contacted, which
 * differ from the official ones when a mirror is set) and the target
 * directory, and states that the files are written outside the vault.
 */
export class SemanticDownloadModal extends Modal {
	constructor(
		app: App,
		private readonly assets: AssetEntry[],
		private readonly targetDir: string,
		private readonly usesMirror: boolean,
		private readonly onConfirm: () => void
	) {
		super(app);
		this.containerEl.addClass("oss-gallery-semantic-modal");
	}

	private hostsOf(source: AssetEntry["source"]): string {
		return sourceHosts(this.assets.filter((a) => a.source === source).map((a) => a.url)).join(", ");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(t("Download semantic search model"));

		contentEl.createEl("p", {
			text: t("Semantic download intro")
				.replace("{size}", formatMegabytes(totalSize(this.assets))),
		});

		const list = contentEl.createEl("table", { cls: "oss-gallery-semantic-files" });
		const head = list.createEl("tr");
		head.createEl("th", { text: t("File") });
		head.createEl("th", { text: t("Size") });
		head.createEl("th", { text: t("Source") });
		for (const asset of this.assets) {
			const row = list.createEl("tr");
			row.createEl("td", { text: asset.name.split("/").pop() ?? asset.name, attr: { title: asset.url } });
			row.createEl("td", { text: formatMegabytes(asset.size) });
			row.createEl("td", { text: sourceHosts([asset.url])[0] ?? asset.url });
		}

		const sources = contentEl.createEl("ul");
		sources.createEl("li", {
			text: t("Semantic source runtime")
				.replace("{repo}", RELEASE_REPO)
				.replace("{host}", this.hostsOf("github")),
		});
		sources.createEl("li", {
			text: t("Semantic source model")
				.replace("{model}", MODEL_ID)
				.replace("{revision}", MODEL_REVISION.slice(0, 7))
				.replace("{host}", this.hostsOf("huggingface")),
		});
		if (this.usesMirror) {
			sources.createEl("li", { text: t("Semantic mirror in use") });
		}

		const target = contentEl.createEl("p");
		target.createSpan({ text: `${t("Target directory")}: ` });
		target.createEl("code", { text: this.targetDir });

		contentEl.createEl("p", {
			text: t("Semantic outside vault notice"),
			cls: "oss-gallery-semantic-warning",
		});

		renderButtons(
			contentEl,
			t("Download"),
			false,
			() => this.close(),
			() => {
				this.close();
				this.onConfirm();
			}
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Confirmation for deleting the model; it is shared by every vault. */
export class SemanticDeleteModal extends Modal {
	constructor(
		app: App,
		private readonly targetDir: string,
		private readonly onConfirm: () => void
	) {
		super(app);
		this.containerEl.addClass("oss-gallery-semantic-modal");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(t("Delete semantic search model"));

		const target = contentEl.createEl("p");
		target.createSpan({ text: `${t("Semantic delete description")} ` });
		target.createEl("code", { text: this.targetDir });

		contentEl.createEl("p", {
			text: t("Semantic delete all vaults warning"),
			cls: "oss-gallery-semantic-warning",
		});

		renderButtons(
			contentEl,
			t("Delete"),
			true,
			() => this.close(),
			() => {
				this.close();
				this.onConfirm();
			}
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
