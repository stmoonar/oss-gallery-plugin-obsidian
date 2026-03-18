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
    nameRule: 'local',
    pathRule: 'root',
    embedFormat: '![]($URL)',
};
