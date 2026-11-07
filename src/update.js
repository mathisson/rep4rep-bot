/**
 * "Is there a newer release?" -- asked of GitHub, never answered by
 * downloading anything. The app only points at the release page.
 */

export const REPO = 'mathisson/rep4rep-bot';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

/** "v2.10.1" -> [2, 10, 1]; anything unparseable -> null. */
export function parseVersion(v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
    return m ? m.slice(1).map(Number) : null;
}

export function isNewer(candidate, current) {
    const a = parseVersion(candidate), b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

/**
 * The latest release if it is newer than `current`, else null.
 * Throws on network or API errors; the caller decides they are not worth showing.
 */
export async function checkForUpdate(current, fetchImpl = fetch) {
    const res = await fetchImpl(API_URL, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': `Rep4Rep-app/${current}`,
        },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = await res.json();
    if (rel.draft || rel.prerelease || !isNewer(rel.tag_name, current)) return null;
    return { version: String(rel.tag_name).replace(/^v/, ''), url: RELEASES_URL };
}
