/**
 * Guarded browser storage.
 *
 * Generalizes the pattern loadSpeedLimit() (app.js:70-84) established: storage
 * access itself can throw (private windows, blocked site data), and a value that
 * *is* there still cannot be trusted — localStorage is editable by hand, and the
 * numbers this project stores bound how fast robots go. So every read is
 * try/catch + validate + fall back to a caller-supplied default, and a bad
 * stored value is treated exactly like a missing one.
 *
 * Two backings, deliberately different:
 *
 *   local()   durable, per-origin. For settings whose loss is a safety problem —
 *             the speed limit, which robots never persist, so the browser is the
 *             only copy of the field's cap.
 *   session() per-tab, survives reload and crash-restore, gone on tab close. For
 *             the code editor's buffer. The robot is the source of truth for
 *             code; a draft that outlives the tab would compete with it.
 */

/**
 * @template T
 * @param {Storage | null} backing
 * @param {string} key
 * @param {T} fallback
 * @param {(raw: string) => T | undefined} parse Return undefined to reject.
 * @returns {T}
 */
function read(backing, key, fallback, parse) {
  let raw = null;
  try {
    raw = backing && backing.getItem(key);
  } catch (err) {
    // Storage is unavailable, not merely empty. Behave as if nothing was saved.
    return fallback;
  }
  if (raw === null || raw === undefined) {
    return fallback;
  }
  try {
    const parsed = parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch (err) {
    return fallback;
  }
}

/**
 * @param {Storage | null} backing
 * @param {string} key
 * @param {string} value
 * @returns {boolean} false when the write was refused — callers that must not
 *   silently lose data (the editor) surface this rather than assume it stuck.
 */
function write(backing, key, value) {
  try {
    if (!backing) {
      return false;
    }
    backing.setItem(key, value);
    return true;
  } catch (err) {
    // Quota, or storage disabled entirely.
    return false;
  }
}

/**
 * Resolved lazily, not at import: touching `localStorage` throws immediately in
 * some configurations, and that would take the whole module graph down.
 *
 * @param {"local" | "session"} which
 * @returns {Storage | null}
 */
function backing(which) {
  try {
    return which === "local" ? window.localStorage : window.sessionStorage;
  } catch (err) {
    return null;
  }
}

/** @param {"local" | "session"} which */
function api(which) {
  return {
    /**
     * @template T
     * @param {string} key
     * @param {T} fallback
     * @param {(raw: string) => T | undefined} parse
     */
    get: (key, fallback, parse) => read(backing(which), key, fallback, parse),
    /** @param {string} key @param {string} value */
    set: (key, value) => write(backing(which), key, value),
    /** @param {string} key */
    remove: (key) => {
      try {
        const b = backing(which);
        if (b) b.removeItem(key);
      } catch (err) {
        /* nothing to undo */
      }
    },
    /**
     * Read a number, rejecting anything non-finite or outside [min, max].
     * This is loadSpeedLimit()'s exact contract, factored out.
     *
     * @param {string} key
     * @param {{ min: number, max: number, fallback: number }} bounds
     */
    getNumber: (key, { min, max, fallback }) =>
      read(backing(which), key, fallback, (raw) => {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < min || n > max) {
          return undefined;
        }
        return n;
      }),
  };
}

export const local = api("local");
export const session = api("session");
