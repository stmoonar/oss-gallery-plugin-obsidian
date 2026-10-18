import { debounce, Setting } from "obsidian";
import { t } from "../i18n";
import { formatMegabytes } from "../semantic/format";
import { formatCount } from "../semantic/statusText";
import type { GalleryThumbnails } from "../thumbnails/GalleryThumbnails";
import type { PluginSettings } from "../types/settings";
import { THUMBNAIL_CACHE_MAX_MB, THUMBNAIL_CACHE_MIN_MB } from "../types/settings";
import { setDestructiveButton } from "../utils/buttonStyle";
import { parseThumbnailCacheMB } from "./loadStoredSettings";
import { createSettingsSection } from "./settingGroups";

interface ThumbnailSettingsHost {
	settings: PluginSettings;
	saveSettings(): Promise<void>;
}

/**
 * "Gallery thumbnails" block of the settings tab: on/off, cache size cap,
 * count and size, "Clear thumbnails". Independent of semantic search:
 * "Clear thumbnails" never touches the index or the model, and their
 * actions never touch thumbnails.
 */
export class ThumbnailSettingsSection {
	private statsEl: HTMLElement | null = null;
	/** Drops stats that arrive after a newer request. */
	private statsToken = 0;

	constructor(private readonly host: ThumbnailSettingsHost, private readonly thumbnails: GalleryThumbnails) {}

	render(parentEl: HTMLElement): void {
		const settings = this.host.settings.thumbnails;
		const containerEl = createSettingsSection(parentEl, { heading: t("Gallery thumbnails") });

		new Setting(containerEl)
			.setName(t("Local thumbnails"))
			.setDesc(t("Local thumbnails description"))
			.addToggle((toggle) => toggle
				.setValue(settings.enabled)
				.onChange(async (value) => {
					this.host.settings.thumbnails.enabled = value;
					await this.host.saveSettings();
				}));

		const capSetting = new Setting(containerEl)
			.setName(t("Thumbnail cache size"))
			.setDesc(t("Thumbnail cache size description")
				.replace("{min}", String(THUMBNAIL_CACHE_MIN_MB))
				.replace("{max}", String(THUMBNAIL_CACHE_MAX_MB)));
		const errorEl = capSetting.descEl.createDiv({ cls: "oss-gallery-setting-error" });
		errorEl.hide();
		const save = debounce(async () => {
			await this.host.saveSettings();
			this.refreshStats();
		}, 600, true);
		capSetting.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.min = String(THUMBNAIL_CACHE_MIN_MB);
			text.inputEl.max = String(THUMBNAIL_CACHE_MAX_MB);
			text
				.setPlaceholder("500")
				.setValue(String(settings.maxSizeMB))
				.onChange((value) => {
					const mb = parseThumbnailCacheMB(value.trim());
					if (mb === undefined) {
						errorEl.setText(t("Thumbnail cache size invalid")
							.replace("{min}", String(THUMBNAIL_CACHE_MIN_MB))
							.replace("{max}", String(THUMBNAIL_CACHE_MAX_MB)));
						errorEl.show();
						return;
					}
					errorEl.hide();
					if (mb !== this.host.settings.thumbnails.maxSizeMB) {
						this.host.settings.thumbnails.maxSizeMB = mb;
						save();
					}
				});
		});

		const statsSetting = new Setting(containerEl)
			.setName(t("Thumbnails for this vault"))
			.addButton((btn) => {
				setDestructiveButton(btn
					.setButtonText(t("Clear thumbnails"))
					.onClick(() => this.thumbnails.confirmClear(() => this.refreshStats())));
			});
		this.statsEl = statsSetting.descEl.createDiv({ cls: "oss-gallery-thumbnail-stats" });
		this.refreshStats();
	}

	private refreshStats(): void {
		const el = this.statsEl;
		if (!el) {
			return;
		}
		const token = ++this.statsToken;
		if (el.getText() === "") {
			el.setText(t("Thumbnail stats loading"));
		}
		void this.thumbnails.stats().then((stats) => {
			if (token !== this.statsToken || this.statsEl !== el) {
				return;
			}
			el.setText(t("Thumbnail stats")
				.replace("{count}", formatCount(stats.count))
				.replace("{size}", formatMegabytes(stats.bytes))
				.replace("{cap}", formatMegabytes(this.host.settings.thumbnails.maxSizeMB * 1_000_000)));
		});
	}

	dispose(): void {
		this.statsEl = null;
	}
}
