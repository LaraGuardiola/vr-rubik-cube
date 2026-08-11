import * as THREE from 'three';
import { RubiksCube, type Cubie } from './cube';
import type { PinchSource } from './hands';

// ---------------------------------------------------------------------------
// Quest (Touch) controller support.
//
// A ControllerSource drives the same grab logic as a hand (PinchSource):
//  * TRIGGER (select)  → "layer" channel: aim at a face, pull the trigger; the
//    slice under the laser turns as you orbit the controller, snapping to 90°
//    on release. If the beam misses the cube, nothing happens.
//  * GRIP (squeeze)    → "whole-cube" channel: grab/move/rotate the whole cube.
// The controller is rendered as a small procedural body + laser beam (no
// imported models). The beam stops at the cube surface when it points at it,
// and the targeted cubie (or the whole cube when close) glows blue as a
// "hitbox" hint.
// ---------------------------------------------------------------------------

const RAY_LENGTH = 1.0; // beam length when it doesn't hit the cube
const BODY_LEN = 0.16;
const BODY_R = 0.02;
const TIP_R = 0.022;
const PROXIMITY = 0.25; // tip-to-cube-centre distance that turns on the whole-cube glow
const HOLD_FORWARD = 0.1; // where a gravity-pulled cube comes to rest, in front of the tip
const AIM_CONE = 0.45; // how close the laser line must pass to the cube centre to count as "aiming"

const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _center = new THREE.Vector3();
const _perp = new THREE.Vector3();

interface SlicePick {
  cubie: Cubie;
  distance: number;
}

export class ControllerSource implements PinchSource {
  readonly id: unknown = this;
  readonly pinchPoint = new THREE.Vector3();
  readonly palmPos = new THREE.Vector3();
  readonly palmQuat = new THREE.Quaternion();
  onPinchStart: (() => void) | null = null;
  onPinchMove: (() => void) | null = null;
  onPinchEnd: (() => void) | null = null;
  onGrabStart: (() => void) | null = null;
  onGrabMove: (() => void) | null = null;
  onGrabEnd: (() => void) | null = null;

  readonly grip: THREE.Group;
  readonly ray: THREE.Group;

  /** Cubie currently under the laser beam (for the blue hitbox hint). */
  beamCubie: Cubie | null = null;
  /** True when the controller tip is close enough to the cube to grab it. */
  nearCube = false;
  /** True when the laser line passes near the cube (works from far away). */
  aimingAtCube = false;

  pinching = false;
  grabbing = false;
  private readonly raycaster = new THREE.Raycaster();
  private beam: THREE.Mesh;
  private inputSource: XRInputSource | null = null;
  private menuDown = false;
  private stickX = 0;
  private stickY = 0;

