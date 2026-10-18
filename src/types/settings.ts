export interface MinioSettings {
    endpoint: string;
    port: number;
    useSSL: boolean;
    accessKey: string;
    secretKey: string;
    bucket: string;
    region: string;
    customDomain: string;
}

export interface SmMsSettings {
    token: string;
}

export interface GithubSettings {
    repo: string;
    branch: string;
    token: string;
    customUrl: string;
}

export interface AliyunSettings {
    accessKeyId: string;
    accessKeySecret: string;
    bucket: string;
    area: string;
    path: string;
    customUrl: string;
}

export interface TencentSettings {
    secretId: string;
    secretKey: string;
    bucket: string;
    region: string;
    path: string;
    customUrl: string;
}

export interface QiniuSettings {
    accessKey: string;
    secretKey: string;
    bucket: string;
    url: string;
    area: string;
    path: string;
}

export interface UpyunSettings {
    operator: string;
    password: string;
    bucket: string;
    url: string;
    path: string;
    suffix: string;
}

export interface ImgurSettings {
    clientId: string;
    proxy: string;
}

export interface R2Settings {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicUrl: string;
}

export interface S3Settings {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    useSSL: boolean;
    forcePathStyle: boolean;
    publicUrl: string;
}

export interface LocalSettings {
    storagePath: string;
    useRelativePath: boolean;
    deleteToTrash: boolean;
}

export interface ProviderSettingsMap {
    local: LocalSettings;
    smms: SmMsSettings;
    github: GithubSettings;
    aliyun: AliyunSettings;
    tencent: TencentSettings;
    qiniu: QiniuSettings;
    upyun: UpyunSettings;
    imgur: ImgurSettings;
    r2: R2Settings;
    s3: S3Settings;
    minio: MinioSettings;
}

export type ProviderName = keyof ProviderSettingsMap;
export type NameRule = 'local' | 'time' | 'timeAndLocal';
export type PathRule = 'root' | 'type' | 'date' | 'typeAndDate';
export type ImageTokenBudget = 70 | 140 | 280;
export const IMAGE_TOKEN_BUDGETS: readonly ImageTokenBudget[] = [70, 140, 280];

/** Semantic image search (docs/semantic-search.md §9.3). Global, not per provider. */
export interface SemanticSettings {
    /** True only after the runtime and model were downloaded and verified. */
    enabled: boolean;
    /** Directory for runtime + model files; '' = platform default (outside the vault). */
    modelDir: string;
    /**
     * Root of the per-device index files, '' = platform default
     * (<appDir>/indexes, next to the models). Outside the vault, never
     * synced: every device builds its own index.
     */
    indexDir: string;
    /** Image tokens per picture; changing it rebuilds every index. */
    imageTokenBudget: ImageTokenBudget;
    autoIndex: boolean;
    /**
     * Base URL replacing `https://huggingface.co` for model downloads
     * (e.g. `https://hf-mirror.com`); '' = official. Normalized https URL.
     */
    hfEndpoint: string;
    /**
     * Prefix put before the full GitHub release URL
     * (`<prefix>/https://github.com/...`); '' = official. Normalized https URL.
     */
    githubMirror: string;
}

/**
 * Local gallery thumbnails (src/thumbnails). Global, per device on disk,
 * independent of semantic search.
 */
export interface ThumbnailSettings {
    /** Make, keep and show small local thumbnails of gallery images (default on). */
    enabled: boolean;
    /** Cache size cap for this vault on this device; least recently viewed go first. */
    maxSizeMB: number;
}

export const THUMBNAIL_CACHE_MIN_MB = 10;
export const THUMBNAIL_CACHE_MAX_MB = 100_000;

export interface PluginSettings {
    activeProvider: ProviderName;
    providers: ProviderSettingsMap;
    // Global settings
    basepath: string;
    imgPreview: boolean;
    videoPreview: boolean;
    audioPreview: boolean;
    docsPreview: string;
    nameRule: NameRule;
    pathRule: PathRule;
    embedFormat: string;
    semantic: SemanticSettings;
    thumbnails: ThumbnailSettings;
}

