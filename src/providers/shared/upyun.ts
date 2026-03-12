import { createHash, createHmac } from 'crypto';
import {
    getArray,
    getNumberLike,
    getRecord,
    getString,
} from '../../utils/typeGuards';

export interface UpyunListEntry {
    name: string;
    type: string;
    size: number;
    lastModified?: Date;
}

export interface UpyunListPage {
    entries: UpyunListEntry[];
    iter: string;
}

export function createUpyunAuthorization(
    operator: string,
    password: string,
    method: string,
    uri: string,
    date: string,
    contentMd5 = ''
): string {
    const passwordMd5 = createHash('md5').update(password).digest('hex');
    const signature = createHmac('sha1', passwordMd5)
        .update([method.toUpperCase(), uri, date, contentMd5].join('&'), 'utf8')
        .digest('base64');

    return `UPYUN ${operator}:${signature}`;
}

export function createUpyunContentMd5(data: ArrayBuffer): string {
    return createHash('md5').update(Buffer.from(data)).digest('base64');
}

export function parseUpyunListPage(raw: unknown, iterHeader?: string): UpyunListPage {
    const record = getRecord(raw);
    const files = getArray(record?.files) ?? getArray(raw) ?? [];

    return {
        entries: files.map((item) => {
            const file = getRecord(item);
            const lastModified = getNumberLike(file?.last_modified);
            const lastUpdate = getNumberLike(file?.last_update);

            return {
                name: getString(file?.name) ?? '',
                type: getString(file?.type) ?? '',
                size: getNumberLike(file?.length) ?? getNumberLike(file?.size) ?? 0,
                lastModified: lastModified !== undefined
                    ? new Date(lastModified * 1000)
                    : lastUpdate !== undefined
                        ? new Date(lastUpdate * 1000)
                        : undefined,
            };
        }),
        iter: getString(record?.iter) ?? iterHeader ?? '',
    };
}

export function isUpyunDirectory(type: string): boolean {
    const normalized = type.trim().toLowerCase();
    return normalized === 'f'
        || normalized === 'folder'
        || normalized === 'dir'
        || normalized === 'directory';
}
