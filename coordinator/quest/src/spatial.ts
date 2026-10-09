import * as THREE from 'three';
import type { Action, Panel, SpatialCapabilities, SpatialState } from './types';
import { SpatialPresses, SpatialTextWrap, wrapSpatialText } from './spatial-interactions';
import { PanelArrangement, posePosition, type LayoutRay } from './spatial-layout';

type KeyboardSession = XRSession & { isSystemKeyboardSupported?: boolean };
type Rect = { x: number; y: number; width: number; height: number };
type Hit = Rect & { key: string; action: Action; kind: 'app' | 'layout' | 'grab' };
type Target = { view?: PanelView; hit: Hit; point: THREE.Vector3 };
type PanelView = {
  index: number;
  panel: Panel;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  hits: Hit[];
  textPage: number;
  actionPage: number;
  signature: string;
  wrap: SpatialTextWrap;
};
type Pointer = {
  ray: ReturnType<THREE.WebGLRenderer['xr']['getController']>;
  hand: ReturnType<THREE.WebGLRenderer['xr']['getHand']>;
  source?: XRInputSource;
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  marker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  joints: Map<THREE.Object3D, THREE.Mesh>;
  removeListeners: () => void;
};

const WIDTH = 1280;
const HEIGHT = 1536;
const PANEL_WIDTH = 1.12;
const PANEL_HEIGHT = PANEL_WIDTH * HEIGHT / WIDTH;
const TEXT_LINES = 10;
const ACTIONS_PER_PAGE = 4;
const COLORS = { background: '#171717', text: '#f5f5f5', muted: '#999999', accent: '#f5f5f5', border: '#303030' };
const EXIT_ERROR = 'XR did not finish exiting. Select Retry Exit XR, or leave immersive mode using the Quest system menu.';

