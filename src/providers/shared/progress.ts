import { UploadProgressInfo } from '../../types/oss';

/**
 * Simulate progress for providers that use requestUrl (which doesn't support progress events).
 * Fires 0% immediately, then 100% after a short delay.
 */
export function simulateProgress(
    onProgress: ((progress: UploadProgressInfo) => void) | undefined,
    fileSize: number
): void {
    if (!onProgress) return;
    setTimeout(() => onProgress({ loaded: 0, total: fileSize, percentage: 0 }), 0);
    setTimeout(() => onProgress({ loaded: fileSize, total: fileSize, percentage: 100 }), 100);
}
