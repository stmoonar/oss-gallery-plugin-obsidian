import { App } from "obsidian";
import { IOssProvider } from "../types/oss";
import { PluginSettings } from "../types/settings";
import { providerRegistry } from "./registry";

export class OssProviderManager {
    private providers: Map<string, IOssProvider> = new Map();
    private activeProviderName: string;
    /** JSON of each provider's settings at the time its instance was created. */
    private snapshots: Map<string, string> = new Map();

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
            const snapshot = JSON.stringify(providerSettings ?? null);
            if (this.providers.has(entry.id) && this.snapshots.get(entry.id) === snapshot) {
                // Unchanged settings: keep the instance (views compare by identity).
                continue;
            }

            this.snapshots.set(entry.id, snapshot);
            if (providerSettings) {
                this.providers.set(entry.id, entry.create(providerSettings, this.app));
            } else {
                this.providers.delete(entry.id);
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
        // Only re-create providers whose settings actually changed.
        this.initializeProviders();
    }
}
