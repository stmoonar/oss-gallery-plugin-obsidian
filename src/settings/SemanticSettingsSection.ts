import { App, debounce, DropdownComponent, Setting, ToggleComponent } from "obsidian";
import { t } from "../i18n";
import { renderIndexStatusDetails } from "../components/IndexStatusDetails";
import { SemanticConfirmModal, SemanticDeleteModal, SemanticDownloadModal } from "../modals/SemanticModals";
import { providerRegistry } from "../providers/registry";
import { AssetEntry, totalSize } from "../semantic/assets";
import { formatBytes, formatMegabytes, formatPercent } from "../semantic/format";
import { InstallState, remainingFiles, stateHasFiles } from "../semantic/ModelDownloadManager";
import { defaultIndexDir, defaultModelDir, resolveIndexDir } from "../semantic/modelDir";
import { MirrorUrlError, mirrorMayHelp, normalizeMirrorUrl, usesMirror } from "../semantic/mirrors";
import { describeDownloadError, SemanticController } from "../semantic/SemanticController";
import { formatCount } from "../semantic/statusText";
import type { WebGpuFailureReason, WebGpuProbeResult } from "../semantic/webGpuProbe";
import type { ImageTokenBudget, PluginSettings } from "../types/settings";
import { setDestructiveButton } from "../utils/buttonStyle";
import { addInputHint, createSettingsGroup, createSettingsSection } from "./settingGroups";
import { estimateRebuild, semanticDownloadSize } from "./settingsUx";

/** Counts and size of the index refresh this often while indexing runs. */
const INDEX_STATUS_REFRESH_MS = 3000;

type MirrorKey = "hfEndpoint" | "githubMirror";

const MIRROR_ERROR_KEYS: Record<MirrorUrlError, Parameters<typeof t>[0]> = {
	"not-https": "Mirror URL must use https",
	invalid: "Mirror URL is invalid",
};

interface SemanticSettingsHost {
	settings: PluginSettings;
	saveSettings(): Promise<void>;
}

const PROBE_REASON_KEYS: Record<WebGpuFailureReason, Parameters<typeof t>[0]> = {
	"no-api": "WebGPU unavailable: no API",
	"no-adapter": "WebGPU unavailable: no adapter",
	"software-adapter": "WebGPU unavailable: software adapter",
	"insufficient-limits": "WebGPU unavailable: insufficient limits",
	error: "WebGPU unavailable: error",
};

export function describeProbeFailure(probe: Extract<WebGpuProbeResult, { ok: false }>): string {
	const message = t(PROBE_REASON_KEYS[probe.reason]);
	return probe.detail ? `${message} (${probe.detail})` : message;
}

/**
 * Setup: model not installed yet, only status, mirrors and download.
 * Ready: installed (or needs repair), every option.
 */
type Phase = "setup" | "ready";

/** null = keep the current phase (transient states such as a running download). */
function phaseOf(state: InstallState): Phase | null {
	switch (state.kind) {
		case "installed":
		case "needs-repair":
			return "ready";
		case "not-installed":
		case "incomplete":
		case "unsupported":
		case "invalid-dir":
			return "setup";
		default:
			return null;
	}
}

/**
 * "Semantic search" block of the settings tab (docs/semantic-search.md §9.2),
 * with progressive disclosure: before the model is installed only the
 * WebGPU status, the download sources and the download itself are shown;
 * after that the on/off switch, image detail, auto-index and index status.
 * Model and index directories live in a collapsed "Advanced" area.
 */
export class SemanticSettingsSection {
	private unsubscribe: (() => void) | null = null;
	private rootEl: HTMLElement | null = null;
	private phase: Phase = "setup";
	private probeResult: WebGpuProbeResult | null = null;
	private probeSetting: Setting | null = null;
	private statusSetting: Setting | null = null;
	private enableToggle: ToggleComponent | null = null;
	/** What the buttons were built for; they are rebuilt only when it changes. */
	private renderedKey: string | null = null;
	private frame: number | null = null;
	/** Set while the toggle is updated from code, so onChange ignores it. */
	private syncingToggle = false;
	private indexStatusEl: HTMLElement | null = null;
	private indexStatsEl: HTMLElement | null = null;
	private indexSizeEl: HTMLElement | null = null;
	private unsubscribeIndex: (() => void) | null = null;
	/** The "Advanced" area stays open across re-renders once opened. */
	private advancedOpen = false;

