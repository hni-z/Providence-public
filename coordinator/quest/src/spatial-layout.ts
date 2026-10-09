/** Workspace-local coordinates, in metres. Angles are radians around the Y axis. */
export type LayoutVector = { x: number; y: number; z: number };
export type LayoutRay = { origin: LayoutVector; direction: LayoutVector };
export type PanelPose = { angle: number; distance: number; height: number };

const MAX_ANGLE = 70 * Math.PI / 180;
const DEFAULT_DISTANCE = 2.3;

export const DEFAULT_PANEL_POSES: readonly PanelPose[] = Object.freeze(
  Array.from({ length: 4 }, (_, index) => Object.freeze({
    angle: (index - 1.5) * 31 * Math.PI / 180,
    distance: DEFAULT_DISTANCE,
    height: 0,
  })),
);

function bounded(value: number, fallback: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : fallback));
}

/** Invalid components use a neutral default; the input object is never changed. */
export function clampPanelPose(pose: PanelPose): PanelPose {
  return {
    angle: bounded(pose?.angle, 0, -MAX_ANGLE, MAX_ANGLE),
    distance: bounded(pose?.distance, DEFAULT_DISTANCE, 1.8, 3.2),
    height: bounded(pose?.height, 0, -0.55, 0.45),
  };
}

export function posePosition(pose: PanelPose): LayoutVector {
  const safe = clampPanelPose(pose);
  return { x: Math.sin(safe.angle) * safe.distance, y: safe.height, z: -Math.cos(safe.angle) * safe.distance };
}

function finiteVector(value: LayoutVector | null | undefined): value is LayoutVector {
  return !!value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function normalizedRay(ray: LayoutRay): LayoutRay | undefined {
  if (!finiteVector(ray?.origin) || !finiteVector(ray?.direction)) return;
  const scale = Math.max(Math.abs(ray.direction.x), Math.abs(ray.direction.y), Math.abs(ray.direction.z));
  if (scale === 0) return;
  // Scale first so even very large or subnormal finite directions normalize safely.
  const x = ray.direction.x / scale, y = ray.direction.y / scale, z = ray.direction.z / scale;
  const length = Math.hypot(x, y, z);
  return { origin: { ...ray.origin }, direction: { x: x / length, y: y / length, z: z / length } };
}

interface Drag {
  index: number;
  offset: LayoutVector;
  distance: number;
  preview: PanelPose;
}

/** One capture per pointer and per panel. Only a valid release commits a preview. */
export class PanelArrangement<Key> {
  private readonly defaults: PanelPose[];
  private committed: PanelPose[];
  private readonly captures = new Map<Key, Drag>();
  private readonly owners = new Map<number, Drag>();

  constructor(defaults: readonly PanelPose[] = DEFAULT_PANEL_POSES) {
    this.defaults = defaults.map(clampPanelPose);
    this.committed = this.defaults.map(pose => ({ ...pose }));
  }

  pose(index: number): PanelPose {
    if (!this.validIndex(index)) throw new RangeError('Panel index is out of range.');
    return { ...(this.owners.get(index)?.preview ?? this.committed[index]) };
  }

  begin(key: Key, index: number, ray: LayoutRay, hitPoint: LayoutVector): boolean {
    if (!this.validIndex(index) || this.captures.has(key) || this.owners.has(index)) return false;
    const normalized = normalizedRay(ray);
    if (!normalized || !finiteVector(hitPoint)) return false;
    const distance = Math.hypot(hitPoint.x - normalized.origin.x, hitPoint.y - normalized.origin.y, hitPoint.z - normalized.origin.z);
    if (!Number.isFinite(distance) || distance === 0) return false;
    const preview = this.pose(index);
    const center = posePosition(preview);
    const offset = { x: hitPoint.x - center.x, y: hitPoint.y - center.y, z: hitPoint.z - center.z };
    if (!finiteVector(offset)) return false;
    const drag: Drag = { index, offset, distance, preview };
    this.captures.set(key, drag);
    this.owners.set(index, drag);
    return true;
  }

  update(key: Key, ray: LayoutRay): boolean {
    const drag = this.captures.get(key);
    const normalized = normalizedRay(ray);
    if (!drag || !normalized) return false;
    const center = {
      x: normalized.origin.x + normalized.direction.x * drag.distance - drag.offset.x,
      y: normalized.origin.y + normalized.direction.y * drag.distance - drag.offset.y,
      z: normalized.origin.z + normalized.direction.z * drag.distance - drag.offset.z,
    };
    if (!finiteVector(center)) return false;
    // Clamp the horizontal radius without overflowing hypot for extreme finite coordinates.
    const distance = Math.min(3.2, Math.hypot(center.x, center.z));
    drag.preview = clampPanelPose({ angle: Math.atan2(center.x, -center.z), distance, height: center.y });
    return true;
  }

  end(key: Key, ray: LayoutRay): boolean {
    const drag = this.captures.get(key);
    if (!drag) return false;
    const valid = this.update(key, ray);
    if (valid) this.committed[drag.index] = { ...drag.preview };
    this.cancel(key);
    return valid;
  }

  cancel(key: Key): void {
    const drag = this.captures.get(key);
    if (!drag) return;
    this.captures.delete(key);
    this.owners.delete(drag.index);
  }

  cancelAll(): void { this.captures.clear(); this.owners.clear(); }

  reset(): void {
    this.cancelAll();
    this.committed = this.defaults.map(pose => ({ ...pose }));
  }

  has(key: Key): boolean { return this.captures.has(key); }
  isDragging(index: number): boolean { return this.owners.has(index); }
  private validIndex(index: number): boolean { return Number.isInteger(index) && index >= 0 && index < this.committed.length; }
}
