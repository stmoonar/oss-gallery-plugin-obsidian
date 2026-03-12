import { createHash, createHmac } from 'crypto';

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

export function parseUpyunListPage(raw: any, iterHeader?: string): UpyunListPage {
    const files = Array.isArray(raw?.files)
        ? raw.files
        : Array.isArray(raw)
            ? raw
            : [];

    return {
        entries: files.map((item: any) => ({
            name: String(item?.name ?? ''),
            type: String(item?.type ?? ''),
            size: Number(item?.length ?? item?.size ?? 0),
            lastModified: item?.last_modified
                ? new Date(Number(item.last_modified) * 1000)
                : item?.last_update
                    ? new Date(Number(item.last_update) * 1000)
                    : undefined,
        })),
        iter: typeof raw?.iter === 'string' ? raw.iter : iterHeader ?? '',
    };
}

export function isUpyunDirectory(type: string): boolean {
    const normalized = type.trim().toLowerCase();
    return normalized === 'f'
        || normalized === 'folder'
        || normalized === 'dir'
        || normalized === 'directory';
}
