/**
 * The daily run the desktop app starts on its own.
 *
 * Pure functions over the three settings that describe it, so the timing rules
 * can be tested without a clock or a window:
 *
 *   scheduleEnabled  boolean
 *   scheduleTime     "HH:MM", local time
 *   scheduleLastDay  "YYYY-MM-DD" of the last day a scheduled run started
 *
 * A day's run is due from its time until midnight, so a PC that was asleep or
 * an app started late still gets that day's run -- once.
 */

export function parseTime(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    return h < 24 && min < 60 ? { h, min } : null;
}

const pad = n => String(n).padStart(2, '0');

/** Local calendar day, which is what "once a day" means to the user. */
export function dayKey(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The scheduled moment on the same local day as `now`. */
export function timeOn(time, now) {
    const t = parseTime(time);
    if (!t) return null;
    const d = new Date(now);
    d.setHours(t.h, t.min, 0, 0);
    return d.getTime();
}

export function isDue(settings, now = Date.now()) {
    if (!settings?.scheduleEnabled) return false;
    const at = timeOn(settings.scheduleTime, now);
    return at !== null && now >= at && settings.scheduleLastDay !== dayKey(now);
}

/** When the next scheduled run starts, as a timestamp, or null when off. */
export function nextRun(settings, now = Date.now()) {
    if (!settings?.scheduleEnabled) return null;
    const today = timeOn(settings.scheduleTime, now);
    if (today === null) return null;
    if (isDue(settings, now)) return now;
    if (now < today && settings.scheduleLastDay !== dayKey(now)) return today;

    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return timeOn(settings.scheduleTime, tomorrow.getTime());
}

/**
 * Turning the schedule on (or moving its time) at 15:00 for 09:00 must not
 * fire a run on the spot: today counts as done if its time has already passed.
 */
export function lastDayWhenSet(time, now = Date.now()) {
    const at = timeOn(time, now);
    return at !== null && now >= at ? dayKey(now) : null;
}
