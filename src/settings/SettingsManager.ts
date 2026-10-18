import { App, ButtonComponent, DropdownComponent, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { PluginSettings, ProviderName, NameRule, PathRule } from '../types/settings';
import { t } from '../i18n';
import { OssProviderManager } from '../providers/OssProviderManager';
import { providerRegistry, ProviderRegistryEntry } from '../providers/registry';
import { providerSecrets } from '../providers/requiredFields';
import { SemanticController } from '../semantic/SemanticController';
import { SemanticSettingsSection } from './SemanticSettingsSection';
import { ThumbnailSettingsSection } from './ThumbnailSettingsSection';
import {
    formatMissingSummary,
    providerOptionLabel,
    sanitizeErrorMessage,
    withTimeout,
} from './settingsUx';
import type { GalleryThumbnails } from '../thumbnails/GalleryThumbnails';

/**
 * The host plugin as seen by the settings tab. Declared as an interface that
 * re-declares `settings`, so it refers to our own field rather than
 * Obsidian 1.13's optional `Plugin.settings` (flagged by no-unsupported-api).
 */
interface SettingsHost extends Plugin {
    settings: PluginSettings;
    saveSettings(): Promise<void>;
}

/** A connection test that takes longer than this is reported as failed. */
const CONNECTION_TEST_TIMEOUT_MS = 20_000;

type ResultKind = 'pending' | 'success' | 'error';

export class SettingsManager extends PluginSettingTab {
    plugin: SettingsHost;
    private providerManager: OssProviderManager;
    private semanticSection: SemanticSettingsSection;
    private thumbnailSection: ThumbnailSettingsSection;
    private providerDropdown: DropdownComponent | null = null;
    /** Rows of the active provider's required fields, by field key. */
    private requiredRows = new Map<string, HTMLElement>();
    private providerStatusEl: HTMLElement | null = null;
    /** Drops connection test results that arrive after a re-render. */
    private connectionToken = 0;

    constructor(
        app: App,
        plugin: SettingsHost,
        providerManager: OssProviderManager,
        semantic: SemanticController,
        thumbnails: GalleryThumbnails
    ) {
        super(app, plugin);
        this.plugin = plugin;
        this.providerManager = providerManager;
        this.semanticSection = new SemanticSettingsSection(app, plugin, semantic);
        this.thumbnailSection = new ThumbnailSettingsSection(plugin, thumbnails);
    }

    hide(): void {
        // Stop repainting download progress; the download itself continues.
        this.semanticSection.dispose();
        this.thumbnailSection.dispose();
        this.connectionToken++;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        this.connectionToken++;
        this.requiredRows.clear();
        this.providerStatusEl = null;

        this.renderProviderSelect(containerEl);

        // Active Provider Settings
        const activeProvider = this.providerManager.getActiveProvider();
        const registryEntry = providerRegistry.get(this.plugin.settings.activeProvider, this.app);
        if (activeProvider && registryEntry) {
            new Setting(containerEl)
                .setName(registryEntry.label)
                .setHeading();

            const providerEl = containerEl.createDiv({ cls: 'oss-gallery-provider-settings' });
            activeProvider.renderSettings(
                providerEl,
                this.plugin.settings,
                async () => {
                    await this.plugin.saveSettings();
                    this.refreshProviderStatus();
                }
            );
            this.markRequiredFields(providerEl, registryEntry);
            this.providerStatusEl = containerEl.createDiv({ cls: 'oss-gallery-provider-status' });
            this.renderConnectionTest(containerEl, registryEntry);
            this.refreshProviderStatus();
        }

        // Object Rules Settings
        this.createObjectRulesSettings(containerEl);

        // Inserted link settings
        this.createLinkSettings(containerEl);

        // Local gallery thumbnails (independent of semantic search)
        this.thumbnailSection.render(containerEl);

        // Semantic search (optional, downloads on request)
        this.semanticSection.render(containerEl);
    }

    private providerSettingsOf(id: string): unknown {
        return this.plugin.settings.providers[id as ProviderName];
    }

    private isProviderConfigured(entry: ProviderRegistryEntry): boolean {
        return providerRegistry.isConfigured(entry.id, this.plugin.settings.providers[entry.id], this.app);
    }

    private optionLabel(entry: ProviderRegistryEntry): string {
        return providerOptionLabel(
            {
                label: entry.label,
                uploadOnly: !entry.capabilities.list,
                configured: this.isProviderConfigured(entry),
            },
            {
                uploadOnly: t('Provider option upload only'),
                notConfigured: t('Provider option not configured'),
            }
        );
    }

    /** One line under the dropdown: what the selected provider can do. */
    private capabilityHint(entry: ProviderRegistryEntry): string {
        const hint = entry.capabilities.list
            ? t(entry.capabilities.delete ? 'Provider capability full' : 'Provider capability no delete')
            : t('Provider capability upload only');
        return entry.acceptedFileTypes?.length === 1 && entry.acceptedFileTypes[0] === 'image'
            ? `${hint} ${t('Provider capability images only')}`
            : hint;
    }

    private renderProviderSelect(containerEl: HTMLElement): void {
        const entries = providerRegistry.getAll(this.app);
        const active = providerRegistry.get(this.plugin.settings.activeProvider, this.app);
        const setting = new Setting(containerEl)
            .setName(t('Select Provider'))
            .setDesc(t('Choose the OSS provider you want to use'))
            .addDropdown(dropdown => {
                this.providerDropdown = dropdown;
                for (const e of entries) {
                    dropdown.addOption(e.id, this.optionLabel(e));
                }
                dropdown.setValue(this.plugin.settings.activeProvider)
                    .onChange((value) => {
                        this.plugin.settings.activeProvider = value as ProviderName;
                        this.providerManager.setActiveProvider(value);
                        // Refresh to show new provider settings once saved
                        void this.plugin.saveSettings().then(() => this.display());
                    });
            });
        if (active) {
            setting.descEl.createDiv({ cls: 'oss-gallery-provider-capability', text: this.capabilityHint(active) });
        }
    }

    /**
     * Mark the rows of required fields. Provider renderers name their rows
     * with the same locale keys as ./requiredFields.ts, so rows are matched
     * by their name.
     */
    private markRequiredFields(providerEl: HTMLElement, entry: ProviderRegistryEntry): void {
        const specs = entry.requiredFields ?? [];
        if (specs.length === 0) {
            return;
        }
        const rows = Array.from(providerEl.querySelectorAll<HTMLElement>('.setting-item'));
        for (const spec of specs) {
            const label = t(spec.label);
            const row = rows.find((r) => r.querySelector('.setting-item-name')?.textContent?.trim() === label);
            const nameEl = row?.querySelector<HTMLElement>('.setting-item-name');
            if (!row || !nameEl) {
                continue;
            }
            row.addClass('oss-gallery-required-field');
            nameEl.createSpan({
                cls: 'oss-gallery-required-marker',
                text: t('Required'),
            });
            this.requiredRows.set(spec.field, row);
        }
    }

    /** "Missing: ..." line, required markers and the dropdown option text. */
    private refreshProviderStatus(): void {
        const id = this.plugin.settings.activeProvider;
        const entry = providerRegistry.get(id, this.app);
        if (!entry) {
            return;
        }
        const missing = providerRegistry.getMissingFields(id, this.providerSettingsOf(id));
        const missingFields = new Set(missing.map((spec) => spec.field));
        for (const [field, row] of this.requiredRows) {
            row.toggleClass('is-missing', missingFields.has(field));
        }
        const el = this.providerStatusEl;
        if (el) {
            el.empty();
            if (missing.length > 0) {
                el.addClass('is-missing');
                el.setText(formatMissingSummary(
                    missing.map((spec) => t(spec.label)),
                    t('Missing required fields'),
                    t('List separator')
                ));
            } else {
                el.removeClass('is-missing');
                el.setText(t('Required fields complete'));
            }
        }
        const option = Array.from(this.providerDropdown?.selectEl.options ?? []).find((o) => o.value === id);
        if (option) {
            option.text = this.optionLabel(entry);
        }
    }

    /**
     * "Test connection": one cheap read-only request through the provider
     * (`testConnection`). Upload-only providers can be checked only by
     * uploading, which this never does.
     */
    private renderConnectionTest(containerEl: HTMLElement, entry: ProviderRegistryEntry): void {
        const provider = this.providerManager.getActiveProvider();
        const setting = new Setting(containerEl).setName(t('Test connection'));
        if (!entry.capabilities.list || !provider?.testConnection) {
            setting.setDesc(t('Test connection upload only'));
            return;
        }
        setting.setDesc(t('Test connection description'));
        const resultEl = setting.descEl.createDiv({ cls: 'oss-gallery-connection-result' });
        resultEl.hide();
        setting.addButton((btn) => btn
            .setButtonText(t('Test connection'))
            .onClick(() => {
                void this.runConnectionTest(btn, resultEl);
            }));
    }

    private showResult(el: HTMLElement, kind: ResultKind, text: string): void {
        el.removeClass('is-pending', 'is-success', 'is-error');
        el.addClass(`is-${kind}`);
        el.setText(text);
        el.show();
    }

    private async runConnectionTest(btn: ButtonComponent, resultEl: HTMLElement): Promise<void> {
        const token = ++this.connectionToken;
        const id = this.plugin.settings.activeProvider;
        const providerSettings = this.providerSettingsOf(id);
        const missing = providerRegistry.getMissingFields(id, providerSettings);
        if (missing.length > 0) {
            this.showResult(resultEl, 'error', formatMissingSummary(
                missing.map((spec) => t(spec.label)),
                t('Test connection missing fields'),
                t('List separator')
            ));
            return;
        }
        const provider = this.providerManager.getActiveProvider();
        if (!provider?.testConnection) {
            return;
        }
        btn.setDisabled(true);
        this.showResult(resultEl, 'pending', t('Test connection running'));
        try {
            await withTimeout(
                provider.testConnection(),
                CONNECTION_TEST_TIMEOUT_MS,
                () => new Error(t('Test connection timed out')
                    .replace('{seconds}', String(CONNECTION_TEST_TIMEOUT_MS / 1000))),
                {
                    set: (fn, ms) => window.setTimeout(fn, ms),
                    clear: (handle) => window.clearTimeout(handle as number),
                }
            );
            if (token === this.connectionToken) {
                this.showResult(resultEl, 'success', t('Test connection success'));
            }
        } catch (error) {
            if (token === this.connectionToken) {
                const message = error instanceof Error ? error.message : String(error);
                this.showResult(resultEl, 'error', t('Test connection failed')
                    .replace('{message}', sanitizeErrorMessage(message, providerSecrets(providerSettings))));
            }
        } finally {
            btn.setDisabled(false);
        }
    }

    /**
     * Create object rules settings
     */
    private createObjectRulesSettings(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(t('Object rules'))
            .setHeading();

        new Setting(containerEl)
            .setName(t('Base path'))
            .setDesc(t('Base path description'))
            .addText(text => text
                .setPlaceholder(t('Enter your base path(e.g. /path)'))
                .setValue(this.plugin.settings.basepath || '')
                .onChange(async value => {
                    this.plugin.settings.basepath = value;
                    await this.plugin.saveSettings();
                }));

        // Naming rules
        new Setting(containerEl)
            .setName(t('Object naming rules'))
            .setDesc(t('Naming rules description'))
            .addDropdown((select) => select
                .addOption('local', t('Local file name'))
                .addOption('time', t('Time file name'))
                .addOption('timeAndLocal', t('Time and local file name'))
                .setValue(this.plugin.settings.nameRule)
                .onChange(async value => {
                    this.plugin.settings.nameRule = value as NameRule;
                    await this.plugin.saveSettings();
                }));

        // Path rules
        new Setting(containerEl)
            .setName(t('Object path rules'))
            .setDesc(t('Object path rules description'))
            .addDropdown((select) => select
                .addOption('root', t('Root directory'))
                .addOption('type', t('File type directory'))
                .addOption('date', t('Date directory'))
                .addOption('typeAndDate', t('File type and date directory'))
                .setValue(this.plugin.settings.pathRule)
                .onChange(async value => {
                    this.plugin.settings.pathRule = value as PathRule;
                    await this.plugin.saveSettings();
                }));
    }

    /**
     * What gets inserted into the note after an upload (EmbedRenderer):
     * an embed / player / viewer, or a plain link.
     */
    private createLinkSettings(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(t('Inserted links'))
            .setDesc(t('Inserted links description'))
            .setHeading();

        // Embed format (only used while images are embedded)
        let embedFormatSetting: Setting | null = null;

        // Image preview
        new Setting(containerEl)
            .setName(t('Image preview'))
            .setDesc(t('Image preview description'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.imgPreview)
                .onChange(async (value) => {
                    this.plugin.settings.imgPreview = value;
                    embedFormatSetting?.settingEl.toggle(value);
                    await this.plugin.saveSettings();
                }));

        embedFormatSetting = new Setting(containerEl)
            .setName(t('Embed format'))
            .setDesc(t('Embed format description'))
            .addText(text => text
                .setPlaceholder('![]($URL)')
                .setValue(this.plugin.settings.embedFormat || '![]($URL)')
                .onChange(async value => {
                    this.plugin.settings.embedFormat = value || '![]($URL)';
                    await this.plugin.saveSettings();
                }));
        embedFormatSetting.settingEl.addClass('oss-gallery-setting-indented');
        embedFormatSetting.settingEl.toggle(this.plugin.settings.imgPreview);

        // Video preview
        new Setting(containerEl)
            .setName(t('Video preview'))
            .setDesc(t('Video preview description'))
            .addToggle(text => text
                .setValue(this.plugin.settings.videoPreview)
                .onChange(async (value) => {
                    this.plugin.settings.videoPreview = value;
                    await this.plugin.saveSettings();
                }));

        // Audio preview
        new Setting(containerEl)
            .setName(t('Audio preview'))
            .setDesc(t('Audio preview description'))
            .addToggle(text => text
                .setValue(this.plugin.settings.audioPreview)
                .onChange(async (value) => {
                    this.plugin.settings.audioPreview = value;
                    await this.plugin.saveSettings();
                }));

        // Docs preview
        new Setting(containerEl)
            .setName(t('Docs preview'))
            .setDesc(t('Docs preview description'))
            .addDropdown((select) => select
                .addOption('', t('Disabled'))
                .addOption('https://docs.google.com/viewer?url=', t('Google docs'))
                .addOption('https://view.officeapps.live.com/op/view.aspx?src=', t('Office online'))
                .setValue(this.plugin.settings.docsPreview)
                .onChange(async value => {
                    this.plugin.settings.docsPreview = value;
                    await this.plugin.saveSettings();
                }));
    }
}
