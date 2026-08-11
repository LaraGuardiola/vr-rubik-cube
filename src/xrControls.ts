import * as THREE from 'three';
import { RubiksCube, type AxisIndex } from './cube';
import type { HandState } from './hands';

// ---------------------------------------------------------------------------
// VR grab interactions.
//
// Two gestures:
//  1. LAYER TURN — pinch one or more cubies that lie in a single slice. While
//     pinched, the slice follows the hand's orbit around the slice axis; on
//     release the cube snaps to the nearest 90deg step.
//  2. WHOLE-CUBE — pinch in empty space near the cube (or grab cubies that span
//     several slices). The cube stays glued to the hand's position/orientation
//     and floats where it is released (no gravity).
//
// Only one interaction is active at a time (first hand wins; the other is
// ignored until it re-pinches).
// ---------------------------------------------------------------------------

const GRAB_RADIUS = 0.14; // metres around the pinch point that counts as "touching a cubie"
const WHOLE_GRAB_DIST = 0.55; // metres from cube centre for an empty-space whole-cube grab
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
  cubies: { logical: THREE.Vector3 }[];
  candidates: AxisIndex[];
  axis: AxisIndex | null;
  layer: number | null;
  baseAngle: number[];
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
  private layerHand: THREE.Group | null = null;
  private wholeGrab: WholeGrab | null = null;
  private wholeHand: THREE.Group | null = null;

  constructor(private cube: RubiksCube) {}

  attach(hand: HandState): void {
    const rig = hand.rig;
    rig.onPinchStart = (s) => this.onPinchStart(s);
    rig.onPinchMove = (s) => this.onPinchMove(s);
    rig.onPinchEnd = (s) => this.onPinchEnd(s);
  }

  private onPinchStart(s: HandState): void {
    if (this.layerGrab !== null || this.wholeGrab !== null) return; // busy

    this.cube.updateMatrixWorld(true);
    const point = s.pinchPoint.clone();
    const found = this.cube.cubieAt(point, GRAB_RADIUS);

    if (found.length > 0) {
      // Which slices do the grabbed cubies share?
      const common = [new Set<number>(), new Set<number>(), new Set<number>()];
      for (const c of found) {
        for (let a = 0; a < 3; a++) common[a].add(c.logical.getComponent(a));
      }
      const candidates: AxisIndex[] = [];
      for (let a = 0; a < 3; a++) {
        if (common[a].size === 1) candidates.push(a as AxisIndex);
      }

      if (candidates.length === 0) {
        // Grabbed cubies that don't line up on any slice → treat as whole-cube grab.
        this.startWhole(s);
        return;
      }

      const local = this.cube.worldToLocal(point.clone());
      const baseAngle = [0, 0, 0];
      for (const a of candidates) baseAngle[a] = angleAround(local, a);

      this.layerGrab = { cubies: found, candidates, axis: null, layer: null, baseAngle, liveStarted: false };
      this.layerHand = s.hand;

      if (candidates.length === 1) {
        this.beginLayerTurn(candidates[0]);
      }
      // otherwise the axis is chosen from hand motion in onPinchMove
    } else if (point.distanceTo(this.cube.getWorldPosition(_v)) <= WHOLE_GRAB_DIST) {
      this.startWhole(s);
    }
  }

  private onPinchMove(s: HandState): void {
    if (this.layerHand === s.hand && this.layerGrab !== null) {
      const g = this.layerGrab;
      const local = this.cube.worldToLocal(s.pinchPoint.clone());

      if (!g.liveStarted) {
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

      if (g.liveStarted && g.axis !== null) {
        const delta = wrapAngle(angleAround(local, g.axis) - g.baseAngle[g.axis]);
        this.cube.setLiveAngle(delta);
      }
    }

    if (this.wholeHand === s.hand && this.wholeGrab !== null) {
      const w = this.wholeGrab;
      // R = handQuat * inv(handQuat0); cube rigidly attached to the hand
      _q.copy(s.palmQuat).multiply(_q2.copy(w.handQuat0).invert());
      _v.copy(w.cubePos0).sub(w.handPos0).applyQuaternion(_q);
      this.cube.position.copy(s.palmPos).add(_v);
      this.cube.quaternion.copy(_q).multiply(w.cubeQuat0);
    }
  }

  private onPinchEnd(s: HandState): void {
    if (this.layerHand === s.hand && this.layerGrab !== null) {
      if (this.layerGrab.liveStarted) this.cube.endLiveTurn();
      this.layerGrab = null;
      this.layerHand = null;
    }
    if (this.wholeHand === s.hand && this.wholeGrab !== null) {
      this.wholeGrab = null;
      this.wholeHand = null;
    }
  }

  private beginLayerTurn(axis: AxisIndex): void {
    const g = this.layerGrab;
    if (g === null || g.liveStarted) return;
    const layer = g.cubies[0].logical.getComponent(axis);
    if (this.cube.beginLiveTurn(axis, layer)) {
      g.axis = axis;
      g.layer = layer;
      g.liveStarted = true;
    }
  }

  private startWhole(s: HandState): void {
    this.cube.updateMatrixWorld(true);
    this.wholeGrab = {
      handPos0: s.palmPos.clone(),
      handQuat0: s.palmQuat.clone(),
      cubePos0: this.cube.getWorldPosition(new THREE.Vector3()),
      cubeQuat0: this.cube.getWorldQuaternion(new THREE.Quaternion()),
    };
    this.wholeHand = s.hand;
  }
}
