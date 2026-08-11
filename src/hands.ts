import * as THREE from 'three';
import type { AxisIndex } from './cube';

// ---------------------------------------------------------------------------
// Pinch sources.
//
// A "PinchSource" is anything that can grab: a tracked hand (HandRig below) or
// a controller (ControllerSource in controllers.ts). Each exposes a world-space
// grab point/orientation and start/move/end callbacks; XRControls consumes the
// common interface, so hands and controllers drive identical interactions.
// ---------------------------------------------------------------------------

export interface PinchSource {
  /** Identity used by XRControls to match move/end events to a grab. */
  id: unknown;
  /** World-space grab point (hand: thumb+index midpoint; controller: tip). */
  pinchPoint: THREE.Vector3;
  /** World-space "hand"/grip position (used for whole-cube attachment). */
  palmPos: THREE.Vector3;
  /** World-space "hand"/grip orientation. */
  palmQuat: THREE.Quaternion;
  /**
   * If present, called at pinch start to pick an exact slice via a ray
   * (controller laser). Returns null when the ray misses the cube.
   */
  pickSlice?: () => { axis: AxisIndex; layer: number } | null;
  // "layer" channel — index-finger pinch (hands) or trigger (controllers)
  onPinchStart: (() => void) | null;
  onPinchMove: (() => void) | null;
  onPinchEnd: (() => void) | null;
  // "whole-cube" channel — middle-finger pinch (hands) or grip button (controllers)
  onGrabStart: (() => void) | null;
  onGrabMove: (() => void) | null;
  onGrabEnd: (() => void) | null;
}

// ---------------------------------------------------------------------------
// Hand tracking.
//
// three.js's WebXRManager exposes each tracked hand as a Group
// (`renderer.xr.getHand(index)`). When an XR input source with a `hand` appears,
// three adds the XRHand joints as children of that group and updates their
// transforms every frame; the group also dispatches `connected` events. We
// build a lightweight procedural rig on top: a sphere at every joint plus thin
// cylinders between finger bones — the hand-visualisation exception in the
// asset policy (no imported models).
//
// Pinch detection uses thumb-tip <-> index-tip distance with hysteresis so a
// real "touch" feels forgiving: grab engages under ~3.5 cm, releases over
// ~5.5 cm.
// ---------------------------------------------------------------------------

const FINGER_CHAINS: string[][] = [
  ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ['index-metacarpal', 'index-phalanx-proximal', 'index-phalanx-intermediate', 'index-phalanx-distal', 'index-tip'],
  ['middle-metacarpal', 'middle-phalanx-proximal', 'middle-phalanx-intermediate', 'middle-phalanx-distal', 'middle-tip'],
  ['ring-metacarpal', 'ring-phalanx-proximal', 'ring-phalanx-intermediate', 'ring-phalanx-distal', 'ring-tip'],
  ['pinky-metacarpal', 'pinky-phalanx-proximal', 'pinky-phalanx-intermediate', 'pinky-phalanx-distal', 'pinky-tip'],
];

