import { App, Modal } from "obsidian";
import { t } from "../i18n";
import type { SelfTestReport } from "../semantic/selfTest";

function ms(value: number | undefined): string {
	return value === undefined ? "-" : `${value} ms`;
}

/** Results of "Semantic search: run self-test": timings and a similarity table. */
export class SemanticSelfTestModal extends Modal {
	constructor(app: App, private readonly report: SelfTestReport) {
		super(app);
		this.containerEl.addClass("oss-gallery-semantic-modal");
	}

	onOpen(): void {
		const { contentEl } = this;
		const r = this.report;
		contentEl.empty();
		this.setTitle(t("Semantic self-test"));

		if (r.error) {
			contentEl.createEl("p", {
				cls: "oss-gallery-semantic-warning",
				text: `${t("Semantic self-test failed")}: ${r.error}`,
			});
		} else {
			contentEl.createEl("p", { text: t("Semantic self-test passed") });
		}

		const timings = contentEl.createEl("table", { cls: "oss-gallery-semantic-files" });
		const addRow = (label: string, value: string): void => {
			const row = timings.createEl("tr");
			row.createEl("td", { text: label });
			row.createEl("td", { text: value });
		};
		if (r.init) {
			addRow(t("Semantic self-test runtime check"), ms(r.init.verifyMs));
			addRow(t("Semantic self-test model load"), ms(r.init.loadMs));
			addRow(t("Semantic self-test worker start"), ms(r.initWallMs));
			addRow(t("Semantic self-test sessions"), r.init.sessions.join(", "));
		}
		addRow(t("Semantic self-test text first"), ms(r.textFirstMs));
		addRow(t("Semantic self-test text warm"), ms(r.textWarmMs));
		addRow(t("Semantic self-test images first"), ms(r.imageFirstMs));
		addRow(
			t("Semantic self-test images warm"),
			r.imageWarmMs === undefined
				? "-"
				: `${r.imageWarmMs} ms / ${r.images.length} (${r.imageBatches ?? 0} ${t("Semantic self-test batches")})`
		);
		if (r.normMin !== undefined && r.normMax !== undefined) {
			addRow(
				t("Semantic self-test vector norms"),
				`${r.dims ?? "?"} dims, ${r.normMin.toFixed(4)} – ${r.normMax.toFixed(4)}`
			);
		}

		if (r.sims.length > 0) {
			contentEl.createEl("h4", { text: t("Semantic self-test similarity") });
			const table = contentEl.createEl("table", { cls: "oss-gallery-semantic-files" });
			const head = table.createEl("tr");
			head.createEl("th", { text: t("Semantic self-test image") });
			for (const q of r.queries) {
				head.createEl("th", { text: q });
			}
			r.sims.forEach((row, i) => {
				const tr = table.createEl("tr");
				const info = r.images[i];
				tr.createEl("td", { text: info.ok ? info.label : `${info.label} (${info.error ?? "?"})` });
				const best = Math.max(...row.map((v) => v ?? -Infinity));
				for (const v of row) {
					const td = tr.createEl("td", { text: v === null ? "-" : v.toFixed(3) });
					if (v !== null && v === best) {
						td.addClass("oss-gallery-semantic-best");
					}
				}
			});
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: t("Semantic self-test note"),
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
