/**
 * Plugin-level owner of the semantic search install (docs/semantic-search.md
 * §3). Lives as long as the plugin, so a download keeps running and reporting
 * progress when the settings tab is closed and reopened.
 *
 * P1: WebGPU probe, download/verify/delete, `semantic.enabled` bookkeeping.
 * P2+ hangs the workers, index and search services off this object.
 */
import { Notice } from "obsidian";
import { t } from "../i18n";
import type { PluginSettings } from "../types/settings";
import { AssetEntry, getAllAssets } from "./assets";
import { DownloadError } from "./httpsDownload";
import {
	DeleteResult,
	InstallState,
	ModelDownloadManager,
	VerifyResult,
} from "./ModelDownloadManager";
import { resolveModelDir, ResolvedModelDir } from "./modelDir";
import { probeWebGpu, WebGpuProbeResult } from "./webGpuProbe";

export interface SemanticHost {
	settings: PluginSettings;
	saveSettings(): Promise<void>;
	manifest: { version: string };
}

export class SemanticController {
	readonly manager: ModelDownloadManager;
	private probeResult: Promise<WebGpuProbeResult> | null = null;

	constructor(private readonly host: SemanticHost) {
		this.manager = new ModelDownloadManager({
			getAssets: () => this.getAssets(),
			getModelDir: () => this.getModelDir(),
			probe: () => this.probe(),
		});
	}

	/**
	 * Manifests with download URLs through the configured mirrors. Local
	 * names and hashes do not depend on mirrors, so changing a mirror never
	 * invalidates installed files; a running download keeps the URLs it
	 * started with.
	 */
	getAssets(): AssetEntry[] {
		const { hfEndpoint, githubMirror } = this.host.settings.semantic;
		return getAllAssets(this.host.manifest.version, { hfEndpoint, githubMirror });
	}

	getModelDir(): ResolvedModelDir {
		return resolveModelDir(this.host.settings.semantic.modelDir);
	}

	/** Probed once per session; adapters don't appear without a restart. */
	probe(): Promise<WebGpuProbeResult> {
		if (!this.probeResult) {
			this.probeResult = probeWebGpu();
		}
		return this.probeResult;
	}

	getState(): InstallState {
		return this.manager.getState();
	}

	/** Usable right now: enabled by the user and files present. */
	isReady(): boolean {
		return this.host.settings.semantic.enabled && this.manager.getState().kind === "installed";
	}

	refresh(): Promise<InstallState> {
		return this.manager.refresh();
	}

	private async setEnabled(enabled: boolean): Promise<void> {
		if (this.host.settings.semantic.enabled !== enabled) {
			this.host.settings.semantic.enabled = enabled;
			await this.host.saveSettings();
		}
	}

	/** Download (or repair). Enables the feature once every file is verified. */
	async download(): Promise<void> {
		const result = await this.manager.download();
		if (result.ok) {
			await this.setEnabled(true);
			new Notice(t("Semantic search model installed"));
			return;
		}
		if (result.cancelled) {
			new Notice(t("Semantic search download cancelled"));
			return;
		}
		if (result.error) {
			new Notice(`${t("Semantic search download failed")}: ${describeDownloadError(result.error)}`);
		}
	}

	cancel(): void {
		this.manager.cancel();
	}

	async verify(): Promise<VerifyResult> {
		const result = await this.manager.verify();
		if (result.cancelled) {
			return result;
		}
		if (result.ok) {
			new Notice(t("Semantic search files verified"));
		} else {
			await this.setEnabled(false);
			new Notice(t("Semantic search files need repair"));
		}
		return result;
	}

	/**
	 * Turn the feature on (after a full hash check) or off. Turning it off
	 * keeps the downloaded files.
	 */
	async toggle(enabled: boolean): Promise<boolean> {
		if (!enabled) {
			await this.setEnabled(false);
			return false;
		}
		const probe = await this.probe();
		if (!probe.ok) {
			return false;
		}
		const result = await this.manager.verify();
		await this.setEnabled(result.ok);
		if (!result.ok && !result.cancelled) {
			new Notice(t("Semantic search files need repair"));
		}
		return result.ok;
	}

	async deleteModel(): Promise<DeleteResult> {
		const result = await this.manager.deleteFiles();
		await this.setEnabled(false);
		if (result.failed.length > 0) {
			new Notice(`${t("Some semantic search files could not be deleted")}: ${result.failed.join(", ")}`);
		} else {
			new Notice(t("Semantic search model deleted"));
		}
		return result;
	}

	/** Re-check after the model directory setting changed. */
	async onModelDirChanged(): Promise<void> {
		const state = await this.manager.refresh();
		if (state.kind !== "installed") {
			await this.setEnabled(false);
		}
	}

	dispose(): void {
		this.manager.cancel();
	}
}

export function describeDownloadError(error: DownloadError): string {
	switch (error.code) {
		case "http":
			return `${t("Server returned an error")} (${error.status ?? "?"})`;
		case "network":
			return `${t("Network error")}: ${error.message}`;
		case "size-mismatch":
		case "hash-mismatch":
			return t("Downloaded file failed the integrity check");
		case "locked":
			return t("Another download into this directory is in progress");
		case "too-many-redirects":
		case "insecure-redirect":
			return t("Download source redirected unexpectedly");
		case "fs":
			return `${t("Could not write to the model directory")}: ${error.message}`;
		default:
			return error.message;
	}
}
