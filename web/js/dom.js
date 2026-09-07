/**
 * DOM helpers shared by every page.
 *
 * Lifted verbatim out of app.js (lines 109-130) when the site grew from one page
 * to four. `log()` is the one piece of UI every page needs: the flasher, the
 * editor and the driver station all narrate what they are doing to hardware, and
 * that narration is the only record a student has when something goes wrong.
 */

/** Cap on log rows. Old lines are dropped from the bottom, not the top. */
export const LOG_MAX = 200;

/**
 * Deliberately a per-call getElementById rather than a cached lookup: pages
 * build slots and rows after load, so a cache taken at import time would hand
 * back stale or null nodes. Cheap enough — this is a panel, not a game loop.
 *
 * @param {string} id
 * @returns {HTMLElement}
 */
export const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * Append one line to the activity log, newest first.
 *
 * @param {string} msg
 * @param {"info"|"go"|"warn"|"err"} kind
 * @param {string} [listId] Log element id; defaults to the conventional "log".
 */
export function log(msg, kind = "info", listId = "log") {
  const list = $(listId);
  // Every page carries a log, but a page mid-build (or a tool page that failed
  // to render) must not turn a diagnostic message into a second exception.
  if (!list) {
    return;
  }
  const li = document.createElement("li");
  li.dataset.kind = kind;
  const t = document.createElement("time");
  const d = new Date();
  t.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const span = document.createElement("span");
  span.textContent = msg;
  li.append(t, span);
  list.prepend(li);
  while (list.children.length > LOG_MAX) {
    list.lastElementChild.remove();
  }
}

/** @param {string} [listId] */
export function clearLog(listId = "log") {
  const list = $(listId);
  if (list) {
    list.innerHTML = "";
  }
}
