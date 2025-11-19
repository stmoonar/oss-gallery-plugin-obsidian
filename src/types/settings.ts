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

export interface PluginSettings {
    activeProvider: string;
    providers: {
        minio: MinioSettings;
        smms: SmMsSettings;
        github: GithubSettings;
        [key: string]: any;
    };
    // Global settings
    basepath: string;
    imgPreview: boolean;
    videoPreview: boolean;
    audioPreview: boolean;
    docsPreview: string;
    nameRule: string;
    pathRule: string;
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

export const DEFAULT_SETTINGS: PluginSettings = {
    activeProvider: 'minio',
    providers: {
        minio: DEFAULT_MINIO_SETTINGS,
        smms: DEFAULT_SMMS_SETTINGS,
        github: DEFAULT_GITHUB_SETTINGS,
    },
    basepath: '',
    imgPreview: true,
    videoPreview: true,
    audioPreview: true,
    docsPreview: '',
    nameRule: 'local',
    pathRule: 'root',
};

export type NameRule = 'local' | 'time' | 'timeAndLocal';
export type PathRule = 'root' | 'type' | 'date' | 'typeAndDate';