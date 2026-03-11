/**
 * Normalize a path prefix: remove leading/trailing slashes, trim whitespace.
 */
export function normalizePath(path: string | undefined): string {
    if (!path) return '';
    return path.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Build a full object key from optional path prefix and filename.
 */
export function buildObjectKey(prefix: string | undefined, path: string): string {
    const normalized = normalizePath(prefix);
    return normalized ? `${normalized}/${path}` : path;
}

/**
 * Encode an object key for use in a URL path while preserving path separators.
 */
export function encodeObjectKeyForUrl(objectKey: string): string {
    return objectKey
        .split('/')
        .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (char) =>
            `%${char.charCodeAt(0).toString(16).toUpperCase()}`
        ))
        .join('/');
}

/**
 * Normalize host-like input and strip protocol, path, query, and hash parts.
 */
export function normalizeEndpointHost(value: string, defaultProtocol = 'https'): string {
    const trimmed = value.trim();
    if (!trimmed) return '';

    const withProtocol = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `${defaultProtocol}://${trimmed}`;

    try {
        const parsed = new URL(withProtocol);
        return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
    } catch {
        return trimmed
            .replace(/^https?:\/\//i, '')
            .split('/')[0]
            .split('?')[0]
            .split('#')[0]
            .replace(/\/+$/, '');
    }
}

/**
 * Normalize a base URL: remove trailing slashes, ensure protocol.
 */
export function normalizeBaseUrl(url: string, defaultProtocol = 'https'): string {
    let cleaned = url.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(cleaned)) {
        cleaned = `${defaultProtocol}://${cleaned}`;
    }
    return cleaned;
}
