import { IOssProvider } from "../types/oss";
import { PluginSettings } from "../types/settings";

export class OssProviderManager {
    private providers: Map<string, IOssProvider> = new Map();
    private activeProviderName: string;

    constructor(private settings: PluginSettings) {
        this.activeProviderName = settings.activeProvider;
    }

    registerProvider(provider: IOssProvider) {
        this.providers.set(provider.name, provider);
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
    }
}
