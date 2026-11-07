/**
 * Thin wrapper over the Rep4Rep public API (v1).
 * Docs: https://rep4rep.com/api
 *
 * The rest of the app was written against the old pub-api, so responses are
 * normalised back to those field names here (the new fields are kept too).
 * Steam profiles are now addressed by SteamID64, so a profile's `id` *is* its
 * steamId.
 */

const BASE = 'https://api.rep4rep.com/v1';

const toProfile = p => ({
    ...p,
    id: String(p.steamId),
    steamId: String(p.steamId),
    personaName: p.name,
    canReceiveComment: p.canReceiveComments,
});

const toTask = t => ({
    ...t,
    taskId: t.requestId,
    targetSteamProfileId: String(t.target?.steamId),
    targetSteamProfileName: t.target?.name,
    requiredCommentId: t.comment?.id,
    requiredCommentText: t.comment?.text,
});

export class Rep4Rep {
    constructor(apiToken) {
        this.apiToken = apiToken;
    }

    async #request(method, path, params = {}) {
        const url = new URL(BASE + path);
        const init = {
            method,
            headers: { Accept: 'application/json', Authorization: `Bearer ${this.apiToken}` },
        };

        if (method === 'GET') {
            for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        } else if (method !== 'DELETE') {
            init.body = JSON.stringify(params);
            init.headers['Content-Type'] = 'application/json';
        }

        let res;
        try {
            res = await fetch(url, init);
        } catch (err) {
            throw new Error(`Could not reach rep4rep: ${err.message}`);
        }

        if (res.status === 204) return null;

        const text = await res.text();
        let json;
        try {
            json = text ? JSON.parse(text) : {};
        } catch {
            throw new Error(`rep4rep returned HTTP ${res.status} with a non-JSON body: ${text.slice(0, 200)}`);
        }

        if (!res.ok) {
            let msg = json?.message || `HTTP ${res.status}`;
            if (json?.errors) msg += ' ' + Object.values(json.errors).flat().join(' ');
            if (res.status === 401) msg = `invalid API key (${msg})`;
            const err = new Error(`rep4rep: ${msg}`);
            err.status = res.status;
            throw err;
        }

        return json?.data ?? json;
    }

    /** Your own account: { id, username, points, availablePoints, pendingPoints, comments, ... } */
    getUser() {
        return this.#request('GET', '/user');
    }

    /** Linked Steam profiles, normalised: { id (= steamId), steamId, personaName, canReceiveComment, ... } */
    async getSteamProfiles() {
        const list = await this.#request('GET', '/steam-profiles');
        return (list || []).map(toProfile);
    }

    /** `steamProfile` may be a SteamID64, SteamID, or profile URL (custom URLs too). */
    async addSteamProfile(steamProfile) {
        const p = toProfile(await this.#request('POST', '/steam-profiles', { profile: steamProfile }));
        return { ...p, success: `Added ${p.personaName || p.steamId}.` };
    }

    removeSteamProfile(steamId) {
        return this.#request('DELETE', `/steam-profiles/${encodeURIComponent(steamId)}`);
    }

    /**
     * Tasks this profile can do, best paying first, normalised:
     * { taskId (= requestId), targetSteamProfileId, targetSteamProfileName,
     *   requiredCommentId, requiredCommentText, ticket, points, ... }
     */
    async getTasks(steamId, limit = 25) {
        const list = await this.#request('GET', `/steam-profiles/${encodeURIComponent(steamId)}/tasks`, { limit });
        return (list || []).map(toTask);
    }

    /**
     * Submit a posted comment. `taskId` is the task's requestId, `commentId` its
     * comment.id, `steamId` the profile it was posted from. The ticket keeps the
     * task valid for 60 minutes even if the request changes meanwhile.
     */
    completeTask(taskId, commentId, steamId, ticket) {
        const body = { steamId: String(steamId), requestId: taskId, commentId };
        if (ticket) body.ticket = ticket;
        return this.#request('POST', '/tasks', body);
    }

    /** Submitted comments and their verification status. Filters: status, steamId, perPage, page. */
    getSubmittedTasks(params = {}) {
        return this.#request('GET', '/tasks', params);
    }
}