	constructor(
		private readonly app: App,
		private readonly host: SemanticSettingsHost,
		private readonly controller: SemanticController
	) {}

	private get settings() {
		return this.host.settings.semantic;
	}

	render(containerEl: HTMLElement): void {
		this.dispose();
		this.rootEl = containerEl.createDiv({ cls: "oss-gallery-semantic-settings" });
		const state = this.controller.getState();
		this.phase = phaseOf(state) ?? (this.settings.enabled ? "ready" : "setup");
		this.renderSection();

		this.unsubscribe = this.controller.manager.subscribe(() => this.scheduleUpdate());
		void this.controller.probe().then((probe) => {
			this.probeResult = probe;
			this.renderProbe();
		});
		void this.controller.refresh();
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.disposeIndexStatus();
		if (this.frame !== null) {
			window.cancelAnimationFrame(this.frame);
			this.frame = null;
		}
		this.renderedKey = null;
		this.rootEl = null;
	}

	private disposeIndexStatus(): void {
		this.unsubscribeIndex?.();
		this.unsubscribeIndex = null;
		this.indexStatusEl = null;
		this.indexStatsEl = null;
		this.indexSizeEl = null;
	}

	/** (Re)build the block for the current phase. */
	private renderSection(): void {
		const el = this.rootEl;
		if (!el) {
			return;
		}
		el.empty();
		this.disposeIndexStatus();
		this.probeSetting = null;
		this.statusSetting = null;
		this.enableToggle = null;
		this.renderedKey = null;

		const group = createSettingsSection(el, {
			heading: t("Semantic search"),
			intro: t("Semantic search description")
				.replace("{size}", semanticDownloadSize(this.controller.getAssets())),
		});

		this.probeSetting = new Setting(group)
			.setName(t("WebGPU"))
			.setDesc(t("Checking..."));
		this.renderProbe();

		if (this.phase === "setup") {
			this.statusSetting = new Setting(group).setName(t("Model files"));
			// Mirrors right under the download: they decide whether it works.
			this.renderMirrorSettings(el);
			const advanced = this.renderAdvanced(el);
			this.renderModelDirSetting(advanced.group);
			this.renderIndexDirSetting(advanced.group);
		} else {
			this.statusSetting = new Setting(group).setName(t("Model files"));
			this.renderEnableToggle(group);
			this.renderBudgetSetting(group);
			new Setting(group)
				.setName(t("Index automatically"))
				.setDesc(t("Index automatically description"))
				.addToggle((toggle) => toggle
					.setValue(this.settings.autoIndex)
					.onChange(async (value) => {
						this.settings.autoIndex = value;
						await this.host.saveSettings();
					}));
			this.renderIndexStatus(group);
			const advanced = this.renderAdvanced(el);
			this.renderModelDirSetting(advanced.group);
			this.renderIndexDirSetting(advanced.group);
			this.renderMirrorSettings(advanced.details);
		}

		this.update(this.controller.getState());
	}

	/** Collapsible "Advanced" area with its own group of rows. */
	private renderAdvanced(el: HTMLElement): { details: HTMLElement; group: HTMLElement } {
		const details = el.createEl("details", { cls: "oss-gallery-settings-advanced" });
		details.open = this.advancedOpen;
		details.createEl("summary", { text: t("Semantic advanced") });
		details.addEventListener("toggle", () => {
			this.advancedOpen = details.open;
		});
		return { details, group: createSettingsGroup(details) };
	}

	private renderEnableToggle(el: HTMLElement): void {
		new Setting(el)
			.setName(t("Enable semantic search"))
			.setDesc(t("Enable semantic search description"))
			.addToggle((toggle) => {
				this.enableToggle = toggle;
				toggle.setValue(this.settings.enabled).onChange(async (value) => {
					if (this.syncingToggle) {
						return;
					}
					toggle.setDisabled(true);
					await this.controller.toggle(value);
					this.update(this.controller.getState());
				});
			});
	}

