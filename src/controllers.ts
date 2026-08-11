import * as THREE from 'three';
import { RubiksCube, type AxisIndex } from './cube';
import type { PinchSource } from './hands';

// ---------------------------------------------------------------------------
// Quest (Touch) controller support.
//
// A ControllerSource drives the same grab logic as a hand (PinchSource):
//  * TRIGGER (select)  → aim at a face, pull the trigger: the slice under the
//    laser turns as you orbit the controller, snapping to 90° on release.
//    If the laser misses the cube, the trigger grabs the whole cube instead.
//  * GRIP (squeeze)    → always grab/move/rotate the whole cube.
// The controller is rendered as a small procedural body + laser beam (no
// imported models). The beam stops at the cube surface when it points at it.
// ---------------------------------------------------------------------------

const RAY_LENGTH = 1.6; // beam length when it doesn't hit the cube
const BODY_LEN = 0.16;
const BODY_R = 0.02;
const TIP_R = 0.022;

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _normal = new THREE.Vector3();

export class ControllerSource implements PinchSource {
  readonly id: unknown = this;
  readonly pinchPoint = new THREE.Vector3();
  readonly palmPos = new THREE.Vector3();
  readonly palmQuat = new THREE.Quaternion();
  readonly wholeGrabDistance = 1.6; // controllers can grab from arm's length
  onPinchStart: (() => void) | null = null;
  onPinchMove: (() => void) | null = null;
  onPinchEnd: (() => void) | null = null;

  readonly grip: THREE.Group;
  readonly ray: THREE.Group;

  private trigger = false;
  private squeeze = false;
  pinching = false;
  private readonly raycaster = new THREE.Raycaster();
  private beam: THREE.Mesh;

  constructor(grip: THREE.Group, ray: THREE.Group, private cube: RubiksCube) {
    this.grip = grip;
    this.ray = ray;

    const gripEvents = grip as unknown as THREE.EventDispatcher<Record<string, unknown>>;
    gripEvents.addEventListener('selectstart', () => this.setTrigger(true));
    gripEvents.addEventListener('selectend', () => this.setTrigger(false));
    gripEvents.addEventListener('squeezestart', () => this.setSqueeze(true));
    gripEvents.addEventListener('squeezeend', () => this.setSqueeze(false));

    // --- procedural controller visual --------------------------------------
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2d35, roughness: 0.35, metalness: 0.6 });
    const tipMat = new THREE.MeshStandardMaterial({
      color: 0x8f7ff0,
      emissive: 0x3a2a8a,
      roughness: 0.3,
    });
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x8f7ff0,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const body = new THREE.Mesh(new THREE.CylinderGeometry(BODY_R, BODY_R * 1.5, BODY_LEN, 12), bodyMat);
    body.rotation.x = Math.PI / 2; // cylinder height points along the ray's -Z (forward)
    body.position.z = 0.04;
    grip.add(body);

    const tip = new THREE.Mesh(new THREE.SphereGeometry(TIP_R, 12, 10), tipMat);
    tip.position.z = -0.07;
    grip.add(tip);

    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 1, 6, 1, true), beamMat);
    this.beam.rotation.x = Math.PI / 2;
    this.beam.position.z = -RAY_LENGTH / 2;
    this.beam.scale.set(1, 1, RAY_LENGTH);
    ray.add(this.beam);
  }

  get preferWholeGrab(): boolean {
    return this.squeeze;
  }

  pickSlice = (): { axis: AxisIndex; layer: number } | null => {
    const pick = this.pickSliceFromRay();
    return pick ? { axis: pick.axis, layer: pick.layer } : null;
  };

  /** Call every frame while an XR session is active. */
  update(): void {
    this.grip.getWorldPosition(this.palmPos);
    this.grip.getWorldQuaternion(this.palmQuat);
    this.ray.getWorldPosition(this.pinchPoint);

    // beam length: stop at the cube surface when pointing at it
    const tracked = this.ray.visible || this.grip.visible;
    this.beam.visible = tracked;
    if (tracked) {
      const pick = this.pickSliceFromRay();
      const len = pick ? Math.max(0.05, Math.min(pick.distance, RAY_LENGTH)) : RAY_LENGTH;
      this.beam.scale.set(1, 1, len);
      this.beam.position.z = -len / 2;
    }
  }

  private setTrigger(v: boolean): void {
    this.trigger = v;
    this.evalState();
  }

  private setSqueeze(v: boolean): void {
    this.squeeze = v;
    this.evalState();
  }

  private evalState(): void {
    const pinching = this.trigger || this.squeeze;
    if (pinching && !this.pinching) {
      this.pinching = true;
      this.onPinchStart?.();
    } else if (!pinching && this.pinching) {
      this.pinching = false;
      this.onPinchEnd?.();
    } else if (pinching) {
      this.onPinchMove?.();
    }
  }

  private pickSliceFromRay(): { axis: AxisIndex; layer: number; distance: number } | null {
    this.ray.updateMatrixWorld(true);
    this.pinchPoint.setFromMatrixPosition(this.ray.matrixWorld);
    _dir.set(0, 0, -1).applyQuaternion(this.ray.getWorldQuaternion(_q));
    this.raycaster.set(this.pinchPoint, _dir);
    const targets = this.cube.cubies.map((c) => c.mesh);
    const hits = this.raycaster.intersectObjects(targets, true);
    if (hits.length === 0) return null;
    const hit = hits[0];
    const face = hit.face;
    if (!face) return null;
    const cubieMesh = (hit.object as THREE.Mesh).parent as THREE.Group;
    const cubie = this.cube.cubies.find((c) => c.mesh === cubieMesh);
    if (!cubie) return null;

    // face normal → cube-local axis
    _normal.copy(face.normal).transformDirection((hit.object as THREE.Mesh).matrixWorld);
    _normal.applyQuaternion(this.cube.getWorldQuaternion(_q2).invert());
    let axis: AxisIndex = 0;
    let best = -1;
    for (const a of [0, 1, 2] as AxisIndex[]) {
      const v = Math.abs(_normal.getComponent(a));
      if (v > best) {
        best = v;
        axis = a;
      }
    }
    const layer = cubie.logical.getComponent(axis);
    return { axis, layer, distance: hit.distance };
  }
}
