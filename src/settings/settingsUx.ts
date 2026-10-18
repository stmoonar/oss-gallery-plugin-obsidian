/**
 * Pure helpers for the settings tab (no Obsidian imports, unit tested):
 * provider dropdown labels, missing-field summary, error message
 * redaction, download size text and the image-detail rebuild estimate.
 */
import type { AssetEntry } from '../semantic/assets';

export interface ProviderOptionInfo {
    label: string;
    /** Provider can upload but not list (no gallery, no semantic search). */
    uploadOnly: boolean;
    configured: boolean;
}

export interface ProviderOptionTemplates {
    /** e.g. "{label} (upload only)" */
    uploadOnly: string;
    /** e.g. "{label} – not set up" */
    notConfigured: string;
}

/** Dropdown text: capability and setup state at a glance. */
export function providerOptionLabel(info: ProviderOptionInfo, templates: ProviderOptionTemplates): string {
    let text = info.label;
    if (info.uploadOnly) {
        text = templates.uploadOnly.replace('{label}', text);
    }
    if (!info.configured) {
        text = templates.notConfigured.replace('{label}', text);
    }
    return text;
}

/** "Missing: Bucket, Secret key", or '' when nothing is missing. */
export function formatMissingSummary(labels: readonly string[], template: string, separator: string): string {
    if (labels.length === 0) {
        return '';
    }
    return template.replace('{fields}', labels.join(separator));
}

const REDACTED = '***';
/** Shorter values are not worth hiding and would mangle ordinary words. */
const MIN_SECRET_LENGTH = 4;
const MAX_ERROR_LENGTH = 300;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Error text that is safe to show next to the test button: credential
 * values, URL query strings (signatures, tokens), Authorization header
 * values and signature parameters are removed; long texts are cut.
 */
export function sanitizeErrorMessage(message: string, secrets: readonly string[], maxLength = MAX_ERROR_LENGTH): string {
    let text = message;
    // Longest first, so a secret that contains another is replaced whole.
    const sorted = [...secrets]
        .map((s) => s.trim())
        .filter((s) => s.length >= MIN_SECRET_LENGTH)
        .sort((a, b) => b.length - a.length);
    for (const secret of sorted) {
        text = text.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
        const encoded = encodeURIComponent(secret);
        if (encoded !== secret) {
            text = text.replace(new RegExp(escapeRegExp(encoded), 'g'), REDACTED);
        }
    }
    // Query strings of URLs (pre-signed URLs, ?token=...).
    text = text.replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, `$1?${REDACTED}`);
    // Authorization schemes and signature-like key=value pairs.
    text = text.replace(/\b(Bearer|AWS4-HMAC-SHA256)\s+[^\s;"']+/g, `$1 ${REDACTED}`);
    text = text.replace(/\b(UPYUN|Qiniu|OSS)\s+[^\s:;"']+:[^\s,;"']+/g, `$1 ${REDACTED}`);
    text = text.replace(/\b(Signature|X-Amz-Signature|X-Amz-Credential|Credential|access_token|token|sign|q-signature)=([^\s&,;"']+)/gi, `$1=${REDACTED}`);
    text = text.trim();
    if (text.length > maxLength) {
        text = `${text.slice(0, maxLength - 1)}…`;
    }
    return text;
}

/** Whole megabytes ("343 MB"), as download sizes are quoted in prose. */
export function formatApproxMegabytes(bytes: number): string {
    return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** Total download size of the semantic search files, for prose ("about 343 MB"). */
export function semanticDownloadSize(assets: readonly AssetEntry[]): string {
    return formatApproxMegabytes(assets.reduce((sum, a) => sum + a.size, 0));
}

export interface RebuildEstimate {
    /** Images indexed for the current provider (they are all embedded again). */
    indexed: number;
    /**
     * Bytes downloaded again for the current provider's last listing; null
     * when unknown (no listing yet), 0 for Local (read from disk).
     */
    downloadBytes: number | null;
    /** Listed images whose size the provider did not report. */
    unknownSizeCount: number;
}

/**
 * What changing the image detail costs: every listed image of the scope is
 * embedded again, and remote ones are downloaded again.
 */
export function estimateRebuild(
    indexed: number,
    listed: ReadonlyArray<{ size: number }> | null,
    local: boolean
): RebuildEstimate {
    if (local) {
        return { indexed, downloadBytes: 0, unknownSizeCount: 0 };
    }
    if (!listed) {
        return { indexed, downloadBytes: null, unknownSizeCount: 0 };
    }
    let bytes = 0;
    let unknown = 0;
    for (const item of listed) {
        if (item.size > 0) {
            bytes += item.size;
        } else {
            unknown++;
        }
    }
    return { indexed, downloadBytes: bytes, unknownSizeCount: unknown };
}

/** Run `promise` with a time limit; rejects with `timeoutError()` after `ms`. */
export function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    timeoutError: () => Error,
    timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const handle = timers.set(() => reject(timeoutError()), ms);
        promise.then(
            (value) => {
                timers.clear(handle);
                resolve(value);
            },
            (error: unknown) => {
                timers.clear(handle);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        );
    });
}
