/**
 * Extract headers suitable for Obsidian's requestUrl from an aws4-signed
 * options object.
 *
 * aws4.sign() injects Host and Content-Length headers that conflict with
 * requestUrl's own handling.  This helper copies the headers and strips those
 * keys so every S3-compatible provider doesn't have to repeat the same
 * cleanup logic.
 */
export function extractSignedHeaders(
    signedHeaders: Record<string, string>
): Record<string, string> {
    const headers = { ...signedHeaders };
    delete headers['Host'];
    delete headers['host'];
    delete headers['Content-Length'];
    delete headers['content-length'];
    return headers;
}
