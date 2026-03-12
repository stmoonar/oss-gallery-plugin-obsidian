/**
 * Build a multipart/form-data body from parts.
 */
export interface MultipartField {
    name: string;
    value: string | Uint8Array;
    filename?: string;
    contentType?: string;
}

export function buildMultipartBody(fields: MultipartField[], boundary: string): ArrayBuffer {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];

    for (const field of fields) {
        parts.push(encoder.encode(`--${boundary}\r\n`));

        if (field.filename) {
            parts.push(encoder.encode(
                `Content-Disposition: form-data; name="${field.name}"; filename="${encodeURIComponent(field.filename)}"\r\n`
            ));
            if (field.contentType) {
                parts.push(encoder.encode(`Content-Type: ${field.contentType}\r\n`));
            }
            parts.push(encoder.encode('\r\n'));
        } else {
            parts.push(encoder.encode(
                `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`
            ));
        }

        if (typeof field.value === 'string') {
            parts.push(encoder.encode(field.value));
        } else {
            parts.push(field.value);
        }
        parts.push(encoder.encode('\r\n'));
    }

    parts.push(encoder.encode(`--${boundary}--\r\n`));

    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const body = new ArrayBuffer(totalLength);
    const view = new Uint8Array(body);
    let offset = 0;
    for (const part of parts) {
        view.set(part, offset);
        offset += part.length;
    }

    return body;
}

export function generateBoundary(): string {
    return '----ObsidianFormBoundary' + Math.random().toString(36).slice(2, 18);
}
