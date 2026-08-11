import * as THREE from 'three';
import { RubiksCube, CUBIE_SIZE, pickTurnAxis, type AxisIndex } from './cube';
import type { PinchSource } from './hands';

// ---------------------------------------------------------------------------
// VR grab interactions (shared by hand tracking and Quest controllers).
//
// LAYER TURN — index-finger pinch (hands) on a face, or aim + trigger
// (controllers). The slice axis is chosen from the DIRECTION of the grab
// point's motion: the axis whose rotation best follows the drag (see
// pickTurnAxis), so grabbing any cubie and dragging in any direction turns the
// matching layer (drag left↔right → around the vertical axis, etc.).
//
// WHOLE-CUBE — middle-finger pinch (hands) near the cube, or grip (controllers)
// while pointing at the cube. Controllers must then make a "pull" gesture
// (yank the controller back away from the cube) to trigger the gravity pull;
// the cube flies to a hold point in front of the controller (Half-Life: Alyx
// style), locks on, follows the hand rigidly, then floats where released.
//
// Only one interaction is active at a time.
// ---------------------------------------------------------------------------

const GRAB_RADIUS = 0.055; // metres around a pinch point that counts as "touching a cubie"
const HAND_REACH = 0.6; // hands: middle pinch must be within this of the cube centre to grab
const HOLD_DIST = 0.12; // gravity pull locks on when the cube centre is this close to the hold point
const PULL_SPEED = 10; // per-second ease rate of the gravity pull
const PULL_TRIGGER = 0.06; // metres the controller must be yanked back before the pull starts

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _center = new THREE.Vector3();
const _d = new THREE.Vector3();
const _hold = new THREE.Vector3();

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
  cubiePosLocal: THREE.Vector3; // grabbed cubie's cube-local position
  basePoint: THREE.Vector3; // world grab point at grab start
  axis: AxisIndex | null;
  layer: number | null;
  baseAngle: number[]; // per-axis angle at grab start
  liveStarted: boolean;
}

interface WholeGrab {
  handPos0: THREE.Vector3;
  handQuat0: THREE.Quaternion;
  cubePos0: THREE.Vector3;
  cubeQuat0: THREE.Quaternion;
  pulling: boolean; // true while the cube flies to the hand (gravity pull)
  armed: boolean; // controllers: waiting for the "pull" gesture
  armedPoint: THREE.Vector3; // tip position when the grip was armed
}

export class XRControls {
  private layerGrab: LayerGrab | null = null;
  private layerSource: PinchSource | null = null;
  private wholeGrab: WholeGrab | null = null;
  private wholeSource: PinchSource | null = null;
  private _dt = 0.016;

  constructor(private cube: RubiksCube) {}

  /** Call every frame with the frame delta; used by the gravity pull easing. */
  update(dt: number): void {
    this._dt = dt;
  }

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

    let cubie: { logical: THREE.Vector3 } | null = null;

    if (source.pickCubie) {
      // controller: the cubie under the laser
      cubie = source.pickCubie();
      if (cubie === null) return;
    } else {
      // hand: cubies near the index pinch
      this.cube.updateMatrixWorld(true);
      const found = this.cube.cubieAt(source.pinchPoint, GRAB_RADIUS);
      if (found.length === 0) return;

      const common = [new Set<number>(), new Set<number>(), new Set<number>()];
      for (const c of found) {
        for (let a = 0; a < 3; a++) common[a].add(c.logical.getComponent(a));
      }
      let candidates: AxisIndex[] = [];
      for (let a = 0; a < 3; a++) {
        if (common[a].size === 1) candidates.push(a as AxisIndex);
      }
      if (candidates.length === 0) {
        // grabbed cubies span several slices — use the closest one
        let closest = found[0];
        let bestD = Infinity;
        for (const c of found) {
          const dd = source.pinchPoint.distanceTo(c.logical.clone().multiplyScalar(CUBIE_SIZE));
          if (dd < bestD) {
            bestD = dd;
            closest = c;
          }
        }
        found.length = 0;
        found.push(closest);
      }
      cubie = found[0];
    }