export const DEFAULT_MINIO_SETTINGS: MinioSettings = {
    endpoint: '',
    port: 9000,
    useSSL: true,
    accessKey: '',
    secretKey: '',
    bucket: '',
    region: '',
    customDomain: '',
};

export const DEFAULT_SMMS_SETTINGS: SmMsSettings = {
    token: '',
};

export const DEFAULT_GITHUB_SETTINGS: GithubSettings = {
    repo: '',
    branch: 'main',
    token: '',
    customUrl: '',
};

export const DEFAULT_ALIYUN_SETTINGS: AliyunSettings = {
    accessKeyId: '',
    accessKeySecret: '',
    bucket: '',
    area: 'oss-cn-hangzhou',
    path: '',
    customUrl: '',
};

export const DEFAULT_TENCENT_SETTINGS: TencentSettings = {
    secretId: '',
    secretKey: '',
    bucket: '',
    region: 'ap-shanghai',
    path: '',
    customUrl: '',
};

export const DEFAULT_QINIU_SETTINGS: QiniuSettings = {
    accessKey: '',
    secretKey: '',
    bucket: '',
    url: '',
    area: 'z0',
    path: '',
};

export const DEFAULT_UPYUN_SETTINGS: UpyunSettings = {
    operator: '',
    password: '',
    bucket: '',
    url: '',
    path: '',
    suffix: '',
};

export const DEFAULT_IMGUR_SETTINGS: ImgurSettings = {
    clientId: '',
    proxy: '',
};

export const DEFAULT_R2_SETTINGS: R2Settings = {
    accountId: '',
    accessKeyId: '',
    secretAccessKey: '',
    bucket: '',
    publicUrl: '',
};

export const DEFAULT_S3_SETTINGS: S3Settings = {
    endpoint: '',
    region: 'us-east-1',
    accessKeyId: '',
    secretAccessKey: '',
    bucket: '',
    useSSL: true,
    forcePathStyle: true,
    publicUrl: '',
};

export const DEFAULT_LOCAL_SETTINGS: LocalSettings = {
    storagePath: 'attachments',
    useRelativePath: true,
    deleteToTrash: true,
};

export const DEFAULT_SEMANTIC_SETTINGS: SemanticSettings = {
    enabled: false,
    modelDir: '',
    indexDir: '',
    imageTokenBudget: 70,
    autoIndex: false,
    hfEndpoint: '',
    githubMirror: '',
};

export const DEFAULT_THUMBNAIL_SETTINGS: ThumbnailSettings = {
    enabled: true,
    maxSizeMB: 500,
};

export const DEFAULT_SETTINGS: PluginSettings = {
    activeProvider: 'smms',
    providers: {
        local: DEFAULT_LOCAL_SETTINGS,
        smms: DEFAULT_SMMS_SETTINGS,
        github: DEFAULT_GITHUB_SETTINGS,
        aliyun: DEFAULT_ALIYUN_SETTINGS,
        tencent: DEFAULT_TENCENT_SETTINGS,
        qiniu: DEFAULT_QINIU_SETTINGS,
        upyun: DEFAULT_UPYUN_SETTINGS,
        imgur: DEFAULT_IMGUR_SETTINGS,
        r2: DEFAULT_R2_SETTINGS,
        s3: DEFAULT_S3_SETTINGS,
        minio: DEFAULT_MINIO_SETTINGS,
    },
    basepath: '',
    imgPreview: true,
    videoPreview: true,
    audioPreview: true,
    docsPreview: '',
    // Timestamp prefix by default: clipboard images are always named like
    // "image.png", so the bare local name would overwrite earlier uploads.
    nameRule: 'timeAndLocal',
    pathRule: 'root',
    embedFormat: '![]($URL)',
    semantic: DEFAULT_SEMANTIC_SETTINGS,
    thumbnails: DEFAULT_THUMBNAIL_SETTINGS,
};
