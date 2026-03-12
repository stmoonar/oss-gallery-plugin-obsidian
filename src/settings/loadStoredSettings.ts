import { providerRegistry } from "../providers/registry";
import {
	DEFAULT_SETTINGS,
	NameRule,
	PathRule,
	PluginSettings,
	ProviderName,
	ProviderSettingsMap,
} from "../types/settings";
import {
	getBoolean,
	getNumber,
	getRecord,
	getString,
} from "../utils/typeGuards";

interface LegacyMinioSettings {
	basepath?: unknown;
	accessKey?: unknown;
	secretKey?: unknown;
	region?: unknown;
	bucket?: unknown;
	endpoint?: unknown;
	port?: unknown;
	customDomain?: unknown;
	useSSL?: unknown;
}

const PROVIDER_NAMES = Object.keys(
	DEFAULT_SETTINGS.providers
) as ProviderName[];

function isProviderName(value: unknown): value is ProviderName {
	return (
		typeof value === "string" &&
		PROVIDER_NAMES.includes(value as ProviderName)
	);
}

function isNameRule(value: unknown): value is NameRule {
	return value === "local" || value === "time" || value === "timeAndLocal";
}

function isPathRule(value: unknown): value is PathRule {
	return (
		value === "root" ||
		value === "type" ||
		value === "date" ||
		value === "typeAndDate"
	);
}

function createDefaultSettings(): PluginSettings {
	return {
		...DEFAULT_SETTINGS,
		providers: providerRegistry.buildDefaultProviderSettings(),
	};
}

function mergeProviderSettings<K extends ProviderName>(
	defaultSettings: ProviderSettingsMap[K],
	storedSettings: unknown
): ProviderSettingsMap[K] {
	const record = getRecord(storedSettings);
	if (!record) {
		return { ...defaultSettings };
	}

	return {
		...defaultSettings,
		...record,
	} as ProviderSettingsMap[K];
}

function setProviderSettings<K extends ProviderName>(
	target: ProviderSettingsMap,
	providerName: K,
	settings: ProviderSettingsMap[K]
): void {
	target[providerName] = settings;
}

function mergeStoredProviders(storedProviders: unknown): ProviderSettingsMap {
	const defaults = providerRegistry.buildDefaultProviderSettings();
	const merged = { ...defaults };
	const record = getRecord(storedProviders);

	for (const providerName of PROVIDER_NAMES) {
		setProviderSettings(
			merged,
			providerName,
			mergeProviderSettings(defaults[providerName], record?.[providerName])
		);
	}

	return merged;
}

function migrateLegacyMinioSettings(
	stored: LegacyMinioSettings,
	defaults: PluginSettings
): PluginSettings {
	return {
		...defaults,
		activeProvider: "minio",
		basepath: getString(stored.basepath) ?? defaults.basepath,
		providers: {
			...defaults.providers,
			minio: {
				...defaults.providers.minio,
				accessKey:
					getString(stored.accessKey) ?? defaults.providers.minio.accessKey,
				secretKey:
					getString(stored.secretKey) ?? defaults.providers.minio.secretKey,
				region: getString(stored.region) ?? defaults.providers.minio.region,
				bucket: getString(stored.bucket) ?? defaults.providers.minio.bucket,
				endpoint:
					getString(stored.endpoint) ?? defaults.providers.minio.endpoint,
				port: getNumber(stored.port) ?? defaults.providers.minio.port,
				customDomain:
					getString(stored.customDomain) ??
					defaults.providers.minio.customDomain,
				useSSL: getBoolean(stored.useSSL) ?? defaults.providers.minio.useSSL,
			},
		},
	};
}

export function loadStoredSettings(storedValue: unknown): PluginSettings {
	const defaults = createDefaultSettings();
	const stored = getRecord(storedValue);

	if (!stored) {
		return defaults;
	}

	if (stored.providers === undefined) {
		return migrateLegacyMinioSettings(
			stored as LegacyMinioSettings,
			defaults
		);
	}

	return {
		...defaults,
		activeProvider: isProviderName(stored.activeProvider)
			? stored.activeProvider
			: defaults.activeProvider,
		basepath: getString(stored.basepath) ?? defaults.basepath,
		imgPreview: getBoolean(stored.imgPreview) ?? defaults.imgPreview,
		videoPreview: getBoolean(stored.videoPreview) ?? defaults.videoPreview,
		audioPreview: getBoolean(stored.audioPreview) ?? defaults.audioPreview,
		docsPreview: getString(stored.docsPreview) ?? defaults.docsPreview,
		nameRule: isNameRule(stored.nameRule)
			? stored.nameRule
			: defaults.nameRule,
		pathRule: isPathRule(stored.pathRule)
			? stored.pathRule
			: defaults.pathRule,
		providers: mergeStoredProviders(stored.providers),
	};
}
