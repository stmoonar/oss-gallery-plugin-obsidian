export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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
