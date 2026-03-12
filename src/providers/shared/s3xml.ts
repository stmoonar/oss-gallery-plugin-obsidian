import { OssImage } from '../../types/oss';
import { isImageFile } from './image';

export interface S3ObjectEntry {
    key: string;
    lastModified?: Date;
    size: number;
}

export interface S3ListObjectsPage {
    objects: S3ObjectEntry[];
    isTruncated: boolean;
    nextMarker?: string;
    nextContinuationToken?: string;
}

/**
 * Parse an S3-compatible ListObjectsV2 XML response into OssImage[].
 *
 * All S3-compatible providers (MinIO, R2, S3, Tencent, Aliyun) return the same
 * XML schema with Contents > Key / LastModified / Size.  Extracting the parser
 * here eliminates duplication and ensures a single place to fix parsing bugs.
 *
 * @param xml        Raw XML response body
 * @param buildUrl   Provider-specific function that turns an object key into
 *                   a public/access URL
 */
export function parseS3ListObjectsPage(xml: string): S3ListObjectsPage {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xml, 'text/xml');
    const contents = xmlDoc.getElementsByTagName('Contents');
    const objects: S3ObjectEntry[] = [];

    for (let i = 0; i < contents.length; i++) {
        const item = contents[i];
        const key = item.getElementsByTagName('Key')[0]?.textContent;
        const lastModified = item.getElementsByTagName('LastModified')[0]?.textContent;
        const size = item.getElementsByTagName('Size')[0]?.textContent;

        if (key) {
            objects.push({
                key,
                lastModified: lastModified ? new Date(lastModified) : undefined,
                size: size ? parseInt(size, 10) : 0,
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

export function parseS3ListObjectsXml(
    xml: string,
    buildUrl: (key: string) => string
): OssImage[] {
    return parseS3ListObjectsPage(xml)
        .objects
        .filter((item) => isImageFile(item.key))
        .map((item) => ({
            key: item.key,
            url: buildUrl(item.key),
            lastModified: item.lastModified,
            size: item.size,
        }));
}
