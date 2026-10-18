/**
 * Settings fields each provider needs before it can be used, for the
 * settings tab ("Required" markers, "Missing: ..." line), for the "not set
 * up" notice on upload, and for hiding credentials in error messages. Pure: no Obsidian imports, so it is unit
 * tested. Labels are locale keys and match the names the providers'
 * renderSettings() use, so the settings tab can find the matching rows.
 *
 * Keep in sync with `isConfigured` in ./registry.ts.
 */
import type en from '../locale/en';

export type LocaleKey = keyof typeof en;

export interface ProviderFieldSpec {
    /** Key in the provider's settings object. */
    field: string;
    /** Locale key of the field's name in the settings tab. */
    label: LocaleKey;
}

export const REQUIRED_FIELDS: Readonly<Record<string, readonly ProviderFieldSpec[]>> = {
    local: [{ field: 'storagePath', label: 'Storage path' }],
    smms: [{ field: 'token', label: 'S.EE API key' }],
    github: [
        { field: 'repo', label: 'Repo Name' },
        { field: 'token', label: 'Token' },
    ],
    aliyun: [
        { field: 'accessKeyId', label: 'Access Key ID' },
        { field: 'accessKeySecret', label: 'Access Key Secret' },
        { field: 'bucket', label: 'Bucket' },
    ],
    tencent: [
        { field: 'secretId', label: 'Secret ID' },
        { field: 'secretKey', label: 'Secret Key' },
        { field: 'bucket', label: 'Bucket' },
    ],
    // The CDN / acceleration domain is required: neither has a usable default public URL.
    qiniu: [
        { field: 'accessKey', label: 'Access Key' },
        { field: 'secretKey', label: 'Secret Key' },
        { field: 'bucket', label: 'Bucket' },
        { field: 'url', label: 'URL' },
    ],
    upyun: [
        { field: 'operator', label: 'Operator' },
        { field: 'password', label: 'Password' },
        { field: 'bucket', label: 'Bucket' },
        { field: 'url', label: 'URL' },
    ],
    imgur: [{ field: 'clientId', label: 'Client ID' }],
    r2: [
        { field: 'accountId', label: 'Account ID' },
        { field: 'accessKeyId', label: 'Access Key ID' },
        { field: 'secretAccessKey', label: 'Secret Access Key' },
        { field: 'bucket', label: 'Bucket' },
    ],
    s3: [
        { field: 'endpoint', label: 'Endpoint' },
        { field: 'accessKeyId', label: 'Access Key ID' },
        { field: 'secretAccessKey', label: 'Secret Access Key' },
        { field: 'bucket', label: 'Bucket' },
    ],
    minio: [
        { field: 'endpoint', label: 'Endpoint' },
        { field: 'accessKey', label: 'Access Key' },
        { field: 'secretKey', label: 'Secret Key' },
        { field: 'bucket', label: 'Bucket' },
    ],
};

/**
 * Settings fields holding credentials (any provider). Their values are
 * replaced before an error message is shown.
 */
const SECRET_FIELDS: ReadonlySet<string> = new Set([
    'token',
    'password',
    'accessKey',
    'accessKeyId',
    'accessKeySecret',
    'secretAccessKey',
    'secretId',
    'secretKey',
    'clientId',
]);

function fieldValue(settings: unknown, field: string): unknown {
    if (!settings || typeof settings !== 'object') {
        return undefined;
    }
    return (settings as Record<string, unknown>)[field];
}

/** Required fields of a provider; empty for an unknown id. */
export function requiredFieldsOf(providerId: string): readonly ProviderFieldSpec[] {
    return Object.prototype.hasOwnProperty.call(REQUIRED_FIELDS, providerId) ? REQUIRED_FIELDS[providerId] : [];
}

/** Required fields that are empty (or only whitespace) in `settings`. */
export function missingRequiredFields(providerId: string, settings: unknown): ProviderFieldSpec[] {
    return requiredFieldsOf(providerId).filter((spec) => {
        const value = fieldValue(settings, spec.field);
        return typeof value !== 'string' || value.trim() === '';
    });
}

/** Credential values of a provider's settings (non-empty, trimmed). */
export function providerSecrets(settings: unknown): string[] {
    if (!settings || typeof settings !== 'object') {
        return [];
    }
    const secrets: string[] = [];
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
        if (SECRET_FIELDS.has(key) && typeof value === 'string' && value.trim() !== '') {
            secrets.push(value.trim());
        }
    }
    return secrets;
}
