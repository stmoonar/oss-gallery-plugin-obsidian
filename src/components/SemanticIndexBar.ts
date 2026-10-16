import { setIcon } from "obsidian";
import { t } from "../i18n";
import type { GalleryIndexState } from "../semantic/SemanticIndexing";
import { fileNameOf, formatCount, formatProgressCount, progressPercent } from "../semantic/statusText";

export interface SemanticIndexBarCallbacks {
	summaryText(state: GalleryIndexState): string;
	onStart(): void;
	onPause(): void;
	onResume(): void;
	onCancel(): void;
	onDetails(): void;
	onClearResult(): void;
}

/** Header of the current semantic result (or the query in flight). */
export type SemanticResultInfo =
	| { kind: "loading"; cold: boolean }
	| { kind: "semantic"; query: string; count: number }
	| { kind: "similar"; name: string; count: number };

function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void, cls = ""): HTMLButtonElement {
	const btn = parent.createEl("button", {
		cls: `clickable-icon oss-gallery-semantic-bar-btn ${cls}`.trim(),
		attr: { type: "button", "aria-label": label },
	});
	setIcon(btn, icon);
	btn.addEventListener("click", onClick);
	return btn;
}

/**
 * The gallery's semantic strip under the toolbar (docs/semantic-search.md
 * §9.2): indexing progress with pause/resume/cancel, or the index status chip
 * (opens the details dialog) with a build/update button, plus the header of a
 * semantic / "find similar" result with a button to leave it.
 */
export class SemanticIndexBar {
	private readonly el: HTMLElement;
	private readonly statusRow: HTMLElement;
	private readonly resultRow: HTMLElement;
	/** Shape of the status row; it is rebuilt only when this changes (keeps focus). */
	private shape = "";
	private progressText: HTMLElement | null = null;
	private progressFill: HTMLElement | null = null;
	private progressTrack: HTMLElement | null = null;
	private chipText: HTMLElement | null = null;

	constructor(parent: HTMLElement, private readonly callbacks: SemanticIndexBarCallbacks) {
		this.el = parent.createDiv({ cls: "oss-gallery-semantic-bar" });
		this.statusRow = this.el.createDiv({ cls: "oss-gallery-semantic-bar-row", attr: { "aria-live": "polite" } });
		this.resultRow = this.el.createDiv({ cls: "oss-gallery-semantic-bar-row oss-gallery-semantic-result" });
		this.el.hide();
		this.resultRow.hide();
	}

	/** null = feature off / provider not indexable: hide the status row. */
	update(state: GalleryIndexState | null): void {
		if (!state) {
			this.shape = "";
			this.statusRow.empty();
			this.statusRow.hide();
			this.syncVisibility();
			return;
		}
		this.statusRow.show();
		const p = state.progress;
		const running = state.runningHere && p.state !== "idle";
		const shape = running
			? `run:${p.state}`
			: state.stats
				? `idle:${state.pending > 0 ? "pending" : "done"}`
				: "none";
		if (shape !== this.shape) {
			this.shape = shape;
			this.build(state);
		}
		if (running) {
			const current = p.currentKey ? ` · ${fileNameOf(p.currentKey)}` : "";
			const label = p.state === "paused" ? t("Semantic index paused") : t("Semantic indexing");
			this.progressText?.setText(`${label} ${formatProgressCount(p.done, p.total)}${current}`);
			const percent = progressPercent(p.done, p.total);
			this.progressFill?.setCssStyles({ width: `${percent}%` });
			this.progressTrack?.setAttr("aria-valuenow", String(percent));
		} else if (state.stats) {
			this.chipText?.setText(this.callbacks.summaryText(state));
			const updateBtn = this.statusRow.querySelector<HTMLElement>(".oss-gallery-semantic-update-btn");
			updateBtn?.setText(t("Update index").replace("{count}", formatCount(state.pending)));
		}
		this.syncVisibility();
	}

	private build(state: GalleryIndexState): void {
		const row = this.statusRow;
		row.empty();
		this.progressText = null;
		this.progressFill = null;
		this.progressTrack = null;
		this.chipText = null;
		const p = state.progress;

		if (state.runningHere && p.state !== "idle") {
			this.progressText = row.createSpan({ cls: "oss-gallery-semantic-bar-text" });
			this.progressTrack = row.createDiv({
				cls: "oss-gallery-semantic-progress",
				attr: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": t("Semantic indexing") },
			});
			this.progressFill = this.progressTrack.createDiv({ cls: "oss-gallery-semantic-progress-fill" });
			if (p.state === "paused") {
				iconButton(row, "play", t("Resume indexing"), () => this.callbacks.onResume());
			} else {
				iconButton(row, "pause", t("Pause indexing"), () => this.callbacks.onPause());
			}
			iconButton(row, "x", t("Cancel indexing"), () => this.callbacks.onCancel());
			return;
		}

		if (!state.stats) {
			row.createSpan({ cls: "oss-gallery-semantic-bar-text", text: t("No semantic index yet") });
			const btn = row.createEl("button", { cls: "mod-cta oss-gallery-semantic-start-btn", text: t("Build index"), attr: { type: "button" } });
			btn.addEventListener("click", () => this.callbacks.onStart());
			return;
		}

		const chip = row.createEl("button", {
			cls: "oss-gallery-semantic-chip",
			attr: { type: "button", "aria-label": t("Semantic index status") },
		});
		const icon = chip.createSpan({ cls: "oss-gallery-semantic-chip-icon" });
		setIcon(icon, "sparkles");
		this.chipText = chip.createSpan();
		chip.addEventListener("click", () => this.callbacks.onDetails());
		if (state.pending > 0) {
			const btn = row.createEl("button", { cls: "oss-gallery-semantic-update-btn", attr: { type: "button" } });
			btn.addEventListener("click", () => this.callbacks.onStart());
		}
	}

	/** Show the header of a semantic result; null hides it. */
	setResult(info: SemanticResultInfo | null): void {
		const row = this.resultRow;
		row.empty();
		if (!info) {
			row.hide();
			this.syncVisibility();
			return;
		}
		row.show();
		if (info.kind === "loading") {
			row.createSpan({
				cls: "oss-gallery-semantic-bar-text oss-gallery-semantic-loading",
				text: info.cold ? t("Loading search model") : t("Searching"),
			});
		} else {
			const chip = row.createSpan({ cls: "oss-gallery-semantic-result-chip" });
			const label = info.kind === "semantic"
				? t("Semantic results for").replace("{query}", info.query)
				: t("Similar to").replace("{name}", info.name);
			chip.createSpan({ text: label });
			chip.createSpan({
				cls: "oss-gallery-semantic-result-count",
				text: info.count === 0 ? t("No semantic results") : t("Semantic result count").replace("{count}", formatCount(info.count)),
			});
			iconButton(chip, "x", t("Back to all images"), () => this.callbacks.onClearResult(), "oss-gallery-semantic-result-close");
		}
		this.syncVisibility();
	}

	private syncVisibility(): void {
		const visible = this.statusRow.isShown() || this.resultRow.isShown();
		if (visible) {
			this.el.show();
		} else {
			this.el.hide();
		}
	}

	destroy(): void {
		this.el.remove();
	}
}
