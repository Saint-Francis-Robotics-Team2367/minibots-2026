/**
 * Scale an embedded document down to fit its frame, the way a phone zooms out a
 * page that has no viewport tag.
 *
 * Only the rulebook needs this. Google Docs' published page lays itself out at a
 * fixed width and has no viewport tag, so opened on its own a phone renders it
 * at 980px and zooms out to fit. Inside an iframe nothing does that zoom-out:
 * on a 390px phone the frame is about 344px wide and the document was simply
 * clipped at both edges. So this lays the iframe out at the document's own
 * width and scales the whole frame down to the width it actually has, the same
 * trade a phone makes, with pinch-zoom for reading the small print.
 *
 * Without JavaScript the frame stays unscaled and scrolls sideways inside
 * itself, which is the behaviour this replaces, not a broken page.
 */

for (const win of document.querySelectorAll(".fig__window")) {
  const frame = /** @type {HTMLIFrameElement | null} */ (win.querySelector("iframe[data-fit-width]"));
  if (!frame) continue;
  const natural = Number(frame.dataset.fitWidth);

  const fit = () => {
    const scale = Math.min(1, win.clientWidth / natural);
    // At full width there is nothing to fix, and a transform there would only
    // soften text rendering for no gain.
    if (scale === 1) {
      frame.style.removeProperty("width");
      frame.style.removeProperty("height");
      frame.style.removeProperty("transform");
      return;
    }
    // Inverse-size the box, then scale it back: the frame still fills its
    // window exactly, but the document inside sees `natural` px of width.
    frame.style.width = `${natural}px`;
    frame.style.height = `${win.clientHeight / scale}px`;
    frame.style.transform = `scale(${scale})`;
  };

  new ResizeObserver(fit).observe(win);
}