	/**
	 * Image detail: a new value resets the whole index of this vault, so it
	 * asks first (indexed count, download estimate); Cancel restores it.
	 */
	private renderBudgetSetting(el: HTMLElement): void {
		new Setting(el)
			.setName(t("Image detail"))
			.setDesc(t("Image detail description"))
			.addDropdown((dropdown) => dropdown
				.addOption("70", t("Image detail 70"))
				.addOption("140", t("Image detail 140"))
				.addOption("280", t("Image detail 280"))
				.setValue(String(this.settings.imageTokenBudget))
				.onChange((value) => {
					const next = Number(value) as ImageTokenBudget;
					if (next === this.settings.imageTokenBudget) {
						return;
					}
					this.confirmBudgetChange(dropdown, next);
				}));
	}

	private confirmBudgetChange(dropdown: DropdownComponent, next: ImageTokenBudget): void {
		const restore = (): void => {
			dropdown.setValue(String(this.settings.imageTokenBudget));
		};
		const paragraphs = [t("Image detail change intro")];
		const inputs = this.controller.indexing?.rebuildInputs() ?? null;
		if (inputs) {
			const provider = providerRegistry.getLabel(this.host.settings.activeProvider);
			const estimate = estimateRebuild(inputs.indexed, inputs.listed, inputs.local);
			paragraphs.push(t("Image detail change indexed")
				.replace("{count}", formatCount(estimate.indexed))
				.replace("{provider}", provider));
			if (estimate.downloadBytes === 0 && inputs.local) {
				paragraphs.push(t("Image detail change local"));
			} else if (estimate.downloadBytes === null) {
				paragraphs.push(t("Image detail change download unknown"));
			} else {
				let text = t("Image detail change download")
					.replace("{size}", formatBytes(estimate.downloadBytes))
					.replace("{provider}", provider);
				if (estimate.unknownSizeCount > 0) {
					text += ` ${t("Semantic traffic unknown size").replace("{count}", formatCount(estimate.unknownSizeCount))}`;
				}
				paragraphs.push(text);
			}
		}
		new SemanticConfirmModal(this.app, {
			title: t("Image detail change title"),
			paragraphs,
			warning: t("Image detail change warning"),
			confirmText: t("Image detail change confirm"),
			onConfirm: () => {
				void this.applyBudget(next);
			},
			onCancel: restore,
		}).open();
	}

	private async applyBudget(next: ImageTokenBudget): Promise<void> {
		this.settings.imageTokenBudget = next;
		await this.host.saveSettings();
		this.renderIndexStatusContent();
	}

	/**
	 * Model directory. It cannot change while a download or check runs:
	 * the field is reset and says why.
	 */
	private renderModelDirSetting(el: HTMLElement): void {
		const setting = new Setting(el)
			.setName(t("Model directory"))
			.setDesc(t("Model directory description"));
		const errorEl = setting.descEl.createDiv({ cls: "oss-gallery-setting-error" });
		errorEl.hide();
		const saveModelDir = debounce(async () => {
			await this.host.saveSettings();
			await this.controller.onModelDirChanged();
			this.update(this.controller.getState());
		}, 600, true);

		setting.addText((text) => {
			addInputHint(text.inputEl, t("Default directory hint").replace("{dir}", defaultModelDir()));
			text
				.setPlaceholder(defaultModelDir())
				.setValue(this.settings.modelDir)
				.onChange((value) => {
					if (this.controller.manager.isBusy()) {
						text.setValue(this.settings.modelDir);
						errorEl.setText(t("Model directory busy"));
						errorEl.show();
						return;
					}
					errorEl.hide();
					this.settings.modelDir = value.trim();
					saveModelDir();
				});
		});
	}

