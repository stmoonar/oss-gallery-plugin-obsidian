import { OssImage } from '../../types/oss';
import { isImageFile } from './image';

export interface S3ObjectEntry {
    key: string;
    lastModified?: Date;
    size: number;
    /** <ETag> as sent, quotes included (S3, Aliyun, Tencent, R2, MinIO). */
    etag?: string;
}

export interface S3ListObjectsPage {
    objects: S3ObjectEntry[];
    isTruncated: boolean;
    nextMarker?: string;
    nextContinuationToken?: string;
}

/**
 * Parse one S3-compatible ListObjects(V2) XML page.
 *
 * All S3-compatible providers (MinIO, R2, S3, Tencent, Aliyun) return the same
 * XML schema with Contents > Key / LastModified / Size / ETag.  Extracting the
 * parser here eliminates duplication and ensures a single place to fix
 * parsing bugs.
 */
export function parseS3ListObjectsPage(xml: string): S3ListObjectsPage {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xml, 'text/xml');

    // A captive portal / proxy / CDN fallback page, an empty body or an S3
    // <Error> document must fail the listing: parsed as "no Contents" it would
    // look like a complete, empty bucket and the semantic index would purge.
    const root = xmlDoc.documentElement as Element | null;
    if (xmlDoc.getElementsByTagName('parsererror').length > 0 || root?.localName !== 'ListBucketResult') {
        const code = xmlDoc.getElementsByTagName('Code')[0]?.textContent;
        const message = xmlDoc.getElementsByTagName('Message')[0]?.textContent;
        const detail = code
            ? `${code}${message ? `: ${message}` : ''}`
            : `unexpected response (${root?.localName ?? 'empty'})`;
        throw new Error(`Invalid list response: ${detail}`);
    }
    const contents = xmlDoc.getElementsByTagName('Contents');
    const objects: S3ObjectEntry[] = [];

    for (let i = 0; i < contents.length; i++) {
        const item = contents[i];
        const key = item.getElementsByTagName('Key')[0]?.textContent;
        const lastModified = item.getElementsByTagName('LastModified')[0]?.textContent;
        const size = item.getElementsByTagName('Size')[0]?.textContent;
        const etag = item.getElementsByTagName('ETag')[0]?.textContent?.trim();

        if (key) {
            objects.push({
                key,
                lastModified: lastModified ? new Date(lastModified) : undefined,
                size: size ? parseInt(size, 10) : 0,
                ...(etag ? { etag } : {}),
            });
        }
    }

    const isTruncated = xmlDoc.getElementsByTagName('IsTruncated')[0]?.textContent === 'true';
    const nextMarker = xmlDoc.getElementsByTagName('NextMarker')[0]?.textContent || undefined;
    const nextContinuationToken =
        xmlDoc.getElementsByTagName('NextContinuationToken')[0]?.textContent || undefined;

    return {
        objects,
        isTruncated,
        nextMarker,
        nextContinuationToken,
    };
}

/** Image entries of a parsed page as OssImage (etag kept for fingerprints). */
export function s3EntriesToImages(
    objects: S3ObjectEntry[],
    buildUrl: (key: string) => string
): OssImage[] {
    return objects
        .filter((item) => isImageFile(item.key))
        .map((item) => ({
            key: item.key,
            url: buildUrl(item.key),
            lastModified: item.lastModified,
            size: item.size,
            ...(item.etag ? { etag: item.etag } : {}),
        }));
}
