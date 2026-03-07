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
 * Normalize a base URL: remove trailing slashes, ensure protocol.
 */
export function normalizeBaseUrl(url: string, defaultProtocol = 'https'): string {
    let cleaned = url.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(cleaned)) {
        cleaned = `${defaultProtocol}://${cleaned}`;
    }
    return cleaned;
}
