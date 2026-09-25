/** Human-readable duration: 3h 24m 09s, 24m 09s, 9s. */
export function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;

    if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
}

export function formatClock(ms) {
    return new Date(ms).toLocaleString(undefined, {
        weekday: 'short', hour: '2-digit', minute: '2-digit',
    });
}

/**
 * Block until `until` (ms epoch), ticking a single rewritten line on a TTY.
 * Non-interactive output gets one line instead of thousands, so logs stay readable.
 */
export function countdown(until, label = 'resuming in') {
    const remaining = until - Date.now();
    if (remaining <= 0) return Promise.resolve();

    if (!process.stdout.isTTY) {
        console.log(`       ${label} ${formatDuration(remaining)} (at ${formatClock(until)})`);
        return new Promise(resolve => setTimeout(resolve, remaining));
    }

    return new Promise(resolve => {
        const render = () => {
            const left = until - Date.now();
            if (left <= 0) {
                clearInterval(timer);
                process.stdout.write('\r\u001b[2K');
                resolve();
                return;
            }
            process.stdout.write(`\r\u001b[2K       ${label} ${formatDuration(left)}  (at ${formatClock(until)})`);
        };

        const timer = setInterval(render, 1000);
        render();
    });
}
