type Viewport = { height: number; offsetTop: number; scale: number };

/** Use the visible keyboard viewport, but leave browser pinch zoom untouched. */
export function mobileViewportState(
  viewport: Viewport | undefined,
  layoutHeight: number,
  coarsePointer: boolean,
  editing: boolean,
) {
  if (
    !coarsePointer ||
    !viewport ||
    !Number.isFinite(viewport.height) ||
    viewport.height <= 0 ||
    !Number.isFinite(viewport.offsetTop) ||
    !Number.isFinite(viewport.scale) ||
    Math.abs(viewport.scale - 1) > 0.01
  )
    return null;
  return {
    height: viewport.height,
    top: Math.max(0, viewport.offsetTop),
    keyboard: editing && layoutHeight - viewport.height > 120,
  };
}

/** Touch Return keeps multiline drafting; an explicit modifier still sends. */
export function shouldSubmitComposerKey(
  key: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    isComposing: boolean;
  },
  coarsePointer: boolean,
) {
  return (
    key.key === "Enter" &&
    !key.shiftKey &&
    !key.isComposing &&
    (!coarsePointer || key.ctrlKey || key.metaKey)
  );
}

export function installMobileViewport(
  host: Window = window,
  doc: Document = document,
) {
  const viewport = host.visualViewport;
  if (!viewport) return () => {};
  const touch = host.matchMedia("(pointer: coarse)");
  const root = doc.documentElement;
  let frame: number | undefined;
  const clear = () => {
    root.style.removeProperty("--mobile-viewport-height");
    root.style.removeProperty("--mobile-viewport-top");
    root.removeAttribute("data-mobile-keyboard");
  };
  const update = () => {
    frame = undefined;
    const editing =
      doc.activeElement?.matches(
        'input:not([readonly]):not([disabled]),textarea:not([readonly]):not([disabled]),select,[contenteditable="true"]',
      ) ?? false;
    const state = mobileViewportState(
      viewport,
      Math.max(host.innerHeight, root.clientHeight),
      touch.matches,
      editing,
    );
    if (!state) {
      clear();
      return;
    }
    root.style.setProperty("--mobile-viewport-height", `${state.height}px`);
    root.style.setProperty("--mobile-viewport-top", `${state.top}px`);
    root.toggleAttribute("data-mobile-keyboard", state.keyboard);
  };
  const schedule = () => {
    if (frame === undefined) frame = host.requestAnimationFrame(update);
  };
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  host.addEventListener("resize", schedule);
  host.addEventListener("pageshow", schedule);
  touch.addEventListener("change", schedule);
  doc.addEventListener("focusin", schedule);
  doc.addEventListener("focusout", schedule);
  update();
  return () => {
    if (frame !== undefined) host.cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    host.removeEventListener("resize", schedule);
    host.removeEventListener("pageshow", schedule);
    touch.removeEventListener("change", schedule);
    doc.removeEventListener("focusin", schedule);
    doc.removeEventListener("focusout", schedule);
    clear();
  };
}
