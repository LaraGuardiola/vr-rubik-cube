import * as THREE from 'three';
import { RubiksCube, type AxisIndex } from './cube';
import type { PinchSource } from './hands';

// ---------------------------------------------------------------------------
// VR grab interactions (shared by hand tracking and Quest controllers).
//
// Two gestures:
//  1. LAYER TURN — pinch/grab cubies that lie in a single slice, or aim a
//     controller at a face and pull the trigger. While held, the slice follows
//     the grab point's orbit around the slice axis; on release the cube snaps
//     to the nearest 90deg step.
//  2. WHOLE-CUBE — pinch in empty space near the cube, aim a controller away
//     from the cube, or hold the controller grip button. The cube stays glued
//     to the hand/controller and floats where it is released (no gravity).
//
// Only one interaction is active at a time (first grabber wins; others are
// ignored until it releases).
// ---------------------------------------------------------------------------

const GRAB_RADIUS = 0.14; // metres around the pinch point that counts as "touching a cubie"
const WHOLE_GRAB_DIST = 0.55; // metres from cube centre for an empty-space whole-cube grab (hands)
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
  }

  private onPinchStart(source: PinchSource): void {
    if (this.layerGrab !== null || this.wholeGrab !== null) return; // busy

    // grip button → always move the whole cube
    if (source.preferWholeGrab) {
      this.startWhole(source);
      return;
    }

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
        return;
      }
      // beam missed the cube → whole-cube grab (move it closer!)
      this.startWhole(source);
      return;
    }

    // hand tracking → proximity grab
    this.cube.updateMatrixWorld(true);
    const point = source.pinchPoint.clone();
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
        // Grabbed cubies that don't line up on any slice → whole-cube grab.
        this.startWhole(source);
        return;
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
    } else if (
      point.distanceTo(this.cube.getWorldPosition(_v)) <=
      (source.wholeGrabDistance ?? WHOLE_GRAB_DIST)
    ) {
      this.startWhole(source);
    }
  }

  private onPinchMove(source: PinchSource): void {
    if (this.layerSource === source && this.layerGrab !== null) {
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

    if (this.wholeSource === source && this.wholeGrab !== null) {
      const w = this.wholeGrab;
      // R = handQuat * inv(handQuat0); cube rigidly attached to the hand
      _q.copy(source.palmQuat).multiply(_q2.copy(w.handQuat0).invert());
      _v.copy(w.cubePos0).sub(w.handPos0).applyQuaternion(_q);
      this.cube.position.copy(source.palmPos).add(_v);
      this.cube.quaternion.copy(_q).multiply(w.cubeQuat0);
    }
  }

  private onPinchEnd(source: PinchSource): void {
    if (this.layerSource === source && this.layerGrab !== null) {
      this.cube.endLiveTurn(); // no-op when no live turn was started
      this.layerGrab = null;
      this.layerSource = null;
    }
    if (this.wholeSource === source && this.wholeGrab !== null) {
      this.wholeGrab = null;
      this.wholeSource = null;
    }
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
