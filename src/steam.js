import SteamUser from 'steam-user';
import SteamCommunity from 'steamcommunity';
import SteamID from 'steamid';
import prompts from 'prompts';

import { readSessions, writeSessions } from './config.js';

const LOGIN_TIMEOUT_MS = 90_000;

/**
 * Log into Steam and return a web-authenticated SteamCommunity handle.
 *
 * With a cached refresh token this is fully unattended. Without one it needs
 * `interactive: true`, prompts for credentials, and caches only the refresh
 * token Steam hands back -- the password is never written to disk.
 */
export async function steamLogin({ account, interactive = false } = {}) {
    const sessions = readSessions();
    const names = Object.keys(sessions);

    let accountName = account || (names.length === 1 ? names[0] : null);
    let refreshToken = accountName ? sessions[accountName]?.refreshToken : null;
    let logOnOptions;

    if (refreshToken) {
        logOnOptions = { refreshToken };
    } else {
        if (!interactive) {
            const detail = account
                ? `No cached Steam session for "${account}".`
                : names.length > 1
                    ? `Several accounts are cached (${names.join(', ')}) -- pick one with --account.`
                    : 'No cached Steam session.';
            throw new Error(`${detail} Run: npm start -- login`);
        }

        const answers = await prompts(
            [
                { type: 'text', name: 'accountName', message: 'Steam username', initial: accountName || '' },
                { type: 'password', name: 'password', message: 'Steam password' },
            ],
            { onCancel: () => { throw new Error('Login cancelled.'); } }
        );

        if (!answers.accountName || !answers.password) throw new Error('Login cancelled.');
        accountName = answers.accountName.trim();
        logOnOptions = { accountName, password: answers.password };
    }

    // autoRelogin matters for --wait runs, which idle for hours between comments.
    const client = new SteamUser({ autoRelogin: true, renewRefreshTokens: true });
    const community = new SteamCommunity();

    // Steam re-issues a web session after every reconnect. These cookies must be
    // handed to steamcommunity each time, not just on the first login.
    client.on('webSession', (_sessionID, cookies) => community.setCookies(cookies));

    let issuedToken = null;
    client.on('refreshToken', token => { issuedToken = token; });

    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
        if (!interactive) {
            client.logOff();
            return; // the 'ready' promise below times out with a clear message
        }
        const where = domain ? `emailed to ${domain}` : 'from your Steam mobile app';
        prompts({
            type: 'text',
            name: 'code',
            message: `Steam Guard code ${where}${lastCodeWrong ? ' (previous code was wrong)' : ''}`,
        }).then(({ code }) => callback((code || '').trim()));
    });

    const ready = new Promise((resolve, reject) => {
        let settled = false;
        const finish = fn => (...args) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(...args);
        };

        const timer = setTimeout(
            finish(() => reject(new Error(
                interactive
                    ? 'Timed out waiting for Steam.'
                    : 'Timed out waiting for Steam -- the cached token may have expired. Run: npm start -- login'
            ))),
            LOGIN_TIMEOUT_MS
        );

        client.on('error', finish(err => reject(translateSteamError(err))));
        client.on('webSession', finish(() => resolve()));
    });

    client.logOn(logOnOptions);

    try {
        await ready;
    } catch (err) {
        try { client.logOff(); } catch { /* already down */ }
        throw err;
    }

    const steamId64 = client.steamID.getSteamID64();

    if (issuedToken) {
        const current = readSessions();
        current[accountName] = {
            refreshToken: issuedToken,
            steamId: steamId64,
            savedAt: new Date().toISOString(),
        };
        writeSessions(current);
    }

    return {
        client,
        community,
        steamId64,
        accountName,
        savedToken: Boolean(issuedToken),
        logOff: () => { try { client.logOff(); } catch { /* already down */ } },
    };
}

const RATE_LIMIT_SIGNS = [
    /too frequently/i,       // "You've been posting too frequently, and can't make another post right now"
    /rate.?limit/i,
    /\b429\b/,
    /try again later/i,
    /temporarily blocked/i,
];

/** True when Steam refused the post because of throttling rather than a real problem. */
export function isRateLimit(err) {
    const message = err?.message || String(err || '');
    return RATE_LIMIT_SIGNS.some(re => re.test(message));
}

/** Post a profile comment. Resolves with the Steam comment id when available. */
export function postProfileComment(community, targetSteamId64, message) {
    return new Promise((resolve, reject) => {
        community.postUserComment(new SteamID(String(targetSteamId64)), message, (err, commentId) => {
            if (err) return reject(new Error(err.message || String(err)));
            resolve(commentId);
        });
    });
}

function translateSteamError(err) {
    const result = err?.eresult;
    const map = {
        [SteamUser.EResult.InvalidPassword]:
            'Steam rejected the credentials. If you used a cached token it has expired -- run: npm start -- login',
        [SteamUser.EResult.AccessDenied]:
            'Steam denied access. The cached refresh token is no longer valid -- run: npm start -- login',
        [SteamUser.EResult.RateLimitExceeded]:
            'Steam is rate-limiting logins from this IP. Wait a while before retrying.',
        [SteamUser.EResult.AccountLoginDeniedNeedTwoFactor]:
            'This account needs a Steam Guard code -- run: npm start -- login',
        [SteamUser.EResult.AccountDisabled]: 'That Steam account is disabled.',
        [SteamUser.EResult.AccountLogonDenied]:
            'Steam Guard blocked the login -- run: npm start -- login and enter the emailed code.',
    };
    return new Error(map[result] || `Steam login failed: ${err?.message || String(err)}`);
}
