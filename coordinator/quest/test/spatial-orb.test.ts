import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SpatialWorkspace } from '../src/spatial';
import { SpatialPresses } from '../src/spatial-interactions';
import { PanelArrangement } from '../src/spatial-layout';

// Exercise real raycasting and interaction methods without a browser, microphone,
// or WebGL session. Physical headset input still needs a headset test.
function fixture() {
  const workspace: any = Object.create(SpatialWorkspace.prototype);
  const orb = new THREE.Mesh(new THREE.SphereGeometry(.21, 16, 12), new THREE.MeshBasicMaterial());
  orb.position.set(0, 0, -1);
  const group = new THREE.Group(); group.add(orb);
  let selected = 0;
  Object.assign(workspace, {
    workspace: group, orb, views: [], arranging: false,
    raycaster: new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1)),
    layout: new PanelArrangement(), presses: new SpatialPresses(),
    voice: { state: 'ready', label: 'Speak', action: { id: 'voice', label: 'Speak', onSelect: () => selected++ } },
  });
  return { workspace, get selected() { return selected; }, cleanup: () => { orb.geometry.dispose(); orb.material.dispose(); } };
}

test('the actual sphere ray target selects voice once on release and cancels an abandoned press', () => {
  const f = fixture();
  try {
    const target = f.workspace.hitFromRay();
    assert.equal(target.hit.key, 'voice-orb');
    f.workspace.beginInteraction(1, target);
    assert.equal(f.selected, 0);
    f.workspace.finishInteraction(1, target);
    assert.equal(f.selected, 1);
    f.workspace.beginInteraction(2, target);
    f.workspace.cancelPointer(2);
    f.workspace.finishInteraction(2, target);
    assert.equal(f.selected, 1);
  } finally { f.cleanup(); }
});

test('unavailable voice or arrangement mode cannot activate the spatial sphere', () => {
  const f = fixture();
  try {
    for (const arranging of [false, true]) {
      f.workspace.arranging = arranging;
      f.workspace.voice.action.disabled = !arranging;
      const target = f.workspace.hitFromRay();
      assert.equal(target.hit.action.disabled, true);
      f.workspace.beginInteraction(1, target);
      f.workspace.finishInteraction(1, target);
    }
    assert.equal(f.selected, 0);
  } finally { f.cleanup(); }
});