  constructor(grip: THREE.Group, ray: THREE.Group, private cube: RubiksCube) {
    this.grip = grip;
    this.ray = ray;

    const gripEvents = grip as unknown as THREE.EventDispatcher<Record<string, unknown>>;
    gripEvents.addEventListener('selectstart', () => this.setTrigger(true));
    gripEvents.addEventListener('selectend', () => this.setTrigger(false));
    gripEvents.addEventListener('squeezestart', () => this.setSqueeze(true));
    gripEvents.addEventListener('squeezeend', () => this.setSqueeze(false));
    gripEvents.addEventListener('connected', (e) => {
      this.inputSource = (e as unknown as { data?: XRInputSource }).data ?? null;
    });

    // --- procedural controller visual --------------------------------------
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2d35, roughness: 0.35, metalness: 0.6 });
    const tipMat = new THREE.MeshStandardMaterial({ color: 0x8f7ff0, emissive: 0x3a2a8a, roughness: 0.3 });
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

  pickCubie = (): Cubie | null => this.pickSliceFromRay()?.cubie ?? null;

  /** True while the trigger (select) is held down. */
  get selectPressed(): boolean {
    return this.pinching;
  }

  /** True while the ☰ menu button is held down (read from the gamepad). */
  get menuPressed(): boolean {
    return this.menuDown;
  }

  /** Thumbstick deflection, -1..1 (x: left/right, y: up/down). */
  get thumbstick(): { x: number; y: number } {
    return { x: this.stickX, y: this.stickY };
  }

  /** Raycast the laser against arbitrary scene objects (used for the VR menu). */
  castBeam(objects: THREE.Object3D[]): THREE.Intersection | null {
    this.ray.updateMatrixWorld(true);
    this.pinchPoint.setFromMatrixPosition(this.ray.matrixWorld);
    _dir.set(0, 0, -1).applyQuaternion(this.ray.getWorldQuaternion(_q));
    this.raycaster.set(this.pinchPoint, _dir);
    const hits = this.raycaster.intersectObjects(objects, false);
    return hits.length > 0 ? hits[0] : null;
  }

  /** World point the gravity-pulled cube flies to (a bit in front of the tip). */
  getHoldPoint(out: THREE.Vector3): void {
    this.ray.updateMatrixWorld(true);
    this.pinchPoint.setFromMatrixPosition(this.ray.matrixWorld);
    _dir.set(0, 0, -1).applyQuaternion(this.ray.getWorldQuaternion(_q));
    out.copy(this.pinchPoint).addScaledVector(_dir, HOLD_FORWARD);
  }

  /** Call every frame while an XR session is active. */
  update(): void {
    this.grip.getWorldPosition(this.palmPos);
    this.grip.getWorldQuaternion(this.palmQuat);
    this.ray.getWorldPosition(this.pinchPoint);
    this.menuDown = this.readMenuButton();

    const axes = this.inputSource?.gamepad?.axes;
    this.stickX = axes && axes.length > 0 ? axes[0] : 0;
    this.stickY = axes && axes.length > 1 ? axes[1] : 0;

    const pick = this.pickSliceFromRay();
    this.beamCubie = pick ? pick.cubie : null;

    // "aiming at the cube" = close enough, or the laser line passes near it
    this.cube.updateMatrixWorld(true);
    this.cube.getWorldPosition(_center);
    _dir.set(0, 0, -1).applyQuaternion(this.ray.getWorldQuaternion(_q));
    _perp.subVectors(this.pinchPoint, _center).cross(_dir);
    const perpDist = _perp.length();
    this.nearCube = this.pinchPoint.distanceTo(_center) < PROXIMITY;
    this.aimingAtCube = this.pinchPoint.distanceTo(_center) < 1.0 || perpDist < AIM_CONE;

    // beam length: stop at the cube surface when pointing at it
    const tracked = this.ray.visible || this.grip.visible;
    this.beam.visible = tracked;
    if (tracked) {
      const len = pick ? Math.max(0.05, Math.min(pick.distance, RAY_LENGTH)) : RAY_LENGTH;
      this.beam.scale.set(1, 1, len);
      this.beam.position.z = -len / 2;
    }

    // WebXR only fires start/end events for select/squeeze (no stream while
    // held), so we poll the "move" callbacks every frame while a button is down.
    if (this.pinching) this.onPinchMove?.();
    if (this.grabbing) this.onGrabMove?.();

    // safety: if tracking is lost mid-grab, release cleanly
    if (!tracked) {
      if (this.pinching) {
        this.pinching = false;
        this.onPinchEnd?.();
      }
      if (this.grabbing) {
        this.grabbing = false;
        this.onGrabEnd?.();
      }
    }
  }

  private setTrigger(v: boolean): void {
    if (v && !this.pinching) {
      this.pinching = true;
      this.onPinchStart?.();
    } else if (!v && this.pinching) {
      this.pinching = false;
      this.onPinchEnd?.();
    } else if (v) {
      this.onPinchMove?.();
    }
  }

  private setSqueeze(v: boolean): void {
    if (v && !this.grabbing) {
      this.grabbing = true;
      this.onGrabStart?.();
    } else if (!v && this.grabbing) {
      this.grabbing = false;
      this.onGrabEnd?.();
    } else if (v) {
      this.onGrabMove?.();
    }
  }

  /** Look for the ☰ menu button in the input source's gamepad. */
  private readMenuButton(): boolean {
    const gp = this.inputSource?.gamepad;
    if (!gp || !gp.buttons) return false;
    for (const b of gp.buttons) {
      const id = (b as unknown as { id?: string }).id;
      if (id && /menu/i.test(id)) return !!b.pressed;
    }
    // fallback: on many Touch layouts the menu button is the last one
    const last = gp.buttons[gp.buttons.length - 1];
    return last ? !!last.pressed : false;
  }

  private pickSliceFromRay(): SlicePick | null {
    this.ray.updateMatrixWorld(true);
    this.pinchPoint.setFromMatrixPosition(this.ray.matrixWorld);
    _dir.set(0, 0, -1).applyQuaternion(this.ray.getWorldQuaternion(_q));
    this.raycaster.set(this.pinchPoint, _dir);
    const targets = this.cube.cubies.map((c) => c.mesh);
    const hits = this.raycaster.intersectObjects(targets, true);
    if (hits.length === 0) return null;
    const hit = hits[0];
    const cubieMesh = (hit.object as THREE.Mesh).parent as THREE.Group;
    const cubie = this.cube.cubies.find((c) => c.mesh === cubieMesh);
    if (!cubie) return null;
    return { cubie, distance: hit.distance };
  }
}
