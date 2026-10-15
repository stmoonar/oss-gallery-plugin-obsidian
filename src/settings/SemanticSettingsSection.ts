import { App, debounce, Setting, ToggleComponent } from "obsidian";
import { t } from "../i18n";
import { SemanticDeleteModal, SemanticDownloadModal } from "../modals/SemanticModals";
import { AssetEntry, totalSize } from "../semantic/assets";
import { formatMegabytes, formatPercent } from "../semantic/format";
import { InstallState, remainingFiles, stateHasFiles } from "../semantic/ModelDownloadManager";
import { defaultModelDir } from "../semantic/modelDir";
import { MirrorUrlError, normalizeMirrorUrl } from "../semantic/mirrors";
import { describeDownloadError, SemanticController } from "../semantic/SemanticController";
import type { WebGpuFailureReason, WebGpuProbeResult } from "../semantic/webGpuProbe";
import type { ImageTokenBudget, PluginSettings } from "../types/settings";
import { setDestructiveButton } from "../utils/buttonStyle";

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
 * "Semantic search" block of the settings tab (docs/semantic-search.md §9.2):
 * WebGPU status, install status/progress, download/cancel/verify/delete,
 * model directory, token budget and auto-index.
 */
export class SemanticSettingsSection {
	private unsubscribe: (() => void) | null = null;
	private probeSetting: Setting | null = null;
	private statusSetting: Setting | null = null;
	private enableToggle: ToggleComponent | null = null;
	/** What the buttons were built for; they are rebuilt only when it changes. */
	private renderedKey: string | null = null;
	private frame: number | null = null;
	/** Set while the toggle is updated from code, so onChange ignores it. */
	private syncingToggle = false;

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

		new Setting(containerEl)
			.setName(t("Semantic search"))
			.setDesc(t("Semantic search description"))
			.setHeading();

		this.probeSetting = new Setting(containerEl)
			.setName(t("WebGPU"))
			.setDesc(t("Checking..."));

		this.statusSetting = new Setting(containerEl).setName(t("Model files"));

		new Setting(containerEl)
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

		const saveModelDir = debounce(async () => {
			await this.host.saveSettings();
			await this.controller.onModelDirChanged();
			this.update(this.controller.getState());
		}, 600, true);

		new Setting(containerEl)
			.setName(t("Model directory"))
			.setDesc(t("Model directory description").replace("{dir}", defaultModelDir()))
			.addText((text) => text
				.setPlaceholder(defaultModelDir())
				.setValue(this.settings.modelDir)
				.onChange((value) => {
					if (this.controller.manager.isBusy()) {
						text.setValue(this.settings.modelDir);
						return;
					}
					this.settings.modelDir = value.trim();
					saveModelDir();
				}));

		new Setting(containerEl)
			.setName(t("Image detail"))
			.setDesc(t("Image detail description"))
			.addDropdown((dropdown) => dropdown
				.addOption("70", t("Image detail 70"))
				.addOption("140", t("Image detail 140"))
				.addOption("280", t("Image detail 280"))
				.setValue(String(this.settings.imageTokenBudget))
				.onChange(async (value) => {
					this.settings.imageTokenBudget = Number(value) as ImageTokenBudget;
					await this.host.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t("Index automatically"))
			.setDesc(t("Index automatically description"))
			.addToggle((toggle) => toggle
				.setValue(this.settings.autoIndex)
				.onChange(async (value) => {
					this.settings.autoIndex = value;
					await this.host.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t("Download sources"))
			.setDesc(t("Download sources description"))
			.setHeading();

		this.renderMirrorSetting(
			containerEl,
			"hfEndpoint",
			t("Hugging Face endpoint"),
			t("Hugging Face endpoint description"),
			"https://hf-mirror.com"
		);
		this.renderMirrorSetting(
			containerEl,
			"githubMirror",
			t("GitHub mirror"),
			t("GitHub mirror description"),
			"https://gh-proxy.com"
		);

		this.unsubscribe = this.controller.manager.subscribe(() => this.scheduleUpdate());
		this.update(this.controller.getState());

		void this.controller.probe().then((probe) => this.renderProbe(probe));
		void this.controller.refresh();
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.frame !== null) {
			window.cancelAnimationFrame(this.frame);
			this.frame = null;
		}
		this.renderedKey = null;
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
		placeholder: string
	): void {
		const setting = new Setting(containerEl).setName(name).setDesc(desc);
		const errorEl = setting.descEl.createDiv({ cls: "oss-gallery-setting-error" });
		errorEl.hide();
		const save = debounce(async () => {
			await this.host.saveSettings();
		}, 600, true);

		setting.addText((text) => text
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
			}));
	}

	private renderProbe(probe: WebGpuProbeResult): void {
		if (!this.probeSetting) {
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
		const errorSuffix = lastError ? ` ${t("Last error")}: ${describeDownloadError(lastError)}` : "";
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
		const usesMirror = this.settings.hfEndpoint !== "" || this.settings.githubMirror !== "";
		new SemanticDownloadModal(this.app, pending, dir.dir, usesMirror, () => {
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
