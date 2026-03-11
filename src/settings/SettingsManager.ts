import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { PluginSettings, ProviderName, NameRule, PathRule } from '../types/settings';
import { t } from '../i18n';
import { OssProviderManager } from '../providers/OssProviderManager';
import { providerRegistry } from '../providers/registry';

export class SettingsManager extends PluginSettingTab {
    plugin: Plugin & {
        settings: PluginSettings;
        saveSettings(): Promise<void>;
    };
    private providerManager: OssProviderManager;

    constructor(
        app: App, 
        plugin: Plugin & {
            settings: PluginSettings;
            saveSettings(): Promise<void>;
        },
        providerManager: OssProviderManager
    ) {
        super(app, plugin);
        this.plugin = plugin;
        this.providerManager = providerManager;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Provider Selection
        new Setting(containerEl)
            .setName(t('Select Provider'))
            .setDesc(t('Choose the OSS provider you want to use'))
            .addDropdown(dropdown => {
                const entries = providerRegistry.getAll(this.app);
                entries.forEach(e => dropdown.addOption(e.id, e.label));
                dropdown.setValue(this.plugin.settings.activeProvider)
                    .onChange(async (value) => {
                        this.plugin.settings.activeProvider = value as ProviderName;
                        this.providerManager.setActiveProvider(value);
                        await this.plugin.saveSettings();
                        this.display(); // Refresh to show new provider settings
                    });
            });

        // Active Provider Settings
        const activeProvider = this.providerManager.getActiveProvider();
        const registryEntry = providerRegistry.get(this.plugin.settings.activeProvider, this.app);
        if (activeProvider && registryEntry) {
            new Setting(containerEl)
                .setName(`${registryEntry.label} Settings`)
                .setHeading();

            activeProvider.renderSettings(
                containerEl,
                this.plugin.settings,
                async () => await this.plugin.saveSettings()
            );
        }

        // Object Rules Settings
        this.createObjectRulesSettings(containerEl);

        // Preview Settings
        this.createPreviewSettings(containerEl);
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
            .setDesc(t('Enter your base path(e.g. /path)'))
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
     * Create preview settings
     */
    private createPreviewSettings(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(t('Preview'))
            .setHeading();

        // Image preview
        new Setting(containerEl)
            .setName(t('Image preview'))
            .setDesc(t('Image preview description'))
            .addToggle(text => text
                .setValue(this.plugin.settings.imgPreview)
                .onChange(async (value) => {
                    this.plugin.settings.imgPreview = value;
                    await this.plugin.saveSettings();
                }));

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
