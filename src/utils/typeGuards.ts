export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

export function getNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function getNumberLike(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
}

export function getBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

export function getArray(value: unknown): unknown[] | undefined {
    return Array.isArray(value) ? value : undefined;
}

export function getRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

/**
 * Merge stored values onto a defaults object, driven by the keys and value
 * types of `defaults`. For every key present in `defaults`:
 * - the stored value is adopted only when its type matches the default's type
 *   (string/boolean via strict checks, number via `getNumberLike` so numeric
 *   strings such as "9000" are accepted);
 * - otherwise the default value is kept.
 * Keys that are not present in `defaults` (unknown fields) are discarded.
 */
export function mergeWithDefaults<T extends Record<string, unknown>>(
    defaults: T,
    stored: unknown
): T {
    const result = { ...defaults };
    const record = getRecord(stored);
    if (!record) {
        return result;
    }

    for (const key of Object.keys(defaults)) {
        const defaultValue = defaults[key];
        const storedValue = record[key];
        if (storedValue === undefined) {
            continue;
        }

        let adopted: unknown;
        switch (typeof defaultValue) {
            case 'string':
                adopted = getString(storedValue);
                break;
            case 'number':
                adopted = getNumberLike(storedValue);
                break;
            case 'boolean':
                adopted = getBoolean(storedValue);
                break;
            default:
                adopted = undefined;
                break;
        }

        if (adopted !== undefined) {
            (result as Record<string, unknown>)[key] = adopted;
        }
    }

    return result;
}