    const local = this.cube.worldToLocal(source.pinchPoint.clone());
    const baseAngle = [0, 0, 0];
    for (let a = 0; a < 3; a++) baseAngle[a] = angleAround(local, a as AxisIndex);

    this.layerGrab = {
      cubies: [cubie],
      cubiePosLocal: cubie.logical.clone().multiplyScalar(CUBIE_SIZE),
      basePoint: source.pinchPoint.clone(),
      axis: null,
      layer: null,
      baseAngle,
      liveStarted: false,
    };
    this.layerSource = source;
  }

  private onPinchMove(source: PinchSource): void {
    if (this.layerSource !== source || this.layerGrab === null) return;
    const g = this.layerGrab;
    const local = this.cube.worldToLocal(source.pinchPoint.clone());

    if (!g.liveStarted) {
      // choose the axis whose rotation best follows the drag direction
      _d.copy(source.pinchPoint).sub(g.basePoint); // world drag
      this.cube.getWorldQuaternion(_q2).invert();
      _d.applyQuaternion(_q2); // → cube-local
      const axis = pickTurnAxis(g.cubiePosLocal, _d);
      if (axis !== null) this.beginLayerTurn(axis);
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
    if (g === null || g.liveStarted || g.cubies.length === 0) return;
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

    // must actually be pointing at / reaching for the cube — no accidental grabs
    this.cube.updateMatrixWorld(true);
    this.cube.getWorldPosition(_center);
    let canGrab: boolean;
    if (source.pickCubie) {
      canGrab = source.pickCubie() !== null || (source.nearCube ?? false);
    } else {
      canGrab = source.pinchPoint.distanceTo(_center) <= HAND_REACH;
    }
    if (!canGrab) return;

    this.cube.getWorldPosition(_center);
    const distToHand = source.palmPos.distanceTo(_center);

    // Controllers: holding grip on the cube only "arms" the grab — the gravity
    // pull needs an explicit pull gesture. Hands: a middle pinch grabs directly.
    const isController = source.pickCubie !== undefined;
    const withinHold = distToHand <= HOLD_DIST;
    const pulling = !isController && !withinHold;

    this.wholeGrab = {
      handPos0: source.palmPos.clone(),
      handQuat0: source.palmQuat.clone(),
      cubePos0: this.cube.getWorldPosition(new THREE.Vector3()),
      cubeQuat0: this.cube.getWorldQuaternion(new THREE.Quaternion()),
      pulling,
      armed: isController && !withinHold,
      armedPoint: source.pinchPoint.clone(),
    };
    this.wholeSource = source;
  }

  private onGrabMove(source: PinchSource): void {
    if (this.wholeSource !== source || this.wholeGrab === null) return;
    const w = this.wholeGrab;

    if (w.armed) {
      // cube stays put until the player yanks the controller back (away from
      // the cube) — only then does the gravity pull start
      this.cube.getWorldPosition(_center);
      const d0 = w.armedPoint.distanceTo(_center);
      const d1 = source.pinchPoint.distanceTo(_center);
      if (d1 - d0 > PULL_TRIGGER) {
        w.armed = false;
        w.pulling = true;
      }
      return;
    }

    if (w.pulling) {
      // gravity pull toward the hold point in front of the hand/controller
      if (source.getHoldPoint) source.getHoldPoint(_hold);
      else _hold.copy(source.palmPos);
      const step = Math.min(1, this._dt * PULL_SPEED);
      this.cube.position.lerp(_hold, step);
      this.cube.quaternion.slerp(source.palmQuat, step);
      if (this.cube.position.distanceTo(_hold) < HOLD_DIST) {
        // locked on → rigid attachment from here
        w.pulling = false;
        w.armed = false;
        w.handPos0.copy(source.palmPos);
        w.handQuat0.copy(source.palmQuat);
        w.cubePos0.copy(this.cube.position);
        w.cubeQuat0.copy(this.cube.quaternion);
      }
      return;
    }

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
}