	/**
	 * Per-device index directory (outside the vault, never synced). A new
	 * value points at a new location: the old index stays where it was, the
	 * stores reopen there (remote providers ask for confirmation again).
	 */
	private renderIndexDirSetting(el: HTMLElement): void {
		const setting = new Setting(el)
			.setName(t("Index directory"))
			.setDesc(t("Index directory description"));
		const errorEl = setting.descEl.createDiv({ cls: "oss-gallery-setting-error" });
		errorEl.hide();
		const save = debounce(async () => {
			await this.host.saveSettings();
			this.renderIndexStatusContent();
		}, 600, true);
		setting.addText((text) => {
			addInputHint(text.inputEl, t("Default directory hint").replace("{dir}", defaultIndexDir()));
			text
				.setPlaceholder(defaultIndexDir())
				.setValue(this.settings.indexDir)
				.onChange((value) => {
					const trimmed = value.trim();
					if (!resolveIndexDir(trimmed).ok) {
						errorEl.setText(t("Index directory must be an absolute path"));
						errorEl.show();
						return;
					}
					errorEl.hide();
					if (trimmed !== this.settings.indexDir) {
						this.settings.indexDir = trimmed;
						save();
					}
				});
		});
	}

	/**
	 * "Index for this vault" row: counts and on-disk size as its description,
	 * the problem / converted file lists under it, the clear button.
	 */
	private renderIndexStatus(el: HTMLElement): void {
		const indexing = this.controller.indexing;
		if (!indexing) {
			return;
		}
		const setting = new Setting(el)
			.setName(t("Index for this vault"))
			.addButton((btn) => {
				setDestructiveButton(btn
					.setButtonText(t("Clear index for this vault"))
					.setTooltip(t("Index for this vault description"))
					.onClick(() => indexing.confirmClearIndex(() => this.renderIndexStatusContent())));
			});
		setting.settingEl.addClass("oss-gallery-semantic-index-row");
		this.indexStatsEl = setting.descEl.createDiv({ cls: "oss-gallery-index-stats" });
		this.indexSizeEl = setting.descEl.createDiv({ cls: "oss-gallery-index-size" });
		this.indexStatusEl = setting.infoEl.createDiv({ cls: "oss-gallery-semantic-index-status" });
		this.renderIndexStatusContent();
		let pending: number | null = null;
		this.unsubscribeIndex = indexing.index.onProgress((p) => {
			if (p.state === "idle") {
				// A run ended: everything, lists included.
				if (pending !== null) window.clearTimeout(pending);
				pending = window.setTimeout(() => {
					pending = null;
					this.renderIndexStatusContent();
				}, 200);
			} else if (pending === null) {
				// While indexing: counts and size every few seconds (the open
				// lists stay as they are; they are rebuilt when the run ends).
				pending = window.setTimeout(() => {
					pending = null;
					this.renderIndexStatusLines();
				}, INDEX_STATUS_REFRESH_MS);
			}
		});
	}

	/** Counts, size and the file lists. */
	private renderIndexStatusContent(): void {
		this.renderIndexStatusLines();
		const el = this.indexStatusEl;
		const stats = this.controller.indexing?.statsForCurrentScope() ?? null;
		if (!el) {
			return;
		}
		el.empty();
		if (stats) {
			// Same lists as the gallery's details dialog (without "show in gallery").
			renderIndexStatusDetails(el, stats);
		}
	}

	/** The two description lines: counts of the current provider, size on disk. */
	private renderIndexStatusLines(): void {
		const indexing = this.controller.indexing;
		const statsEl = this.indexStatsEl;
		const sizeEl = this.indexSizeEl;
		if (!indexing || !statsEl || !sizeEl) {
			return;
		}
		const stats = indexing.statsForCurrentScope();
		statsEl.setText(stats
			? t("Index stats")
				.replace("{indexed}", formatCount(stats.indexed))
				.replace("{converted}", formatCount(stats.converted))
				.replace("{unsupported}", formatCount(stats.unsupported))
				.replace("{failed}", formatCount(stats.failed))
				.replace("{pending}", formatCount(stats.pending))
			: t("No index for the current provider"));
		const size = indexing.indexSizeText(indexing.currentScope()?.id ?? null);
		sizeEl.setText(size);
		sizeEl.toggle(size !== "");
	}

