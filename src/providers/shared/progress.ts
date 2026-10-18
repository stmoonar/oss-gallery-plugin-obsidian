import { UploadProgressInfo } from '../../types/oss';

/**
 * Controller returned by reportUploadBounds. Callers must invoke exactly one
 * of finish()/fail() once the real upload settles.
 */
export interface ProgressController {
    /** Upload succeeded: report 100%. */
    finish(): void;
    /** Upload failed: report nothing more. */
    fail(): void;
}

/**
 * Report only what is known for an upload sent through requestUrl, which
 * cannot report transfer progress: 0% when it starts and 100% when it
 * succeeds. No made-up percentages in between: the upload card shows an
 * indeterminate bar until a provider reports real intermediate progress.
 */
export function reportUploadBounds(
    onProgress: ((progress: UploadProgressInfo) => void) | undefined,
    fileSize: number
): ProgressController {
    if (!onProgress) {
        return { finish() {}, fail() {} };
    }

    let settled = false;
    onProgress({ loaded: 0, total: fileSize, percentage: 0 });

    return {
        finish() {
            if (settled) return;
            settled = true;
            onProgress({ loaded: fileSize, total: fileSize, percentage: 100 });
        },
        fail() {
            settled = true;
        },
    };
}
