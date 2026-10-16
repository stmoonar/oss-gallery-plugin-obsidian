/**
 * Semantic index identity per provider (docs/semantic-search.md §4.6).
 *
 * The identity is the part of a provider's settings that decides *which*
 * objects a listing sees: bucket, endpoint/region, repository + branch,
 * storage directory, provider-side path. Two settings with the same identity
 * share one index. Credentials (keys, secrets, tokens, passwords) never take
 * part: they don't change what is stored, and the identity is hashed into a
 * directory name that is synced with the vault.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested; registry.ts
 * wires it into each ProviderRegistryEntry as `getIndexIdentity`.
 */
import type {
    AliyunSettings,
    GithubSettings,
    LocalSettings,
    MinioSettings,
    ProviderSettingsMap,
    QiniuSettings,
    R2Settings,
    S3Settings,
    TencentSettings,
    UpyunSettings,
} from '../types/settings';

export type IndexIdentity = Record<string, string | number | boolean>;

function clean(value: string | undefined): string {
    return (value ?? '').trim();
}

/** Provider path settings are compared without surrounding slashes. */
function cleanPath(value: string | undefined): string {
    return clean(value).replace(/^\/+|\/+$/g, '');
}

/**
 * Identity getters for every listable provider. Imgur (upload-only) has
 * none, so it can never be indexed.
 */
export const INDEX_IDENTITY: { [K in keyof ProviderSettingsMap]?: (settings: ProviderSettingsMap[K]) => IndexIdentity } = {
    local: (s: LocalSettings) => ({
        storagePath: cleanPath(s.storagePath),
        useRelativePath: s.useRelativePath,
    }),
    // S.EE lists one account's whole history; nothing but the (secret)
    // token identifies it, so all S.EE accounts share one scope. A complete
    // listing of another account tombstones the old entries (§7).
    smms: () => ({}),
    github: (s: GithubSettings) => ({
        repo: clean(s.repo).toLowerCase(),
        branch: clean(s.branch),
    }),
    aliyun: (s: AliyunSettings) => ({
        bucket: clean(s.bucket),
        area: clean(s.area),
        path: cleanPath(s.path),
    }),
    tencent: (s: TencentSettings) => ({
        bucket: clean(s.bucket),
        region: clean(s.region),
        path: cleanPath(s.path),
    }),
    qiniu: (s: QiniuSettings) => ({
        bucket: clean(s.bucket),
        area: clean(s.area),
        path: cleanPath(s.path),
    }),
    upyun: (s: UpyunSettings) => ({
        bucket: clean(s.bucket),
        path: cleanPath(s.path),
    }),
    r2: (s: R2Settings) => ({
        // The account id is part of every R2 URL; it is not a credential.
        accountId: clean(s.accountId),
        bucket: clean(s.bucket),
    }),
    s3: (s: S3Settings) => ({
        endpoint: clean(s.endpoint).toLowerCase(),
        region: clean(s.region),
        bucket: clean(s.bucket),
        forcePathStyle: s.forcePathStyle,
    }),
    minio: (s: MinioSettings) => ({
        endpoint: clean(s.endpoint).toLowerCase(),
        port: s.port,
        useSSL: s.useSSL,
        bucket: clean(s.bucket),
    }),
};

export function getIndexIdentity<K extends keyof ProviderSettingsMap>(
    providerId: K,
    settings: ProviderSettingsMap[K] | undefined
): IndexIdentity | null {
    const getter = INDEX_IDENTITY[providerId];
    if (!getter || !settings) {
        return null;
    }
    return getter(settings);
}
