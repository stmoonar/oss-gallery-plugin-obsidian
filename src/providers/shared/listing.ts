import type { ListResult, OssImage } from '../../types/oss';

/**
 * Upper bound for paged list requests (e.g. 1000 keys per page), so a huge
 * bucket cannot make a gallery refresh page forever.
 */
export const MAX_LIST_PAGES = 20;

/**
 * Upper bound for directory-walk listings (one request per directory page).
 */
export const MAX_LIST_REQUESTS = 200;

const warnedProviders = new Set<string>();

/**
 * Warn (once per provider per session) that a listing was cut short.
 */
export function warnListingCapped(provider: string, limit: number): void {
    if (warnedProviders.has(provider)) return;
    warnedProviders.add(provider);
    console.warn(`${provider}: listing stopped after ${limit} requests; the gallery only shows part of the stored files.`);
}

/**
 * Collects listed objects and whether the listing covered everything under
 * `prefix` (docs/semantic-search.md §4.1). Any cap, partial failure or
 * inconsistent pagination must call markIncomplete(): an incomplete listing
 * is never used to decide that an object was deleted.
 */
export class ListingCollector {
    readonly items: OssImage[] = [];
    private complete = true;

    /** `prefix` is the key prefix the listing covers ('' = everything). */
    constructor(private readonly provider: string, readonly prefix: string) {}

    push(...items: OssImage[]): void {
        this.items.push(...items);
    }

    markIncomplete(): void {
        this.complete = false;
    }

    /** A request/page/depth cap was hit. */
    capped(limit: number): void {
        warnListingCapped(this.provider, limit);
        this.complete = false;
    }

    isComplete(): boolean {
        return this.complete;
    }

    result(): ListResult {
        return { items: this.items, complete: this.complete, prefix: this.prefix };
    }
}

export interface ListPage {
    items: OssImage[];
    /**
     * Cursor for the next page (marker / continuation token / page number).
     * Ignored when `more` is false.
     */
    next?: string;
    /**
     * Whether the server says more pages exist. When omitted, a non-empty
     * `next` means "more".
     */
    more?: boolean;
}

/**
 * Drive a cursor-paged listing (S3 ListObjects, Qiniu, S.EE history...).
 *
 * complete = the server reported the last page. It is false when
 * `maxPages` was reached, or the server says there is more but gives no
 * usable cursor (missing or repeating), since the remaining pages were
 * never seen. Request errors propagate (callers keep their own handling).
 */
export async function collectPages(
    collector: ListingCollector,
    maxPages: number,
    fetchPage: (cursor: string | undefined, pageIndex: number) => Promise<ListPage>
): Promise<ListResult> {
    let cursor: string | undefined;
    for (let pageIndex = 0; ; pageIndex++) {
        if (pageIndex >= maxPages) {
            collector.capped(maxPages);
            break;
        }
        const page = await fetchPage(cursor, pageIndex);
        collector.push(...page.items);
        const more = page.more ?? Boolean(page.next);
        if (!more) {
            break;
        }
        if (!page.next || page.next === cursor) {
            // "More" without a way to get it: stop, but never claim completeness.
            collector.markIncomplete();
            break;
        }
        cursor = page.next;
    }
    return collector.result();
}