	/** "Download sources": a small sub-section with its own group. */
	private renderMirrorSettings(parentEl: HTMLElement): void {
		const el = createSettingsSection(parentEl, {
			heading: t("Download sources"),
			intro: t("Download sources description"),
			cls: "oss-gallery-settings-subsection",
		});

		this.renderMirrorSetting(
			el,
			"hfEndpoint",
			t("Hugging Face endpoint"),
			t("Hugging Face endpoint description"),
			t("Hugging Face endpoint hint"),
			"https://hf-mirror.com"
		);
		this.renderMirrorSetting(
			el,
			"githubMirror",
			t("GitHub mirror"),
			t("GitHub mirror description"),
			t("GitHub mirror hint"),
			"https://gh-proxy.com"
		);
	}

	/**
	 * Mirror URL field. Only valid values are saved (normalized: https, no
	 * trailing slash); an invalid value shows an inline error and keeps the
	 * last valid one. Mirrors never touch installed files (hashes are the
	 * identity), so nothing is re-checked here.
	 */
	private renderMirrorSetting(
		containerEl: HTMLElement,
		key: MirrorKey,
		name: string,
		desc: string,
		hint: string,
		placeholder: string
	): void {
		const setting = new Setting(containerEl).setName(name).setDesc(desc);
		const errorEl = setting.descEl.createDiv({ cls: "oss-gallery-setting-error" });
		errorEl.hide();
		const save = debounce(async () => {
			await this.host.saveSettings();
			// The "try a mirror" hint depends on whether one is set.
			this.update(this.controller.getState());
		}, 600, true);

		setting.addText((text) => {
			addInputHint(text.inputEl, hint);
			text
				.setPlaceholder(placeholder)
				.setValue(this.settings[key])
				.onChange((value) => {
					const normalized = normalizeMirrorUrl(value);
					if (!normalized.ok) {
						errorEl.setText(t(MIRROR_ERROR_KEYS[normalized.error]));
						errorEl.show();
						return;
					}
					errorEl.hide();
					if (normalized.value !== this.settings[key]) {
						this.settings[key] = normalized.value;
						save();
					}
				});
		});
	}

	private renderProbe(): void {
		const probe = this.probeResult;
		if (!this.probeSetting || !probe) {
			return;
		}
		if (probe.ok) {
			const adapter = probe.adapter ? ` (${probe.adapter})` : "";
			this.probeSetting.setDesc(`${t("WebGPU available")}${adapter}`);
		} else {
			this.probeSetting.setDesc(describeProbeFailure(probe));
		}
	}

