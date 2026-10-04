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
	mergeWithDefaults,
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
	imgPreview?: unknown;
	videoPreview?: unknown;
	audioPreview?: unknown;
	docsPreview?: unknown;
	nameRule?: unknown;
	pathRule?: unknown;
}

/**
 * Name rule for stored settings that predate (or lack) an explicit nameRule.
 * Older versions defaulted to "local", so keep it for existing installs; only
 * fresh installs get the new DEFAULT_SETTINGS.nameRule.
 */
const EXISTING_INSTALL_NAME_RULE: NameRule = "local";

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
	// Per-field, type-checked merge driven by the default object's keys and
	// value types. Stored values are adopted only when their type matches the
	// default (numeric strings accepted for number fields); mismatched values
	// fall back to defaults and unknown fields are discarded.
	return mergeWithDefaults(
		defaultSettings as unknown as Record<string, unknown>,
		storedSettings
	) as unknown as ProviderSettingsMap[K];
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
		imgPreview: getBoolean(stored.imgPreview) ?? defaults.imgPreview,
		videoPreview: getBoolean(stored.videoPreview) ?? defaults.videoPreview,
		audioPreview: getBoolean(stored.audioPreview) ?? defaults.audioPreview,
		docsPreview: getString(stored.docsPreview) ?? defaults.docsPreview,
		nameRule: isNameRule(stored.nameRule)
			? stored.nameRule
			: EXISTING_INSTALL_NAME_RULE,
		pathRule: isPathRule(stored.pathRule)
			? stored.pathRule
			: defaults.pathRule,
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

/**
 * Whether stored data uses the legacy MinIO-only shape (no `providers` map)
 * and therefore needs to be migrated and saved once.
 */
export function isLegacyStoredSettings(storedValue: unknown): boolean {
	const stored = getRecord(storedValue);
	return stored !== undefined && stored.providers === undefined;
}

export function loadStoredSettings(storedValue: unknown): PluginSettings {
	const defaults = createDefaultSettings();
	const stored = getRecord(storedValue);

	if (!stored) {
		return defaults;
	}

	if (stored.providers === undefined) {
		return migrateLegacyMinioSettings(
			stored,
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
		embedFormat: getString(stored.embedFormat) ?? defaults.embedFormat,
		nameRule: isNameRule(stored.nameRule)
			? stored.nameRule
			: EXISTING_INSTALL_NAME_RULE,
		pathRule: isPathRule(stored.pathRule)
			? stored.pathRule
			: defaults.pathRule,
		providers: mergeStoredProviders(stored.providers),
	};
}
