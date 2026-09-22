/**
 * Thin wrapper over the Rep4Rep public API.
 * Docs: https://rep4rep.github.io/rep4rep-api-doc/
 */

const BASE = 'https://rep4rep.com/pub-api';

export class Rep4Rep {
    constructor(apiToken) {
        this.apiToken = apiToken;
    }

    async #request(method, path, params = {}) {
        const url = new URL(BASE + path);
        const init = { method, headers: { Accept: 'application/json' } };

        if (method === 'GET') {
            url.searchParams.set('apiToken', this.apiToken);
            for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        } else {
            const body = new URLSearchParams({ apiToken: this.apiToken, ...params });
            init.body = body.toString();
            init.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        }

        let res;
        try {
            res = await fetch(url, init);
        } catch (err) {
            throw new Error(`Could not reach rep4rep: ${err.message}`);
        }

        const text = await res.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            throw new Error(`rep4rep returned HTTP ${res.status} with a non-JSON body: ${text.slice(0, 200)}`);
        }

        // The API signals failure with a 403 and an `error` key rather than a status family.
        if (json && json.error) throw new Error(`rep4rep: ${json.error}`);
        if (!res.ok) throw new Error(`rep4rep returned HTTP ${res.status}`);

        return json;
    }

    /** Your own account: { uid, username, email, points, pendingPoints, inGroup } */
    getUser() {
        return this.#request('GET', '/user');
    }

    /** Linked Steam profiles. `id` is the internal rep4rep id used everywhere else. */
    getSteamProfiles() {
        return this.#request('GET', '/user/steamprofiles');
    }

    addSteamProfile(steamProfile) {
        return this.#request('POST', '/user/steamprofiles/add', { steamProfile });
    }

    /** Tasks this profile can complete: { taskId, targetSteamProfileId, targetSteamProfileName, requiredCommentId, requiredCommentText } */
    getTasks(rep4repProfileId) {
        return this.#request('GET', '/tasks', { steamProfile: rep4repProfileId });
    }

    /** `commentId` is the task's requiredCommentId, not the Steam comment id. */
    completeTask(taskId, commentId, authorSteamProfileId) {
        return this.#request('POST', '/tasks/complete', {
            taskId,
            commentId,
            authorSteamProfileId,
        });
    }
}
