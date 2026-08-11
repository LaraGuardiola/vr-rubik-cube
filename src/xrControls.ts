import * as THREE from 'three';
import { RubiksCube, CUBIE_SIZE, type AxisIndex } from './cube';
import type { PinchSource } from './hands';

// ---------------------------------------------------------------------------
// VR grab interactions (shared by hand tracking and Quest controllers).
//
// Two explicit gestures, same on hands and controllers:
//  1. LAYER TURN  — hands: index-finger pinch (thumb↔index) on a face;
//                   controllers: aim the laser at a face and pull the trigger.
//                   While held, the slice follows the grab point's orbit around
//                   the slice axis; on release the cube snaps to 90°.
//  2. WHOLE-CUBE  — hands: middle-finger pinch (thumb↔middle) anywhere;
//                   controllers: grip (squeeze) button.
//                   The cube stays glued to the hand/controller pose and floats
//                   where it is released (no gravity).
//
// Only one interaction is active at a time (first grabber wins; others are
// ignored until it releases).
// ---------------------------------------------------------------------------

const GRAB_RADIUS = 0.055; // metres around the pinch point that counts as "touching a cubie"
const AXIS_CHOOSE_THRESHOLD = 0.12; // radians of hand motion before an ambiguous axis is chosen

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Angle of a cube-local point around an axis, in radians, matching the right-hand rule. */
function angleAround(p: THREE.Vector3, axis: AxisIndex): number {
  // pattern: for axis a, angle = atan2(component[(a+2)%3], component[(a+1)%3])
  return Math.atan2(p.getComponent(((axis + 2) % 3) as AxisIndex), p.getComponent(((axis + 1) % 3) as AxisIndex));
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

interface LayerGrab {
  cubies: { logical: THREE.Vector3 }[] | null; // null for controller (ray) picks
  candidates: AxisIndex[] | null; // null for controller picks (axis known immediately)
  axis: AxisIndex | null;
  layer: number | null;
  baseAngle: number[]; // per-axis base angle at grab start
  liveStarted: boolean;
}

interface WholeGrab {
  handPos0: THREE.Vector3;
  handQuat0: THREE.Quaternion;
  cubePos0: THREE.Vector3;
  cubeQuat0: THREE.Quaternion;
}

export class XRControls {
  private layerGrab: LayerGrab | null = null;
  private layerSource: PinchSource | null = null;
  private wholeGrab: WholeGrab | null = null;
  private wholeSource: PinchSource | null = null;

  constructor(private cube: RubiksCube) {}

  attach(source: PinchSource): void {
    source.onPinchStart = () => this.onPinchStart(source);
    source.onPinchMove = () => this.onPinchMove(source);
    source.onPinchEnd = () => this.onPinchEnd(source);
    source.onGrabStart = () => this.onGrabStart(source);
    source.onGrabMove = () => this.onGrabMove(source);
    source.onGrabEnd = () => this.onGrabEnd(source);
  }

  // ------------------------------------------------------------- layer turns

  private onPinchStart(source: PinchSource): void {
    if (this.layerGrab !== null || this.wholeGrab !== null) return; // busy

    // controller laser → pick the exact slice under the beam
    if (source.pickSlice) {
      const picked = source.pickSlice();
      if (picked && this.cube.beginLiveTurn(picked.axis, picked.layer)) {
        const local = this.cube.worldToLocal(source.pinchPoint.clone());
        const baseAngle = [0, 0, 0];
        baseAngle[picked.axis] = angleAround(local, picked.axis);
        this.layerGrab = {
          cubies: null,
          candidates: null,
          axis: picked.axis,
          layer: picked.layer,
          baseAngle,
          liveStarted: true,
        };
        this.layerSource = source;
      }
      return;
    }

    // hand tracking → proximity grab with the index finger
    this.cube.updateMatrixWorld(true);
    const point = source.pinchPoint.clone();
    const found = this.cube.cubieAt(point, GRAB_RADIUS);
    if (found.length === 0) return;

    // Which slices do the grabbed cubies share?
    const common = [new Set<number>(), new Set<number>(), new Set<number>()];
    for (const c of found) {
      for (let a = 0; a < 3; a++) common[a].add(c.logical.getComponent(a));
    }
    let candidates: AxisIndex[] = [];
    for (let a = 0; a < 3; a++) {
      if (common[a].size === 1) candidates.push(a as AxisIndex);
    }
    if (candidates.length === 0) {
      // Grabbed cubies span several slices (e.g. a corner) — use the closest
      // cubie and let hand motion pick the axis.
      let closest = found[0];
      let bestD = Infinity;
      for (const c of found) {
        const d = point.distanceTo(c.logical.clone().multiplyScalar(CUBIE_SIZE));
        if (d < bestD) {
          bestD = d;
          closest = c;
        }
      }
      candidates = [0, 1, 2];
      found.length = 0;
      found.push(closest);
    }

    const local = this.cube.worldToLocal(point.clone());
    const baseAngle = [0, 0, 0];
    for (const a of candidates) baseAngle[a] = angleAround(local, a);

    this.layerGrab = { cubies: found, candidates, axis: null, layer: null, baseAngle, liveStarted: false };
    this.layerSource = source;

    if (candidates.length === 1) {
      this.beginLayerTurn(candidates[0]);
    }
    // otherwise the axis is chosen from hand motion in onPinchMove
  }

  private onPinchMove(source: PinchSource): void {
    if (this.layerSource !== source || this.layerGrab === null) return;
    const g = this.layerGrab;
    const local = this.cube.worldToLocal(source.pinchPoint.clone());

    if (g.candidates !== null && !g.liveStarted) {
      // ambiguous grab (hands): pick the axis with the most motion so far
      let bestAxis = g.candidates[0];
      let bestDelta = 0;
      for (const a of g.candidates) {
        const delta = Math.abs(wrapAngle(angleAround(local, a) - g.baseAngle[a]));
        if (delta > bestDelta) {
          bestDelta = delta;
          bestAxis = a;
        }
      }
      if (bestDelta > AXIS_CHOOSE_THRESHOLD) this.beginLayerTurn(bestAxis);
    }

    if (g.axis !== null) {
      const delta = wrapAngle(angleAround(local, g.axis) - g.baseAngle[g.axis]);
      this.cube.setLiveAngle(delta);
    }
  }

  private onPinchEnd(source: PinchSource): void {
    if (this.layerSource !== source || this.layerGrab === null) return;
    this.cube.endLiveTurn(); // no-op when no live turn was started
    this.layerGrab = null;
    this.layerSource = null;
  }

  private beginLayerTurn(axis: AxisIndex): void {
    const g = this.layerGrab;
    if (g === null || g.liveStarted || g.cubies === null || g.cubies.length === 0) return;
    const layer = g.cubies[0].logical.getComponent(axis);
    if (this.cube.beginLiveTurn(axis, layer)) {
      g.axis = axis;
      g.layer = layer;
      g.liveStarted = true;
    }
  }

  // ----------------------------------------------------------- whole-cube grab

  private onGrabStart(source: PinchSource): void {
    if (this.layerGrab !== null || this.wholeGrab !== null) return; // busy
    this.startWhole(source);
  }

  private onGrabMove(source: PinchSource): void {
    if (this.wholeSource !== source || this.wholeGrab === null) return;
    const w = this.wholeGrab;
    // R = handQuat * inv(handQuat0); cube rigidly attached to the hand
    _q.copy(source.palmQuat).multiply(_q2.copy(w.handQuat0).invert());
    _v.copy(w.cubePos0).sub(w.handPos0).applyQuaternion(_q);
    this.cube.position.copy(source.palmPos).add(_v);
    this.cube.quaternion.copy(_q).multiply(w.cubeQuat0);
  }

  private onGrabEnd(source: PinchSource): void {
    if (this.wholeSource !== source || this.wholeGrab === null) return;
    this.wholeGrab = null;
    this.wholeSource = null;
  }

  private startWhole(source: PinchSource): void {
    this.cube.updateMatrixWorld(true);
    this.wholeGrab = {
      handPos0: source.palmPos.clone(),
      handQuat0: source.palmQuat.clone(),
      cubePos0: this.cube.getWorldPosition(new THREE.Vector3()),
      cubeQuat0: this.cube.getWorldQuaternion(new THREE.Quaternion()),
    };
    this.wholeSource = source;
  }
}