const PINCH_START = 0.035; // metres — engage grab below this distance
const PINCH_END = 0.055; // metres — release grab above this distance
const _vY = new THREE.Vector3(0, 1, 0);

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class HandRig implements PinchSource {
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

  readonly hand: THREE.Group;
  /** Index-finger pinch (thumb↔index) — grabs a layer to turn. */
  pinching = false;
  /** Middle-finger pinch (thumb↔middle) — grabs the whole cube. */
  grabbing = false;
  pinchDistance = Infinity;
  grabDistance = Infinity;

  private joints = new Map<string, THREE.Object3D>();
  private spheres = new Map<string, THREE.Mesh>();
  private bones: THREE.Mesh[] = [];

  private readonly sphereGeo = new THREE.SphereGeometry(1, 10, 8);
  private readonly boneGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  private readonly skinMat = new THREE.MeshStandardMaterial({ color: 0xd9a38f, roughness: 0.85, metalness: 0.0 });
  private readonly boneMat = new THREE.MeshStandardMaterial({ color: 0x9c7263, roughness: 0.9, metalness: 0.0 });
  private readonly tipMat = new THREE.MeshStandardMaterial({
    color: 0xf2c1b0,
    roughness: 0.55,
    metalness: 0.0,
    emissive: 0x331a00,
  });

  private wrist: THREE.Object3D | null = null;
  private thumbTip: THREE.Object3D | null = null;
  private indexTip: THREE.Object3D | null = null;
  private middleTip: THREE.Object3D | null = null;

  constructor(hand: THREE.Group) {
    this.hand = hand;
    // three dispatches a 'connected' event on the hand group when an XR input
    // source with hand data appears; the EventMap type doesn't know about it.
    (hand as unknown as THREE.EventDispatcher<Record<string, unknown>>).addEventListener('connected', () => this.refresh());
    this.refresh();
  }

  /** (Re)build the visual rig from the joints currently attached to the hand. */
  refresh(): void {
    for (const m of this.spheres.values()) this.hand.remove(m);
    for (const b of this.bones) this.hand.remove(b);
    this.joints.clear();
    this.spheres.clear();
    this.bones = [];

    for (const child of this.hand.children) {
      const joint = child as THREE.Object3D;
      if (joint.name === '') continue;
      this.joints.set(joint.name, joint);
      const sphere = new THREE.Mesh(this.sphereGeo, this.skinMat);
      this.spheres.set(joint.name, sphere);
      this.hand.add(sphere);
    }

    for (const tip of ['thumb-tip', 'index-tip']) {
      const s = this.spheres.get(tip);
      if (s) s.material = this.tipMat;
    }

    for (const chain of FINGER_CHAINS) {
      for (let i = 0; i < chain.length - 1; i++) {
        const bone = new THREE.Mesh(this.boneGeo, this.boneMat);
        bone.visible = false;
        this.bones.push(bone);
        this.hand.add(bone);
      }
    }

    this.wrist = this.joints.get('wrist') ?? null;
    this.thumbTip = this.joints.get('thumb-tip') ?? null;
    this.indexTip = this.joints.get('index-tip') ?? null;
    this.middleTip = this.joints.get('middle-tip') ?? null;
  }

  /** Call every frame while an XR session is active. */
  update(): void {
    if (!this.hand.visible) return;

    for (const [name, joint] of this.joints) {
      const sphere = this.spheres.get(name);
      if (sphere === undefined) continue;
      if (!joint.visible) {
        sphere.visible = false;
        continue;
      }
      sphere.visible = true;
      joint.getWorldPosition(sphere.position);
      const radius = (joint as THREE.Object3D & { jointRadius?: number }).jointRadius ?? 0.012;
      sphere.scale.setScalar(Math.max(0.007, Math.min(0.024, radius * 1.25)));
    }

    let boneIndex = 0;
    for (const chain of FINGER_CHAINS) {
      for (let i = 0; i < chain.length - 1; i++) {
        const bone = this.bones[boneIndex++];
        const j0 = this.joints.get(chain[i]);
        const j1 = this.joints.get(chain[i + 1]);
        if (bone === undefined || j0 === undefined || j1 === undefined) continue;
        if (!j0.visible || !j1.visible) {
          bone.visible = false;
          continue;
        }
        j0.getWorldPosition(_a);
        j1.getWorldPosition(_b);
        const len = _a.distanceTo(_b);
        if (len < 0.001) {
          bone.visible = false;
          continue;
        }
        _mid.copy(_a).add(_b).multiplyScalar(0.5);
        _dir.copy(_b).sub(_a).normalize();
        _q.setFromUnitVectors(_vY, _dir);
        bone.visible = true;
        bone.position.copy(_mid);
        bone.quaternion.copy(_q);
        const taper = 0.006 + 0.0045 * Math.max(0, 1 - i / (chain.length - 1));
        bone.scale.set(len, taper, taper);
      }
    }

    const thumb = this.thumbTip;
    const index = this.indexTip;
    const middle = this.middleTip;

    // index pinch (layer grab): thumb↔index
    if (thumb !== null && index !== null && thumb.visible && index.visible) {
      thumb.getWorldPosition(_a);
      index.getWorldPosition(_b);
      this.pinchDistance = _a.distanceTo(_b);
      this.pinchPoint.copy(_a).add(_b).multiplyScalar(0.5);
    } else {
      this.pinchDistance = Infinity;
    }

    // middle pinch (whole-cube grab): thumb↔middle
    if (thumb !== null && middle !== null && thumb.visible && middle.visible) {
      thumb.getWorldPosition(_a);
      middle.getWorldPosition(_b);
      this.grabDistance = _a.distanceTo(_b);
    } else {
      this.grabDistance = Infinity;
    }

    if (this.wrist !== null && this.wrist.visible) {
      this.wrist.getWorldPosition(this.palmPos);
      this.wrist.getWorldQuaternion(this.palmQuat);
    }

    if (this.pinching && this.pinchDistance > PINCH_END) {
      this.pinching = false;
      this.onPinchEnd?.();
    } else if (!this.pinching && this.pinchDistance < PINCH_START) {
      this.pinching = true;
      this.onPinchStart?.();
    } else if (this.pinching) {
      this.onPinchMove?.();
    }

    if (this.grabbing && this.grabDistance > PINCH_END) {
      this.grabbing = false;
      this.onGrabEnd?.();
    } else if (!this.grabbing && this.grabDistance < PINCH_START) {
      this.grabbing = true;
      this.onGrabStart?.();
    } else if (this.grabbing) {
      this.onGrabMove?.();
    }

    const glow = this.pinching || this.grabbing ? 0.6 : 0.0;
    this.tipMat.emissiveIntensity = glow;
  }
}
