import { MinioSettings, SmMsSettings, GithubSettings, AliyunSettings, TencentSettings, QiniuSettings, UpyunSettings, ImgurSettings, R2Settings, DEFAULT_MINIO_SETTINGS, DEFAULT_SMMS_SETTINGS, DEFAULT_GITHUB_SETTINGS, DEFAULT_ALIYUN_SETTINGS, DEFAULT_TENCENT_SETTINGS, DEFAULT_QINIU_SETTINGS, DEFAULT_UPYUN_SETTINGS, DEFAULT_IMGUR_SETTINGS, DEFAULT_R2_SETTINGS, ProviderSettingsMap } from '../types/settings';
import { IOssProvider } from '../types/oss';
import { MinioProvider } from './MinioProvider';
import { SmMsProvider } from './SmMsProvider';
import { GithubProvider } from './GithubProvider';
import { AliyunProvider } from './AliyunProvider';
import { TencentProvider } from './TencentProvider';
import { QiniuProvider } from './QiniuProvider';
import { UpyunProvider } from './UpyunProvider';
import { ImgurProvider } from './ImgurProvider';
import { R2Provider } from './R2Provider';

export interface ProviderCapabilities {
    upload: boolean;
    list: boolean;
    delete: boolean;
}

export interface ProviderRegistryEntry<K extends keyof ProviderSettingsMap = keyof ProviderSettingsMap> {
    id: K;
    label: string;
    capabilities: ProviderCapabilities;
    defaultSettings: ProviderSettingsMap[K];
    isConfigured(settings: ProviderSettingsMap[K]): boolean;
    create(settings: ProviderSettingsMap[K]): IOssProvider;
}

const PROVIDER_ENTRIES: ProviderRegistryEntry[] = [
    {
        id: 'smms',
        label: 'SM.MS',
        capabilities: { upload: true, list: true, delete: true },
        defaultSettings: DEFAULT_SMMS_SETTINGS,
        isConfigured: (settings) => Boolean((settings as SmMsSettings).token),
        create: (settings) => new SmMsProvider(settings as SmMsSettings),
    },
    {
        id: 'github',
        label: 'GitHub',
        capabilities: { upload: true, list: true, delete: true },
        defaultSettings: DEFAULT_GITHUB_SETTINGS,
        isConfigured: (settings) => {
            const github = settings as GithubSettings;
            return Boolean(github.repo && github.token);
        },
        create: (settings) => new GithubProvider(settings as GithubSettings),
    },
    {
        id: 'aliyun',
        label: 'Aliyun OSS',
        capabilities: { upload: true, list: true, delete: true },
        defaultSettings: DEFAULT_ALIYUN_SETTINGS,
        isConfigured: (settings) => {
            const aliyun = settings as AliyunSettings;
            return Boolean(aliyun.accessKeyId && aliyun.accessKeySecret && aliyun.bucket);
        },
        create: (settings) => new AliyunProvider(settings as AliyunSettings),
    },
    {
        id: 'tencent',
        label: 'Tencent COS',
        capabilities: { upload: true, list: true, delete: true },
        defaultSettings: DEFAULT_TENCENT_SETTINGS,
        isConfigured: (settings) => {
            const tencent = settings as TencentSettings;
            return Boolean(tencent.secretId && tencent.secretKey && tencent.bucket);
        },
        create: (settings) => new TencentProvider(settings as TencentSettings),
    },
    {
        id: 'qiniu',
        label: 'Qiniu',
        capabilities: { upload: true, list: true, delete: true },
        defaultSettings: DEFAULT_QINIU_SETTINGS,
        isConfigured: (settings) => {
            const qiniu = settings as QiniuSettings;
            return Boolean(qiniu.accessKey && qiniu.secretKey && qiniu.bucket);
        },
        create: (settings) => new QiniuProvider(settings as QiniuSettings),
    },
    {
        id: 'upyun',
        label: 'Upyun',
        capabilities: { upload: true, list: true, delete: true },
        defaultSettings: DEFAULT_UPYUN_SETTINGS,
        isConfigured: (settings) => {
            const upyun = settings as UpyunSettings;
            return Boolean(upyun.operator && upyun.password && upyun.bucket);
        },
        create: (settings) => new UpyunProvider(settings as UpyunSettings),
    },
    {
        id: 'imgur',
        label: 'Imgur',
        capabilities: { upload: true, list: false, delete: false },
        defaultSettings: DEFAULT_IMGUR_SETTINGS,
        isConfigured: (settings) => Boolean((settings as ImgurSettings).clientId),
        create: (settings) => new ImgurProvider(settings as ImgurSettings),
    },
    {
        id: 'r2',
        label: 'Cloudflare R2',
        capabilities: { upload: true, list: true, delete: true },
        defaultSettings: DEFAULT_R2_SETTINGS,
        isConfigured: (settings) => {
            const r2 = settings as R2Settings;
            return Boolean(r2.accountId && r2.accessKeyId && r2.secretAccessKey && r2.bucket);
        },
        create: (settings) => new R2Provider(settings as R2Settings),
    },
    {
        id: 'minio',
        label: 'MinIO',
        capabilities: { upload: true, list: true, delete: true },
        defaultSettings: DEFAULT_MINIO_SETTINGS,
        isConfigured: (settings) => {
            const minio = settings as MinioSettings;
            return Boolean(minio.endpoint && minio.accessKey && minio.secretKey && minio.bucket);
        },
        create: (settings) => new MinioProvider(settings as MinioSettings),
    },
];

/**
 * Provider registry - single source of truth for all provider metadata.
 * To add a new provider, only add an entry to PROVIDER_ENTRIES above.
 */
export class ProviderRegistry {
    private entries: Map<string, ProviderRegistryEntry> = new Map();

    constructor() {
        for (const entry of PROVIDER_ENTRIES) {
            this.entries.set(entry.id, entry);
        }
    }

    get(id: string): ProviderRegistryEntry | undefined {
        return this.entries.get(id);
    }

    getAll(): ProviderRegistryEntry[] {
        return Array.from(this.entries.values());
    }

    getAllIds(): string[] {
        return Array.from(this.entries.keys());
    }

    getCapabilities(id: string): ProviderCapabilities | undefined {
        return this.entries.get(id)?.capabilities;
    }

    supports(id: string, capability: keyof ProviderCapabilities): boolean {
        return Boolean(this.entries.get(id)?.capabilities[capability]);
    }

    isConfigured(id: string, settings: ProviderSettingsMap[keyof ProviderSettingsMap] | undefined): boolean {
        const entry = this.entries.get(id);
        if (!entry || !settings) {
            return false;
        }
        return entry.isConfigured(settings as never);
    }

    /**
     * Build a complete default ProviderSettingsMap from registry entries.
     */
    buildDefaultProviderSettings(): ProviderSettingsMap {
        const result: Record<string, any> = {};
        for (const entry of this.entries.values()) {
            result[entry.id] = { ...entry.defaultSettings };
        }
        return result as ProviderSettingsMap;
    }

    /**
     * Create a provider instance by id with settings.
     */
    createProvider(id: string, settings: any): IOssProvider {
        const entry = this.entries.get(id);
        if (!entry) {
            throw new Error(`Unknown provider: ${id}`);
        }
        return entry.create(settings);
    }
}

/** Singleton registry instance */
export const providerRegistry = new ProviderRegistry();
