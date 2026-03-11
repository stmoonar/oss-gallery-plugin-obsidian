import { App, FileSystemAdapter, Platform } from 'obsidian';
import { MinioSettings, SmMsSettings, GithubSettings, AliyunSettings, TencentSettings, QiniuSettings, UpyunSettings, ImgurSettings, R2Settings, S3Settings, LocalSettings, DEFAULT_MINIO_SETTINGS, DEFAULT_SMMS_SETTINGS, DEFAULT_GITHUB_SETTINGS, DEFAULT_ALIYUN_SETTINGS, DEFAULT_TENCENT_SETTINGS, DEFAULT_QINIU_SETTINGS, DEFAULT_UPYUN_SETTINGS, DEFAULT_IMGUR_SETTINGS, DEFAULT_R2_SETTINGS, DEFAULT_S3_SETTINGS, DEFAULT_LOCAL_SETTINGS, ProviderSettingsMap } from '../types/settings';
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
import { S3Provider } from './S3Provider';
import { LocalProvider } from './LocalProvider';

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
    isAvailable?(app?: App): boolean;
    isConfigured(settings: ProviderSettingsMap[K], app?: App): boolean;
    create(settings: ProviderSettingsMap[K], app?: App): IOssProvider;
}

const PROVIDER_ENTRIES: ProviderRegistryEntry[] = [
    {
        id: 'local',
        label: 'Local',
        capabilities: { upload: true, list: true, delete: true },
        defaultSettings: DEFAULT_LOCAL_SETTINGS,
        isAvailable: () => Platform.isDesktopApp,
        isConfigured: (settings, app) => {
            const local = settings as LocalSettings;
            if (!Platform.isDesktopApp || !local.storagePath) {
                return false;
            }

            if (!local.useRelativePath) {
                return true;
            }

            return Boolean(app?.vault.adapter instanceof FileSystemAdapter);
        },
        create: (settings, app) => new LocalProvider(settings as LocalSettings, app!),
    },
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
        id: 's3',
        label: 'S3',
        capabilities: { upload: true, list: true, delete: true },
        defaultSettings: DEFAULT_S3_SETTINGS,
        isConfigured: (settings) => {
            const s3 = settings as S3Settings;
            return Boolean(s3.endpoint && s3.accessKeyId && s3.secretAccessKey && s3.bucket);
        },
        create: (settings) => new S3Provider(settings as S3Settings),
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

    private isEntryAvailable(entry: ProviderRegistryEntry, app?: App): boolean {
        return entry.isAvailable ? entry.isAvailable(app) : true;
    }

    get(id: string, app?: App): ProviderRegistryEntry | undefined {
        const entry = this.entries.get(id);
        if (!entry || !this.isEntryAvailable(entry, app)) {
            return undefined;
        }
        return entry;
    }

    getAll(app?: App): ProviderRegistryEntry[] {
        return Array.from(this.entries.values()).filter((entry) =>
            this.isEntryAvailable(entry, app)
        );
    }

    getAllIds(app?: App): string[] {
        return this.getAll(app).map((entry) => entry.id);
    }

    getCapabilities(id: string, app?: App): ProviderCapabilities | undefined {
        return this.get(id, app)?.capabilities;
    }

    supports(id: string, capability: keyof ProviderCapabilities, app?: App): boolean {
        return Boolean(this.get(id, app)?.capabilities[capability]);
    }

    isConfigured(
        id: string,
        settings: ProviderSettingsMap[keyof ProviderSettingsMap] | undefined,
        app?: App
    ): boolean {
        const entry = this.get(id, app);
        if (!entry || !settings) {
            return false;
        }
        return entry.isConfigured(settings as never, app);
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
    createProvider(id: string, settings: any, app?: App): IOssProvider {
        const entry = this.get(id, app);
        if (!entry) {
            throw new Error(`Unknown provider: ${id}`);
        }
        return entry.create(settings, app);
    }
}

/** Singleton registry instance */
export const providerRegistry = new ProviderRegistry();
