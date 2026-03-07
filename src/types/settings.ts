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

export interface ProviderSettingsMap {
    minio: MinioSettings;
    smms: SmMsSettings;
    github: GithubSettings;
    aliyun: AliyunSettings;
    tencent: TencentSettings;
    qiniu: QiniuSettings;
    upyun: UpyunSettings;
    imgur: ImgurSettings;
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

export const DEFAULT_SETTINGS: PluginSettings = {
    activeProvider: 'minio',
    providers: {
        minio: DEFAULT_MINIO_SETTINGS,
        smms: DEFAULT_SMMS_SETTINGS,
        github: DEFAULT_GITHUB_SETTINGS,
        aliyun: DEFAULT_ALIYUN_SETTINGS,
        tencent: DEFAULT_TENCENT_SETTINGS,
        qiniu: DEFAULT_QINIU_SETTINGS,
        upyun: DEFAULT_UPYUN_SETTINGS,
        imgur: DEFAULT_IMGUR_SETTINGS,
    },
    basepath: '',
    imgPreview: true,
    videoPreview: true,
    audioPreview: true,
    docsPreview: '',
    nameRule: 'local',
    pathRule: 'root',
};