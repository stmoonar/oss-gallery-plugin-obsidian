import { t } from "../i18n";
import type { IndexStats, IndexStatsItem } from "../semantic/SemanticIndexService";

export interface IndexStatusDetailsOptions {
	/** Make file names buttons that reveal the image in the gallery. */
	onReveal?: (key: string) => void;
	/** Expand the lists right away (details dialog) instead of collapsing them (settings). */
	open?: boolean;
}

function statusLabel(item: IndexStatsItem): string {
	if (item.status === "unsupported") {
		return t("Index status unsupported");
	}
	const label = t("Index status failed");
	return item.attempts ? `${label} (${item.attempts})` : label;
}

function fileCell(row: HTMLElement, key: string, onReveal?: (key: string) => void): void {
	const cell = row.createEl("td", { cls: "oss-gallery-semantic-file" });
	if (!onReveal) {
		cell.setText(key);
		return;
	}
	const btn = cell.createEl("button", {
		cls: "oss-gallery-link-btn",
		text: key,
		attr: { type: "button", "aria-label": `${t("Show in gallery")}: ${key}` },
	});
	btn.addEventListener("click", () => onReveal(key));
}

/**
 * Problem files (unsupported / failed, with reasons) and converted files of an
 * index (docs/semantic-search.md §12). Shared by the settings tab and the
 * gallery's details dialog so both show the same thing.
 */
export function renderIndexStatusDetails(el: HTMLElement, stats: IndexStats, options: IndexStatusDetailsOptions = {}): void {
	const problems = stats.items.filter((i) => i.status !== "converted");
	const converted = stats.items.filter((i) => i.status === "converted");

	if (problems.length > 0) {
		const details = el.createEl("details", { cls: "oss-gallery-semantic-details" });
		details.open = options.open === true;
		details.createEl("summary", {
			text: t("Unsupported or failed files").replace("{count}", String(problems.length)),
		});
		const table = details.createEl("table", { cls: "oss-gallery-semantic-files" });
		const head = table.createEl("tr");
		head.createEl("th", { text: t("File") });
		head.createEl("th", { text: t("Status") });
		head.createEl("th", { text: t("Reason") });
		for (const item of problems) {
			const row = table.createEl("tr");
			fileCell(row, item.key, options.onReveal);
			row.createEl("td", { text: statusLabel(item) });
			const reason = item.format && item.status === "unsupported"
				? `${item.format.toUpperCase()}${item.reason ? `: ${item.reason}` : ""}`
				: item.reason ?? "";
			row.createEl("td", { text: reason });
		}
	}

	if (converted.length > 0) {
		const details = el.createEl("details", { cls: "oss-gallery-semantic-details" });
		details.open = options.open === true;
		details.createEl("summary", {
			text: t("Converted files").replace("{count}", String(converted.length)),
		});
		const table = details.createEl("table", { cls: "oss-gallery-semantic-files" });
		const head = table.createEl("tr");
		head.createEl("th", { text: t("File") });
		head.createEl("th", { text: t("Source format") });
		for (const item of converted) {
			const row = table.createEl("tr");
			fileCell(row, item.key, options.onReveal);
			row.createEl("td", { text: (item.format ?? "").toUpperCase() });
		}
	}

	if (options.open && problems.length === 0 && converted.length === 0) {
		el.createDiv({ cls: "setting-item-description", text: t("No problem files") });
	}
}
