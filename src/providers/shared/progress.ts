import { UploadProgressInfo } from '../../types/oss';

/**
 * Controller returned by simulateProgress. Callers must invoke exactly one of
 * finish()/fail() once the real upload settles, so the simulated ticking stops
 * and no timer is left running.
 */
export interface ProgressController {
    /** Upload succeeded: stop simulating and report 100%. */
    finish(): void;
    /** Upload failed: stop simulating without reporting completion. */
    fail(): void;
}

const CAP_PERCENTAGE = 90;
const TICK_MS = 200;

/**
 * Simulate progress for providers that use requestUrl (which doesn't support
 * progress events). Fires 0% immediately, then eases the percentage upward
 * over time toward a cap (never reaching 100% on its own) so the bar doesn't
 * look finished while the request is still in flight. The caller must call
 * finish() once the upload actually succeeds (reports 100%) or fail() if it
 * errors out (stops without reporting completion).
 */
export function simulateProgress(
    onProgress: ((progress: UploadProgressInfo) => void) | undefined,
    fileSize: number
): ProgressController {
    if (!onProgress) {
        return { finish() {}, fail() {} };
    }

    let percentage = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    let settled = false;

    const report = (pct: number) => {
        percentage = pct;
        onProgress({ loaded: Math.round((pct / 100) * fileSize), total: fileSize, percentage: pct });
    };

    const stop = () => {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    };

    report(0);
    timer = setInterval(() => {
        // Ease toward the cap: cover a fraction of the remaining distance each
        // tick, so progress slows down as it approaches CAP_PERCENTAGE.
        const remaining = CAP_PERCENTAGE - percentage;
        const next = Math.min(CAP_PERCENTAGE, percentage + Math.max(1, remaining * 0.15));
        report(next);
        if (next >= CAP_PERCENTAGE) {
            stop();
        }
    }, TICK_MS);

    return {
        finish() {
            if (settled) return;
            settled = true;
            stop();
            report(100);
        },
        fail() {
            if (settled) return;
            settled = true;
            stop();
        },
    };
}
