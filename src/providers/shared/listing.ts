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
