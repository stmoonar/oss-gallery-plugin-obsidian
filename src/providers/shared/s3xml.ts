import { OssImage } from '../../types/oss';
import { isImageFile } from './image';

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
export function parseS3ListObjectsXml(
    xml: string,
    buildUrl: (key: string) => string
): OssImage[] {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xml, 'text/xml');
    const contents = xmlDoc.getElementsByTagName('Contents');
    const images: OssImage[] = [];

    for (let i = 0; i < contents.length; i++) {
        const item = contents[i];
        const key = item.getElementsByTagName('Key')[0]?.textContent;
        const lastModified = item.getElementsByTagName('LastModified')[0]?.textContent;
        const size = item.getElementsByTagName('Size')[0]?.textContent;

        if (key && isImageFile(key)) {
            images.push({
                key,
                url: buildUrl(key),
                lastModified: lastModified ? new Date(lastModified) : undefined,
                size: size ? parseInt(size, 10) : 0,
            });
        }
    }

    return images;
}
