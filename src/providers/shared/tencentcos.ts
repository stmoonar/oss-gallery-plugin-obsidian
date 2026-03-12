import { createHash, createHmac } from 'crypto';

interface TencentCosAuthorizationOptions {
    secretId: string;
    secretKey: string;
    method: string;
    pathname: string;
    query?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string | number | undefined>;
    now?: Date;
    expiresInSeconds?: number;
}

interface CanonicalPair {
    encodedKey: string;
    encodedValue: string;
    sortKey: string;
    sortValue: string;
}

function encodeCosValue(value: string): string {
    return encodeURIComponent(value)
        .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildCanonicalPairs(
    values: Record<string, string | number | boolean | undefined> = {}
): CanonicalPair[] {
    return Object.entries(values)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
            const sortKey = key.toLowerCase();
            const sortValue = String(value).trim();
            return {
                encodedKey: encodeCosValue(sortKey),
                encodedValue: encodeCosValue(sortValue),
                sortKey,
                sortValue,
            };
        })
        .sort((a, b) => {
            if (a.sortKey === b.sortKey) {
                return a.sortValue.localeCompare(b.sortValue);
            }
            return a.sortKey.localeCompare(b.sortKey);
        });
}

function formatCanonicalPairs(pairs: CanonicalPair[]): string {
    return pairs
        .map((pair) => `${pair.encodedKey}=${pair.encodedValue}`)
        .join('&');
}

function formatCanonicalKeys(pairs: CanonicalPair[]): string {
    return pairs.map((pair) => pair.encodedKey).join(';');
}

export function createTencentCosAuthorization(options: TencentCosAuthorizationOptions): string {
    const now = options.now ?? new Date();
    const expiresInSeconds = options.expiresInSeconds ?? 3600;
    const startTime = Math.floor(now.getTime() / 1000);
    const endTime = startTime + expiresInSeconds;
    const keyTime = `${startTime};${endTime}`;

    const signKey = createHmac('sha1', options.secretKey)
        .update(keyTime, 'utf8')
        .digest('hex');

    const queryPairs = buildCanonicalPairs(options.query);
    const headerPairs = buildCanonicalPairs(options.headers);
    const httpString = [
        options.method.toLowerCase(),
        options.pathname,
        formatCanonicalPairs(queryPairs),
        formatCanonicalPairs(headerPairs),
        '',
    ].join('\n');

    const stringToSign = [
        'sha1',
        keyTime,
        createHash('sha1').update(httpString, 'utf8').digest('hex'),
        '',
    ].join('\n');

    const signature = createHmac('sha1', signKey)
        .update(stringToSign, 'utf8')
        .digest('hex');

    return [
        'q-sign-algorithm=sha1',
        `q-ak=${encodeCosValue(options.secretId)}`,
        `q-sign-time=${keyTime}`,
        `q-key-time=${keyTime}`,
        `q-header-list=${formatCanonicalKeys(headerPairs)}`,
        `q-url-param-list=${formatCanonicalKeys(queryPairs)}`,
        `q-signature=${signature}`,
    ].join('&');
}
