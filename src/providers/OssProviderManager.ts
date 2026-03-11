import { App } from "obsidian";
import { IOssProvider } from "../types/oss";
import { PluginSettings } from "../types/settings";
import { providerRegistry } from "./registry";

export class OssProviderManager {
    private providers: Map<string, IOssProvider> = new Map();
    private activeProviderName: string;

    constructor(private settings: PluginSettings, private app: App) {
        this.activeProviderName = settings.activeProvider;
        this.initializeProviders();
    }

    /**
     * Create all provider instances from registry
     */
    private initializeProviders(): void {
        for (const entry of providerRegistry.getAll(this.app)) {
            const providerSettings = this.settings.providers[entry.id];
            if (providerSettings) {
                this.providers.set(entry.id, entry.create(providerSettings, this.app));
            }
        }
    }

    getProvider(name: string): IOssProvider | undefined {
        return this.providers.get(name);
    }

    getActiveProvider(): IOssProvider | undefined {
        return this.providers.get(this.activeProviderName);
    }

    setActiveProvider(name: string) {
        if (this.providers.has(name)) {
            this.activeProviderName = name;
        } else {
            throw new Error(`Provider ${name} not found`);
        }
    }

    getAllProviders(): IOssProvider[] {
        return Array.from(this.providers.values());
    }

    updateSettings(settings: PluginSettings) {
        this.settings = settings;
        this.activeProviderName = settings.activeProvider;
        // Re-create providers with new settings
        this.providers.clear();
        this.initializeProviders();
    }
}