	/** Progress events arrive per network chunk; repaint at most once a frame. */
	private scheduleUpdate(): void {
		if (this.frame !== null) {
			return;
		}
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.update(this.controller.getState());
		});
	}

	private update(state: InstallState): void {
		const phase = phaseOf(state) ?? this.phase;
		if (phase !== this.phase) {
			this.phase = phase;
			this.renderSection();
			return;
		}
		const setting = this.statusSetting;
		if (!setting) {
			return;
		}
		setting.setDesc(this.describeState(state));

		this.syncEnableToggle(state);

		// Rebuild buttons only when they would change (progress updates keep them).
		const key = this.buttonKey(state);
		if (this.renderedKey === key) {
			return;
		}
		this.renderedKey = key;
		setting.controlEl.empty();
		this.renderButtons(setting, state);
	}

	/** On/off mirrors the setting; it can be switched on only when installed. */
	private syncEnableToggle(state: InstallState): void {
		const toggle = this.enableToggle;
		if (!toggle) {
			return;
		}
		this.syncingToggle = true;
		try {
			toggle.setValue(this.settings.enabled);
			toggle.setDisabled(!this.settings.enabled && state.kind !== "installed");
		} finally {
			this.syncingToggle = false;
		}
	}

	/** Everything that shapes the buttons: kind, delete availability, download size. */
	private buttonKey(state: InstallState): string {
		const size = state.kind === "not-installed" ? totalSize(this.pendingAssets(state)) : 0;
		return `${state.kind}:${stateHasFiles(state)}:${size}`;
	}

	/** Manifest files the next download would fetch. */
	private pendingAssets(state: InstallState): AssetEntry[] {
		const names = new Set(remainingFiles(state));
		return this.controller.getAssets().filter((a) => names.has(a.name));
	}

	private describeState(state: InstallState): string {
		const lastError = this.controller.manager.getLastError();
		let errorSuffix = lastError ? ` ${t("Last error")}: ${describeDownloadError(lastError)}` : "";
		if (lastError && mirrorMayHelp(lastError.code) && !usesMirror(this.settings)) {
			errorSuffix += ` ${t("Semantic try mirror hint")}`;
		}
		switch (state.kind) {
			case "checking":
				return t("Checking...");
			case "unsupported":
				return describeProbeFailure(state.probe);
			case "invalid-dir":
				return t("Model directory must be an absolute path");
			case "not-installed":
				return t("Model not downloaded") + errorSuffix;
			case "incomplete":
				return t("Model download incomplete")
					.replace("{count}", String(state.remaining.length))
					.replace("{size}", formatMegabytes(totalSize(this.pendingAssets(state)))) + errorSuffix;
			case "needs-repair": {
				const parts: string[] = [];
				if (state.missing.length > 0) {
					parts.push(t("Files missing").replace("{count}", String(state.missing.length)));
				}
				if (state.mismatched.length > 0) {
					parts.push(t("Files damaged").replace("{count}", String(state.mismatched.length)));
				}
				return t("Model needs repair").replace("{parts}", parts.join(t("List separator"))) + errorSuffix;
			}
			case "downloading":
				return t("Model downloading")
					.replace("{percent}", formatPercent(state.bytesDone, state.bytesTotal))
					.replace("{done}", formatMegabytes(state.bytesDone))
					.replace("{total}", formatMegabytes(state.bytesTotal))
					.replace("{file}", state.currentFile.split("/").pop() ?? "");
			case "verifying":
				return t("Model verifying")
					.replace("{percent}", formatPercent(state.bytesDone, state.bytesTotal))
					.replace("{file}", state.currentFile.split("/").pop() ?? "");
			case "deleting":
				return t("Deleting...");
			case "installed":
				return t("Model installed").replace("{size}", formatMegabytes(totalSize(this.controller.getAssets())));
		}
	}

	private renderButtons(setting: Setting, state: InstallState): void {
		const download = (label: string) => setting.addButton((btn) => btn
			.setButtonText(label)
			.setCta()
			.onClick(() => this.confirmDownload()));
		const verify = () => setting.addButton((btn) => btn
			.setButtonText(t("Verify"))
			.onClick(() => {
				void this.controller.verify();
			}));
		const cancel = () => setting.addButton((btn) => btn
			.setButtonText(t("Cancel"))
			.onClick(() => this.controller.cancel()));
		const remove = () => setting.addButton((btn) => {
			setDestructiveButton(btn
				.setButtonText(t("Delete model"))
				.onClick(() => this.confirmDelete()));
			btn.setDisabled(!stateHasFiles(state));
		});

		switch (state.kind) {
			case "not-installed":
				download(t("Download model").replace("{size}", formatMegabytes(totalSize(this.pendingAssets(state)))));
				remove();
				break;
			case "incomplete":
				download(t("Resume download"));
				remove();
				break;
			case "needs-repair":
				download(t("Repair"));
				verify();
				remove();
				break;
			case "installed":
				verify();
				remove();
				break;
			case "downloading":
			case "verifying":
				cancel();
				break;
			case "unsupported":
				if (state.filesPresent) {
					remove();
				}
				break;
			default:
				break;
		}
	}

	/** Confirm downloading only what is still missing right now. */
	private confirmDownload(): void {
		const dir = this.controller.getModelDir();
		if (!dir.ok) {
			return;
		}
		const pending = this.pendingAssets(this.controller.getState());
		if (pending.length === 0) {
			return;
		}
		new SemanticDownloadModal(this.app, pending, dir.dir, usesMirror(this.settings), () => {
			void this.controller.download();
		}).open();
	}

	private confirmDelete(): void {
		const dir = this.controller.getModelDir();
		if (!dir.ok) {
			return;
		}
		new SemanticDeleteModal(this.app, dir.dir, () => {
			void this.controller.deleteModel();
		}).open();
	}
}
