import { createHmac } from 'crypto';
import * as Base64 from 'js-base64';

interface QiniuAccessTokenV2Options {
    accessKey: string;
    secretKey: string;
    method: string;
    host: string;
    path: string;
    queryString?: string;
    contentType?: string;
    body?: string;
}

function toUrlSafeBase64(data: string | Uint8Array): string {
    if (typeof data === 'string') {
        return Base64.encodeURI(data);
    }
    return Base64.fromUint8Array(data, true);
}

export function createQiniuUploadToken(
    accessKey: string,
    secretKey: string,
    policy: Record<string, unknown>
): string {
    const encodedPolicy = toUrlSafeBase64(JSON.stringify(policy));
    const digest = createHmac('sha1', secretKey)
        .update(encodedPolicy, 'utf8')
        .digest();

    return `${accessKey}:${toUrlSafeBase64(digest)}:${encodedPolicy}`;
}

export function createQiniuAccessTokenV2(options: QiniuAccessTokenV2Options): string {
    let signingData = `${options.method.toUpperCase()} ${options.path}`;
    if (options.queryString) {
        signingData += `?${options.queryString}`;
    }
    signingData += `\nHost: ${options.host}`;
    if (options.contentType) {
        signingData += `\nContent-Type: ${options.contentType}`;
    }
    signingData += '\n\n';

    if (
        options.body &&
        (options.contentType === 'application/json' ||
            options.contentType === 'application/x-www-form-urlencoded')
    ) {
        signingData += options.body;
    }

    const digest = createHmac('sha1', options.secretKey)
        .update(signingData, 'utf8')
        .digest();

    return `${options.accessKey}:${toUrlSafeBase64(digest)}`;
}

export function encodeQiniuEntry(bucket: string, key: string): string {
    return toUrlSafeBase64(`${bucket}:${key}`);
}
