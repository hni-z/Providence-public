import test from "node:test";
import assert from "node:assert/strict";
import {
  installMobileViewport,
  mobileViewportState,
  shouldSubmitComposerKey,
} from "../web/src/mobile.js";

test("touch Return drafts a newline while desktop and explicit modifier submission remain available", () => {
  const enter = {
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
  };
  assert.equal(shouldSubmitComposerKey(enter, true), false);
  assert.equal(shouldSubmitComposerKey(enter, false), true);
  for (const coarse of [false, true]) {
    assert.equal(
      shouldSubmitComposerKey({ ...enter, ctrlKey: true }, coarse),
      true,
    );
    assert.equal(
      shouldSubmitComposerKey({ ...enter, metaKey: true }, coarse),
      true,
    );
    assert.equal(
      shouldSubmitComposerKey({ ...enter, shiftKey: true }, coarse),
      false,
    );
    assert.equal(
      shouldSubmitComposerKey({ ...enter, isComposing: true }, coarse),
      false,
    );
    assert.equal(
      shouldSubmitComposerKey({ ...enter, key: "a" }, coarse),
      false,
    );
  }
});

test("mobile layout follows the visible keyboard viewport without turning pinch zoom or desktop resizing into keyboard mode", () => {
  assert.deepEqual(
    mobileViewportState(
      { height: 370, offsetTop: 28, scale: 1 },
      780,
      true,
      true,
    ),
    { height: 370, top: 28, keyboard: true },
  );
  assert.deepEqual(
    mobileViewportState(
      { height: 700, offsetTop: 0, scale: 1 },
      780,
      true,
      true,
    ),
    { height: 700, top: 0, keyboard: false },
  );
  assert.deepEqual(
    mobileViewportState(
      { height: 370, offsetTop: -5, scale: 1 },
      780,
      true,
      false,
    ),
    { height: 370, top: 0, keyboard: false },
  );
  for (const scale of [0.8, 1.2, 2, NaN])
    assert.equal(
      mobileViewportState(
        { height: 370, offsetTop: 0, scale },
        780,
        true,
        true,
      ),
      null,
    );
  assert.equal(
    mobileViewportState(
      { height: 370, offsetTop: 0, scale: 1 },
      780,
      false,
      true,
    ),
    null,
  );
  assert.equal(mobileViewportState(undefined, 780, true, true), null);
  assert.equal(
    mobileViewportState({ height: 0, offsetTop: 0, scale: 1 }, 780, true, true),
    null,
  );
});

test("viewport events coalesce, focus and zoom restore layout, and cleanup removes every listener and pending update", () => {
  const styles = new Map<string, string>(),
    attributes = new Set<string>();
  const viewport = Object.assign(new EventTarget(), {
    height: 780,
    offsetTop: 0,
    scale: 1,
  });
  const pointer = Object.assign(new EventTarget(), { matches: true });
  let editing = false,
    frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const root = {
    clientHeight: 780,
    style: {
      setProperty: (name: string, value: string) => styles.set(name, value),
      removeProperty: (name: string) => styles.delete(name),
    },
    removeAttribute: (name: string) => attributes.delete(name),
    toggleAttribute: (name: string, enabled: boolean) =>
      enabled ? attributes.add(name) : attributes.delete(name),
  };
  const doc = Object.assign(new EventTarget(), {
    documentElement: root,
    activeElement: { matches: () => editing },
  });
  const host = Object.assign(new EventTarget(), {
    visualViewport: viewport,
    innerHeight: 780,
    matchMedia: () => pointer,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const flush = () => {
    const queued = [...frames.values()];
    frames.clear();
    queued.forEach((callback) => callback(0));
  };
  const cleanup = installMobileViewport(
    host as unknown as Window,
    doc as unknown as Document,
  );
  assert.equal(styles.get("--mobile-viewport-height"), "780px");
  editing = true;
  viewport.height = 370;
  viewport.offsetTop = 20;
  viewport.dispatchEvent(new Event("resize"));
  viewport.dispatchEvent(new Event("scroll"));
  doc.dispatchEvent(new Event("focusin"));
  assert.equal(frames.size, 1);
  flush();
  assert.equal(styles.get("--mobile-viewport-height"), "370px");
  assert.equal(styles.get("--mobile-viewport-top"), "20px");
  assert.ok(attributes.has("data-mobile-keyboard"));
  viewport.scale = 2;
  viewport.dispatchEvent(new Event("resize"));
  flush();
  assert.equal(styles.size, 0);
  assert.equal(attributes.size, 0);
  viewport.scale = 1;
  editing = false;
  doc.dispatchEvent(new Event("focusout"));
  flush();
  assert.equal(styles.get("--mobile-viewport-height"), "370px");
  assert.equal(attributes.size, 0);
  host.dispatchEvent(new Event("resize"));
  assert.equal(frames.size, 1);
  cleanup();
  assert.equal(styles.size, 0);
  assert.equal(frames.size, 0);
  for (const [target, events] of [
    [viewport, ["resize", "scroll"]],
    [host, ["resize", "pageshow"]],
    [pointer, ["change"]],
    [doc, ["focusin", "focusout"]],
  ] as const)
    for (const name of events) target.dispatchEvent(new Event(name));
  assert.equal(frames.size, 0);
});