/** A self-contained WebXR viewport; all data and permissions are owned by the host UI. */
export class SpatialWorkspace {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(52, 1, 0.05, 40);
  private readonly workspace = new THREE.Group();
  private readonly floor = new THREE.GridHelper(12, 24, '#222222', '#111111');
  private readonly orb = new THREE.Mesh(new THREE.SphereGeometry(0.21, 48, 32), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.32, metalness: 0.08, emissive: '#ffffff', emissiveIntensity: 0.13 }));
  private readonly orbHalo = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.004, 8, 72), new THREE.MeshBasicMaterial({ color: '#999999', transparent: true, opacity: 0.45 }));
  private voice?: SpatialState['voice'];
  private readonly reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly rotation = new THREE.Matrix4();
  private readonly direction = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly mouse = new THREE.Vector2();
  private readonly presses = new SpatialPresses<Pointer | number>();
  private readonly layout = new PanelArrangement<Pointer | number>();
  private readonly inverseWorkspace = new THREE.Matrix4();
  private readonly pointers: Pointer[] = [];
  private readonly views: PanelView[] = [];
  private readonly jointMaterial = new THREE.MeshBasicMaterial({ color: '#dddddd' });
  private readonly jointGeometry = new THREE.SphereGeometry(1, 8, 6);
  private readonly previewLabel = document.createElement('p');
  private readonly exitRecovery = document.createElement('div');
  private readonly exitRecoveryMessage = document.createElement('p');
  private readonly retryExit = document.createElement('button');
  private readonly observedEnds = new WeakSet<XRSession>();
  private readonly observer: ResizeObserver;
  private session?: KeyboardSession;
  private requestPending = false;
  private disposed = false;
  private needsPlacement = false;
  private selectionCount = 0;
  private capabilitySignature = '';
  private status = '';
  private mouseHit?: Target;
  private hovered = new Set<string>();
  private arranging = false;
  private suspended = false;
  private lifecycleEpoch = 0;
  private endRequest?: { session: XRSession; promise: Promise<void> };
  private exitFailure?: string;

  constructor(private readonly container: HTMLElement, private readonly onCapabilities: (capabilities: SpatialCapabilities) => void) {
    this.onSessionEnd = this.onSessionEnd.bind(this);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.xr.enabled = true;
    // A local reference space works both seated and standing. Placement uses the actual first head pose.
    this.renderer.xr.setReferenceSpaceType('local');
    this.renderer.setClearColor('#0b0b0b', 1);
    this.renderer.domElement.setAttribute('aria-label', 'Spatial workspace. Click the floating sphere to talk. Device and task panels surround it. Accessible controls are below.');
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
    this.previewLabel.className = 'spatial-preview-label';
    this.container.style.position = 'relative';
    this.previewLabel.style.cssText = 'position:absolute;left:0;bottom:0;right:0;padding:10px 16px;margin:0;background:#0b0b0be6;color:#999999;font:12px/1.5 system-ui,sans-serif;pointer-events:none';
    this.previewLabel.textContent = 'Click the sphere to talk · Point and pinch in a headset · Live task activity; screen sharing is not available';
    this.container.append(this.renderer.domElement, this.previewLabel);
    this.exitRecovery.style.cssText = 'position:absolute;inset:0;z-index:2;padding:24px;background:#1b1b1bf2;color:#f5f5f5;overflow:auto';
    this.exitRecovery.setAttribute('role', 'alert');
    this.exitRecovery.hidden = true;
    this.retryExit.type = 'button';
    this.retryExit.textContent = 'Retry Exit XR';
    this.retryExit.style.marginTop = '16px';
    this.retryExit.addEventListener('click', this.onRetryExit);
    this.exitRecovery.append(this.exitRecoveryMessage, this.retryExit);
    this.container.append(this.exitRecovery);
    this.scene.background = new THREE.Color('#0b0b0b');
    this.scene.add(this.workspace, this.floor);
    this.orb.position.set(0, 0.12, -1.1);
    this.orbHalo.position.copy(this.orb.position);
    this.workspace.add(this.orb, this.orbHalo);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#333333', 2.5));
    const keyLight = new THREE.DirectionalLight('#ffffff', 3);
    keyLight.position.set(-2, 5, 3);
    this.scene.add(keyLight);
    this.camera.position.set(0, 1.55, 2.6);
    this.workspace.position.y = 1.55;
    this.camera.lookAt(0, 1.55, -1.6);
    for (let index = 0; index < 4; index++) this.makePointer(index);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('lostpointercapture', this.onPointerCancel);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    document.addEventListener('visibilitychange', this.onDocumentVisibility);
    window.addEventListener('blur', this.onWindowBlur);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(this.render);
    this.reportCapabilities();
  }

  update(state: SpatialState): void {
    if (this.disposed) return;
    this.status = state.status;
    this.voice = state.voice;
    const defaults = ['Devices', 'Conversation / tasks', 'Decisions', 'Results'];
    for (let index = 0; index < 4; index++) {
      const panel = state.panels[index] ?? { id: `empty-${index}`, title: defaults[index], lines: ['Waiting for workspace data.'], actions: [] };
      const view = this.views[index] ?? this.makePanel(panel, index);
      if (view.panel.id !== panel.id) { view.textPage = 0; view.actionPage = 0; }
      view.panel = panel;
      // Callbacks may change on a poll without changing the canvas pixels.
      this.refreshPanel(view);
    }
  }

  get isArranging(): boolean { return this.arranging; }
  get exitError(): string | undefined { return this.exitFailure; }

  setArrangeMode(enabled: boolean): void {
    if (this.disposed || this.suspended || enabled === this.arranging) return;
    this.arranging = enabled;
    // Switching modes invalidates every press, including a voice hold or an
    // approval started before the switch. A later release cannot invoke it.
    this.cancelInteractions();
    this.hovered.clear();
    this.mouseHit = undefined;
    this.refreshAll();
    this.resize();
    this.reportCapabilities();
  }

  /** Explicitly reset panel positions around the current head pose. Polling never calls this. */
  recenter(): void {
    if (this.disposed || this.suspended) return;
    this.cancelInteractions();
    this.layout.reset();
    this.applyLayout();
    this.hovered.clear();
    this.mouseHit = undefined;
    if (this.session) this.needsPlacement = true;
    else {
      this.workspace.position.set(0, 1.55, 0);
      this.workspace.rotation.set(0, 0, 0);
      this.floor.position.y = 0;
      this.resize();
    }
    this.refreshAll();
  }

  async enter(mode: 'immersive-vr' | 'immersive-ar' = 'immersive-vr'): Promise<void> {
    if (this.disposed) throw new Error('Spatial workspace is closed.');
    if (this.suspended) throw new Error('Resume the workspace before entering spatial mode.');
    if (this.session || this.requestPending) return;
    if (!window.isSecureContext) throw new Error('Quest spatial mode requires HTTPS.');
    if (!navigator.xr) throw new Error('WebXR is not available in this browser. The 2D workspace is still available.');
    this.requestPending = true;
    const run = this.lifecycleEpoch;
    let requestedSession: KeyboardSession | undefined;
    try {
      this.cancelInteractions();
      // Keep this before every await: requestSession needs the original button activation.
      const pending = navigator.xr.requestSession(mode, { optionalFeatures: ['hand-tracking', 'local-floor'] });
      const session = await pending as KeyboardSession;
      requestedSession = session;
      if (this.disposed) { await session.end().catch(() => undefined); return; }
      this.trackSession(session);
      if (this.suspended || run !== this.lifecycleEpoch) { await this.requestEnd(session).catch(() => undefined); return; }
      this.scene.background = mode === 'immersive-ar' ? null : new THREE.Color('#0b0b0b');
      this.renderer.setClearColor('#0b0b0b', mode === 'immersive-ar' ? 0 : 1);
      this.floor.visible = mode === 'immersive-vr';
      this.previewLabel.hidden = true;
      this.needsPlacement = true;
      await this.renderer.xr.setSession(session);
      if (this.disposed || this.suspended || run !== this.lifecycleEpoch || this.session !== session) {
        await this.requestEnd(session).catch(() => undefined);
        return;
      }
      this.reportCapabilities();
      this.refreshAll();
    } catch (error) {
      if (requestedSession && this.session === requestedSession) {
        await this.requestEnd(requestedSession).catch(() => undefined);
      }
      if (this.disposed || this.suspended || run !== this.lifecycleEpoch) return;
      throw error;
    } finally { this.requestPending = false; }
  }

  async exit(): Promise<void> {
    this.cancelInteractions();
    if (this.session) await this.requestEnd(this.session);
  }

  private trackSession(session: KeyboardSession): void {
    this.session = session;
    this.exitFailure = undefined;
    session.addEventListener('end', this.onSessionEnd);
    session.addEventListener('visibilitychange', this.onSessionVisibility);
    session.addEventListener('inputsourceschange', this.onSourcesChange);
    this.renderExitRecovery();
  }

  /** A failed end request is not an end event. Retain identity and offer explicit recovery. */
  private requestEnd(session: XRSession): Promise<void> {
    if (this.observedEnds.has(session)) return Promise.resolve();
    if (this.endRequest?.session === session) return this.endRequest.promise;
    let result: Promise<void>;
    try { result = session.end(); }
    catch { result = Promise.reject(new Error(EXIT_ERROR)); }
    const attempt = { session, promise: Promise.resolve() };
    this.endRequest = attempt;
    this.renderExitRecovery();
    attempt.promise = result.then(() => {
      if (this.endRequest === attempt) this.endRequest = undefined;
      if (!this.disposed && this.session === session) this.renderExitRecovery();
    }, () => {
      if (this.endRequest === attempt) this.endRequest = undefined;
      // An observed native end supersedes a late rejected request for that session.
      if (this.observedEnds.has(session)) return;
      if (!this.disposed && this.session === session) {
        this.exitFailure = EXIT_ERROR;
        this.renderExitRecovery();
        this.refreshAll();
        this.reportCapabilities();
      }
      throw new Error(EXIT_ERROR);
    });
    return attempt.promise;
  }

  private renderExitRecovery(): void {
    this.exitRecovery.hidden = !this.exitFailure;
    this.exitRecoveryMessage.textContent = this.exitFailure ?? '';
    this.retryExit.disabled = !!this.endRequest;
    this.retryExit.textContent = this.endRequest ? 'Waiting for XR to exit…' : 'Retry Exit XR';
  }

  private onRetryExit = (): void => { void this.exit().catch(() => undefined); };

  /** BFCache-safe pause. Keep the WebGL renderer and committed layout in memory. */
  suspend(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.suspended = true;
    this.lifecycleEpoch++;
    this.arranging = false;
    this.cancelInteractions();
    this.hovered.clear();
    this.mouseHit = undefined;
    this.renderer.setAnimationLoop(null);
    this.reportCapabilities();
    const session = this.session;
    if (!session) return Promise.resolve();
    return this.requestEnd(session);
  }

  /** Resume ordinary 2D rendering only; a fresh gesture is required for XR. */
  resume(): void {
    if (this.disposed || !this.suspended) return;
    this.suspended = false;
    this.renderExitRecovery();
    const run = ++this.lifecycleEpoch;
    const resumePreview = (): void => {
      if (this.disposed || this.suspended || run !== this.lifecycleEpoch || this.session || this.renderer.xr.isPresenting) return;
      this.resize();
      this.refreshAll();
      this.renderer.setAnimationLoop(this.render);
    };
    if (this.endRequest) void this.endRequest.promise.then(resumePreview, () => undefined);
    else resumePreview();
  }

  async focusInput(input: HTMLTextAreaElement | HTMLInputElement): Promise<void> {
    if (!input.isConnected || input.disabled || input.hidden) throw new Error('The text field must be visible and enabled.');
    this.cancelInteractions();
    if (this.session && !this.session.isSystemKeyboardSupported) await this.exit();
    input.scrollIntoView({ block: 'center', behavior: 'instant' });
    // No await occurs in the supported-keyboard path, preserving the XR selection activation.
    input.focus({ preventScroll: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelInteractions();
    if (this.session) void this.session.end().catch(() => undefined);
    this.onSessionEnd();
    this.renderer.setAnimationLoop(null);
    this.observer.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    canvas.removeEventListener('lostpointercapture', this.onPointerCancel);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    document.removeEventListener('visibilitychange', this.onDocumentVisibility);
    window.removeEventListener('blur', this.onWindowBlur);
    for (const pointer of this.pointers) {
      pointer.removeListeners();
      pointer.line.geometry.dispose(); pointer.line.material.dispose();
      pointer.marker.geometry.dispose(); pointer.marker.material.dispose();
    }
    for (const view of this.views) { view.texture.dispose(); view.mesh.geometry.dispose(); view.mesh.material.dispose(); }
    this.orb.geometry.dispose(); this.orb.material.dispose();
    this.orbHalo.geometry.dispose(); this.orbHalo.material.dispose();
    this.floor.geometry.dispose();
    if (Array.isArray(this.floor.material)) this.floor.material.forEach(material => material.dispose());
    else this.floor.material.dispose();
    this.jointMaterial.dispose();
    this.jointGeometry.dispose();
    this.retryExit.removeEventListener('click', this.onRetryExit);
    this.renderer.dispose();
    canvas.remove(); this.previewLabel.remove(); this.exitRecovery.remove();
  }

  private makePanel(panel: Panel, index: number): PanelView {
    const canvas = document.createElement('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas text rendering is unavailable.');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT), material);
    this.workspace.add(mesh);
    const view: PanelView = { index, panel, canvas, context, texture, mesh, hits: [], textPage: 0, actionPage: 0, signature: '', wrap: new SpatialTextWrap() };
    mesh.userData.view = view;
    this.views.push(view);
    this.applyLayout();
    return view;
  }

  private applyLayout(): void {
    for (const view of this.views) {
      const pose = this.layout.pose(view.index);
      const position = posePosition(pose);
      view.mesh.position.set(position.x, position.y, position.z);
      // Keep text upright while facing the layout's central viewing position.
      view.mesh.rotation.set(0, -pose.angle, 0);
    }
    this.workspace.updateWorldMatrix(true, true);
  }

  private cancelPointer(key: Pointer | number): void {
    this.presses.cancel(key);
    if (this.layout.has(key)) {
      this.layout.cancel(key);
      this.applyLayout();
      this.refreshAll();
    }
  }

  private cancelInteractions(): void {
    this.presses.cancelAll();
    this.layout.cancelAll();
    this.applyLayout();
    this.refreshAll();
  }

  private localRay(): LayoutRay {
    this.workspace.updateWorldMatrix(true, false);
    this.inverseWorkspace.copy(this.workspace.matrixWorld).invert();
    const origin = this.raycaster.ray.origin.clone().applyMatrix4(this.inverseWorkspace);
    const direction = this.raycaster.ray.direction.clone().transformDirection(this.inverseWorkspace);
    return { origin, direction };
  }

  private beginInteraction(key: Pointer | number, target?: Target): void {
    this.cancelPointer(key);
    if (!target || target.hit.action.disabled) return;
    if (target.hit.kind === 'grab') {
      if (!this.arranging || !target.view) return;
      const point = this.workspace.worldToLocal(target.point.clone());
      if (this.layout.begin(key, target.view.index, this.localRay(), point)) this.refreshAll();
      return;
    }
    if (this.arranging && target.hit.kind === 'app') return;
    this.presses.begin(key, target.hit.key, target.hit.action);
  }

  private finishInteraction(key: Pointer | number, target?: Target): void {
    if (this.layout.has(key)) {
      // A drag owns this release completely, even if a button is now under it.
      if (this.arranging) this.layout.end(key, this.localRay());
      else this.layout.cancel(key);
      this.presses.cancel(key);
      this.applyLayout();
      this.refreshAll();
      return;
    }
    const enabled = target && !target.hit.action.disabled && (!this.arranging || target.hit.kind === 'layout');
    this.presses.end(key, enabled ? target.hit.key : undefined);
  }

  private refreshAll(): void { for (const view of this.views) this.refreshPanel(view); }

  private refreshPanel(view: PanelView): void {
    const { context: ctx, panel } = view;
    ctx.font = '42px system-ui, sans-serif';
    const lines = view.wrap.wrapAll(panel.lines, value => ctx.measureText(value).width, WIDTH - 112);
    const textPages = Math.max(1, Math.ceil(lines.length / TEXT_LINES));
    const actionPages = Math.max(1, Math.ceil(panel.actions.length / ACTIONS_PER_PAGE));
    view.textPage = Math.min(view.textPage, textPages - 1);
    view.actionPage = Math.min(view.actionPage, actionPages - 1);
    const hits: Hit[] = [];
    const add = (id: string, action: Action, rect: Rect, kind: Hit['kind'] = 'app'): void => {
      hits.push({ ...rect, key: `${panel.id}/${id}`, action: this.arranging && kind === 'app' ? { ...action, disabled: true } : action, kind });
    };
    if (this.arranging) add('grab-header', { id: 'grab-header', label: 'Hold header to move panel', onSelect: () => undefined }, { x: 24, y: 24, width: WIDTH - 48, height: 184 }, 'grab');
    if (textPages > 1) {
      add('text-prev', { id: 'text-prev', label: 'Previous text', disabled: view.textPage === 0, onSelect: () => { view.textPage--; this.refreshPanel(view); } }, { x: 56, y: 774, width: 360, height: 74 });
      add('text-next', { id: 'text-next', label: 'Next text', disabled: view.textPage === textPages - 1, onSelect: () => { view.textPage++; this.refreshPanel(view); } }, { x: 864, y: 774, width: 360, height: 74 });
    }
    panel.actions.slice(view.actionPage * ACTIONS_PER_PAGE, (view.actionPage + 1) * ACTIONS_PER_PAGE).forEach((action, index) => {
      add(`action/${action.id}`, action, { x: 56, y: 905 + index * 105, width: WIDTH - 112, height: 88 });
    });
    if (actionPages > 1) {
      add('action-prev', { id: 'action-prev', label: 'Previous actions', disabled: view.actionPage === 0, onSelect: () => { view.actionPage--; this.refreshPanel(view); } }, { x: 56, y: 1326, width: 360, height: 64 });
      add('action-next', { id: 'action-next', label: 'Next actions', disabled: view.actionPage === actionPages - 1, onSelect: () => { view.actionPage++; this.refreshPanel(view); } }, { x: 864, y: 1326, width: 360, height: 64 });
    }
    const controlWidth = this.session ? 376 : 576;
    add('arrange', { id: 'arrange', label: this.arranging ? 'Done arranging' : 'Arrange panels', tone: this.arranging ? 'primary' : undefined, onSelect: () => this.setArrangeMode(!this.arranging) }, { x: 56, y: 1440, width: controlWidth, height: 76 }, 'layout');
    add('recenter', { id: 'recenter', label: 'Recenter panels', onSelect: () => this.recenter() }, { x: 72 + controlWidth, y: 1440, width: controlWidth, height: 76 }, 'layout');
    if (this.session) add('exit-xr', { id: 'exit-xr', label: this.exitFailure ? 'Retry Exit XR' : 'Exit spatial view', onSelect: () => { void this.exit().catch(() => undefined); } }, { x: 848, y: 1440, width: 376, height: 76 }, 'layout');
    view.hits = hits;
    const dragging = this.layout.isDragging(view.index);
    const signature = JSON.stringify([panel.id, panel.title, panel.eyebrow, lines, view.textPage, view.actionPage, this.status, !!this.session, this.arranging, dragging, hits.map(hit => [hit.key, hit.action.label, hit.action.disabled, hit.action.tone, this.hovered.has(hit.key)])]);
    if (signature === view.signature) return;
    view.signature = signature;
    ctx.fillStyle = COLORS.background; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = COLORS.border; ctx.lineWidth = 6; ctx.strokeRect(3, 3, WIDTH - 6, HEIGHT - 6);
    ctx.fillStyle = COLORS.accent; ctx.fillRect(0, 0, WIDTH, 10);
    if (this.arranging) {
      const hovered = this.hovered.has(`${panel.id}/grab-header`);
      ctx.fillStyle = dragging ? '#444444' : hovered ? '#333333' : '#242424';
      ctx.beginPath(); ctx.roundRect(24, 24, WIDTH - 48, 184, 18); ctx.fill();
      ctx.strokeStyle = dragging || hovered ? '#eeeeee' : '#777777'; ctx.lineWidth = dragging ? 7 : 4; ctx.stroke();
    }
    ctx.fillStyle = COLORS.muted; ctx.font = '600 27px system-ui, sans-serif';
    this.drawFitted(ctx, this.arranging ? dragging ? 'MOVING PANEL · RELEASE TO PLACE' : 'ARRANGE MODE · HOLD THIS HEADER' : (panel.eyebrow ?? 'PROVIDENCE · CONNECTED WORKSPACE').toUpperCase(), 56, 65, WIDTH - 112);
    ctx.fillStyle = COLORS.text; ctx.font = '600 58px system-ui, sans-serif';
    this.drawFitted(ctx, panel.title, 56, 132, WIDTH - 112);
    ctx.fillStyle = this.arranging ? '#eeeeee' : COLORS.muted; ctx.font = '29px system-ui, sans-serif';
    ctx.fillText(this.arranging ? 'Point, hold, move your ray, then release. App actions are paused.' : 'Point and select · Use Arrange panels to move this window.', 56, 183);
    ctx.fillStyle = COLORS.border; ctx.fillRect(56, 218, WIDTH - 112, 2);
    ctx.fillStyle = COLORS.text; ctx.font = '42px system-ui, sans-serif';
    lines.slice(view.textPage * TEXT_LINES, (view.textPage + 1) * TEXT_LINES).forEach((line, index) => ctx.fillText(line, 56, 280 + index * 48));
    ctx.font = '27px system-ui, sans-serif'; ctx.fillStyle = COLORS.muted;
    if (textPages > 1) this.drawCentered(ctx, `Text ${view.textPage + 1} / ${textPages}`, WIDTH / 2, 820);
    else ctx.fillText('Task status and output · no desktop stream', 56, 824);
    ctx.fillStyle = COLORS.muted; ctx.font = '600 27px system-ui, sans-serif'; ctx.fillText(this.arranging ? 'APPLICATION ACTIONS PAUSED' : 'ACTIONS', 56, 882);
    if (actionPages > 1) this.drawCentered(ctx, `${view.actionPage + 1} / ${actionPages}`, WIDTH / 2, 1368);
    if (!panel.actions.length) { ctx.font = '34px system-ui, sans-serif'; ctx.fillText('No actions available here.', 56, 964); }
    for (const hit of hits) if (hit.kind !== 'grab') this.drawButton(ctx, hit);
    ctx.fillStyle = COLORS.muted; ctx.font = '25px system-ui, sans-serif';
    this.drawFitted(ctx, this.arranging ? 'Done returns to work. Recenter restores the four-panel layout.' : this.status, 56, 1421, WIDTH - 112);
    view.texture.needsUpdate = true;
  }

  private drawButton(ctx: CanvasRenderingContext2D, hit: Hit): void {
    const active = this.hovered.has(hit.key) && !hit.action.disabled;
    ctx.fillStyle = hit.action.disabled ? '#222222' : active ? '#444444' : hit.action.tone === 'danger' ? '#333333' : hit.action.tone === 'primary' ? '#444444' : '#303030';
    ctx.beginPath(); ctx.roundRect(hit.x, hit.y, hit.width, hit.height, 13); ctx.fill();
    if (active) { ctx.strokeStyle = '#eeeeee'; ctx.lineWidth = 6; ctx.stroke(); }
    ctx.fillStyle = hit.action.disabled ? '#888888' : COLORS.text;
    const fontSize = hit.kind === 'layout' ? 31 : hit.width < 450 ? 27 : 35;
    ctx.font = `${fontSize}px system-ui, sans-serif`;
    const lines = wrapSpatialText(hit.action.label, value => ctx.measureText(value).width, hit.width - 48);
    if (lines.length > 1 && hit.height >= 86) {
      this.drawFitted(ctx, lines[0], hit.x + 24, hit.y + 34, hit.width - 48);
      this.drawFitted(ctx, lines.slice(1).join(' '), hit.x + 24, hit.y + 72, hit.width - 48);
    } else this.drawFitted(ctx, hit.action.label, hit.x + 24, hit.y + hit.height / 2 + fontSize * 0.35, hit.width - 48);
  }

  private drawFitted(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number): void {
    // Keep glyphs readable instead of horizontally squeezing long labels.
    if (ctx.measureText(text).width <= maxWidth) { ctx.fillText(text, x, y); return; }
    const characters = Array.from(text);
    while (characters.length && ctx.measureText(`${characters.join('')}…`).width > maxWidth) characters.pop();
    ctx.fillText(`${characters.join('')}…`, x, y);
  }

  private drawCentered(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
    ctx.textAlign = 'center'; ctx.fillText(text, x, y); ctx.textAlign = 'left';
  }

  private makePointer(index: number): void {
    const ray = this.renderer.xr.getController(index);
    const hand = this.renderer.xr.getHand(index);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: '#dddddd', transparent: true, opacity: 0.65 }));
    line.scale.z = 4;
    ray.add(line);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: '#dddddd', depthTest: false }));
    marker.visible = false; marker.renderOrder = 5;
    const pointer: Pointer = { ray, hand, line, marker, joints: new Map(), removeListeners: () => undefined };
    const connected = (event: { data: XRInputSource }): void => { pointer.source = event.data; this.reportCapabilities(); };
    const disconnected = (): void => { this.cancelPointer(pointer); pointer.source = undefined; marker.visible = false; this.reportCapabilities(); };
    const selectstart = (): void => {
      if (this.suspended || !this.session || this.session.visibilityState !== 'visible' || !pointer.source || !pointer.ray.visible) return;
      this.selectionCount++;
      this.reportCapabilities();
      const target = this.hitFromPointer(pointer);
      this.beginInteraction(pointer, target);
    };
    const selectend = (): void => {
      if (this.suspended || !this.session || this.session.visibilityState !== 'visible' || !pointer.source || !pointer.ray.visible) {
        this.cancelPointer(pointer);
        return;
      }
      const target = this.hitFromPointer(pointer);
      this.finishInteraction(pointer, target);
    };
    ray.addEventListener('connected', connected);
    ray.addEventListener('disconnected', disconnected);
    ray.addEventListener('selectstart', selectstart);
    ray.addEventListener('selectend', selectend);
    pointer.removeListeners = () => {
      ray.removeEventListener('connected', connected); ray.removeEventListener('disconnected', disconnected);
      ray.removeEventListener('selectstart', selectstart); ray.removeEventListener('selectend', selectend);
    };
    this.pointers.push(pointer);
    this.scene.add(ray, hand, marker);
  }

  private hitFromPointer(pointer: Pointer): Target | undefined {
    if (!pointer.source || !pointer.ray.visible) return;
    pointer.ray.updateWorldMatrix(true, false);
    this.rotation.extractRotation(pointer.ray.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(pointer.ray.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.rotation);
    return this.hitFromRay(pointer);
  }

  private hitFromRay(pointer?: Pointer): Target | undefined {
    this.workspace.updateWorldMatrix(true, true);
    const intersection = this.raycaster.intersectObjects<THREE.Mesh>([...this.views.map(view => view.mesh), this.orb], false)[0];
    if (pointer) {
      pointer.line.scale.z = intersection?.distance ?? 4;
      pointer.marker.visible = !!intersection;
      if (intersection) pointer.marker.position.copy(intersection.point);
    }
    if (intersection?.object === this.orb && this.voice) {
      return { point: intersection.point, hit: { x: 0, y: 0, width: 0, height: 0, key: 'voice-orb', kind: 'app',
        action: { ...this.voice.action, disabled: this.arranging || this.voice.action.disabled } } };
    }
    if (!intersection?.uv) return;
    const view = intersection.object.userData.view as PanelView;
    const x = intersection.uv.x * WIDTH;
    const y = (1 - intersection.uv.y) * HEIGHT;
    const hit = view.hits.find(rect => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height);
    if (hit) return { view, hit, point: intersection.point };
  }

  private mouseTarget(event: PointerEvent): Target | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    return this.hitFromRay();
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (this.suspended || this.session) return;
    this.mouseHit = this.mouseTarget(event);
    if (this.layout.has(event.pointerId)) {
      if (event.buttons === 0 || !this.layout.update(event.pointerId, this.localRay())) this.cancelPointer(event.pointerId);
      else this.applyLayout();
    }
    this.renderer.domElement.style.cursor = this.layout.has(event.pointerId) ? 'grabbing' : this.mouseHit && !this.mouseHit.hit.action.disabled ? this.mouseHit.hit.kind === 'grab' ? 'grab' : 'pointer' : 'default';
  };
  private onPointerDown = (event: PointerEvent): void => {
    if (this.suspended || this.session || event.button !== 0) return;
    this.mouseHit = this.mouseTarget(event);
    if (this.mouseHit) {
      this.renderer.domElement.setPointerCapture(event.pointerId);
      this.beginInteraction(event.pointerId, this.mouseHit);
    }
  };
  private onPointerUp = (event: PointerEvent): void => {
    if (this.suspended || this.session || document.visibilityState !== 'visible') { this.cancelPointer(event.pointerId); return; }
    const target = this.mouseTarget(event);
    this.finishInteraction(event.pointerId, target);
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) this.renderer.domElement.releasePointerCapture(event.pointerId);
  };
  private onPointerCancel = (event: PointerEvent): void => { this.cancelPointer(event.pointerId); };
  private onPointerLeave = (): void => { this.mouseHit = undefined; };
  private onWindowBlur = (): void => { this.cancelInteractions(); };
  private onDocumentVisibility = (): void => { if (document.visibilityState !== 'visible') this.cancelInteractions(); };
  private onSessionVisibility = (): void => {
    if (this.session?.visibilityState !== 'visible') this.cancelInteractions();
    this.reportCapabilities();
  };
  private onSourcesChange = (): void => {
    for (const pointer of this.pointers) if (pointer.source && !Array.from(this.session?.inputSources ?? []).includes(pointer.source)) this.cancelPointer(pointer);
    this.reportCapabilities();
  };
  private onSessionEnd(event?: XRSessionEvent): void {
    if (event) {
      this.observedEnds.add(event.session);
      if (this.endRequest?.session === event.session) this.endRequest = undefined;
      if (event.session !== this.session) return;
    }
    this.cancelInteractions();
    if (this.session) {
      this.session.removeEventListener('end', this.onSessionEnd);
      this.session.removeEventListener('visibilitychange', this.onSessionVisibility);
      this.session.removeEventListener('inputsourceschange', this.onSourcesChange);
    }
    this.session = undefined;
    this.exitFailure = undefined;
    this.renderExitRecovery();
    this.arranging = false;
    this.needsPlacement = false;
    this.workspace.position.set(0, 1.55, 0); this.workspace.rotation.set(0, 0, 0);
    this.floor.position.y = 0;
    this.scene.background = new THREE.Color('#0b0b0b'); this.renderer.setClearColor('#0b0b0b', 1);
    this.floor.visible = true; this.previewLabel.hidden = false;
    for (const pointer of this.pointers) { pointer.marker.visible = false; pointer.ray.visible = false; pointer.hand.visible = false; pointer.source = undefined; }
    this.hovered.clear();
    if (!this.disposed) {
      this.resize(); this.refreshAll(); this.reportCapabilities();
      if (!this.suspended) this.renderer.setAnimationLoop(this.render);
    }
  }

  private reportCapabilities(): void {
    const sources = Array.from(this.session?.inputSources ?? []);
    const value: SpatialCapabilities = {
      active: !!this.session,
      hands: sources.filter(source => !!source.hand).length,
      controllers: sources.filter(source => !source.hand && source.targetRayMode === 'tracked-pointer').length,
      keyboard: this.session?.isSystemKeyboardSupported === true,
      selections: this.selectionCount,
      arranging: this.arranging,
      focused: !this.session || this.session.visibilityState === 'visible',
      ...(this.exitFailure ? { exitError: this.exitFailure } : {}),
    };
    const signature = JSON.stringify(value);
    if (signature !== this.capabilitySignature) { this.capabilitySignature = signature; this.onCapabilities(value); }
  }

  private resize = (): void => {
    if (this.disposed || this.session) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(280, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.fov = width < 600 ? 75 : 52;
    // Fit the actual curved panel corners with space for the caption. This changes
    // only the desktop camera; immersive uses the headset's own tracked cameras.
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    let distance = 0;
    for (let index = 0; index < 4; index++) {
      const pose = this.layout.pose(index);
      const center = posePosition(pose);
      for (const side of [-PANEL_WIDTH / 2, PANEL_WIDTH / 2]) {
        const x = center.x + Math.cos(pose.angle) * side;
        const z = center.z + Math.sin(pose.angle) * side;
        distance = Math.max(distance,
          z + Math.abs(x) / (tangent * this.camera.aspect * 0.88),
          z + (Math.abs(pose.height) + PANEL_HEIGHT / 2) / (tangent * 0.8));
      }
    }
    this.camera.position.set(0, 1.55, distance);
    this.camera.lookAt(0, 1.55, -1.6);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private render = (): void => {
    if (this.disposed || this.suspended || document.visibilityState === 'hidden') return;
    if (this.needsPlacement && this.renderer.xr.isPresenting) {
      const xrCamera = this.renderer.xr.getCamera();
      xrCamera.getWorldPosition(this.position);
      xrCamera.getWorldDirection(this.direction);
      this.workspace.position.copy(this.position);
      this.workspace.rotation.y = Math.atan2(-this.direction.x, -this.direction.z);
      this.floor.position.y = this.position.y - 1.6;
      this.needsPlacement = false;
    }
    const hovered = new Set<string>();
    if (this.session && this.session.visibilityState === 'visible') {
      for (const pointer of this.pointers) {
        if (!pointer.source || !pointer.ray.visible) {
          this.cancelPointer(pointer); pointer.marker.visible = false; continue;
        }
        const target = this.hitFromPointer(pointer);
        if (this.layout.has(pointer)) {
          if (!this.layout.update(pointer, this.localRay())) this.cancelPointer(pointer);
          else this.applyLayout();
        }
        if (target && !target.hit.action.disabled) hovered.add(target.hit.key);
        if (pointer.source.hand) {
          for (const joint of Object.values(pointer.hand.joints)) {
            if (!joint) continue;
            let sphere = pointer.joints.get(joint);
            if (!sphere) { sphere = new THREE.Mesh(this.jointGeometry, this.jointMaterial); joint.add(sphere); pointer.joints.set(joint, sphere); }
            sphere.scale.setScalar(joint.jointRadius ?? 0.007);
          }
        }
      }
      this.reportCapabilities();
    } else if (!this.session && this.mouseHit && !this.mouseHit.hit.action.disabled) hovered.add(this.mouseHit.hit.key);
    if (hovered.size !== this.hovered.size || Array.from(hovered).some(key => !this.hovered.has(key))) { this.hovered = hovered; this.refreshAll(); }
    const listening = this.voice?.state === 'recording';
    const working = ['working', 'transcribing', 'speaking'].includes(this.voice?.state ?? '');
    const tick = performance.now() / 1000;
    const pulse = this.reducedMotion ? 1 : 1 + Math.sin(tick * (listening ? 4 : 1.3)) * (listening ? 0.045 : 0.012);
    this.orb.scale.setScalar(pulse);
    this.orb.position.y = 0.12 + (this.reducedMotion ? 0 : Math.sin(tick * 0.8) * 0.018);
    this.orb.material.color.set(listening ? '#ffffff' : '#ffffff');
    this.orb.material.emissiveIntensity = listening ? 0.5 : hovered.has('voice-orb') ? 0.3 : 0.13;
    this.orbHalo.position.copy(this.orb.position);
    this.orbHalo.material.opacity = working || listening ? 0.65 : 0.25;
    this.orbHalo.rotation.set(0.55, this.reducedMotion ? 0 : tick * (working ? 0.8 : 0.12), 0.2);
    this.renderer.render(this.scene, this.camera);
  };
}
