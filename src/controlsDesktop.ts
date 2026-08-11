import * as THREE from 'three';
import { RubiksCube, type AxisIndex } from './cube';

// ---------------------------------------------------------------------------
// Desktop (mouse/touch) controls.
//
//  * Drag on a cube face   → turns the layer under that face. The slice axis is
//    the face normal; the pointer's orbit around it drives the live angle,
//    multiplied by TURN_GAIN so even a short drag feels responsive. On release
//    the layer snaps to the nearest 90deg step.
//  * Drag on empty space   → orbits the camera around the cube (inspect).
//    (Shift+drag on the cube also orbits.)
//  * Wheel / pinch         → zoom.
//
// The camera orbits the cube's world position, so the cube group itself stays
// axis-aligned in world space until the player drags it around in VR.
// ---------------------------------------------------------------------------

const TURN_SPHERE_RADIUS = 0.26; // metres — sphere used to track pointer angle during a turn
const TURN_GAIN = 7; // scales pointer orbit to turn angle so short drags turn the layer
const ORBIT_SENSITIVITY = 0.008;
const MIN_RADIUS = 0.7;
const MAX_RADIUS = 6;

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function angleAround(p: THREE.Vector3, axis: AxisIndex): number {
  return Math.atan2(p.getComponent(((axis + 2) % 3) as AxisIndex), p.getComponent(((axis + 1) % 3) as AxisIndex));
}

interface DragState {
  mode: 'turn' | 'orbit';
  axis: AxisIndex;
  layer: number;
  baseAngle: number;
  lastX: number;
  lastY: number;
}

export class DesktopControls {
  enabled = true;

  private orbitTheta = 0;
  private orbitPhi = 0.29;
  private orbitRadius = 2.0;

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private drag: DragState | null = null;
  private activePointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;

  private readonly _target = new THREE.Vector3();

  constructor(
    private dom: HTMLElement,
    private camera: THREE.PerspectiveCamera,
    private cube: RubiksCube,
  ) {
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('dblclick', (e) => e.preventDefault());
  }

  /** Reposition the camera around the cube (called every frame). */
  update(): void {
    if (!this.enabled) return;
    this.cube.getWorldPosition(this._target);
    const c = this.camera.position;
    const r = this.orbitRadius;
    c.set(
      this._target.x + r * Math.cos(this.orbitPhi) * Math.sin(this.orbitTheta),
      this._target.y + r * Math.sin(this.orbitPhi),
      this._target.z + r * Math.cos(this.orbitPhi) * Math.cos(this.orbitTheta),
    );
    this.camera.lookAt(this._target);
  }

  setEnabled(b: boolean): void {
    this.enabled = b;
    if (!b) this.drag = null;
  }

  resetView(): void {
    this.orbitTheta = 0;
    this.orbitPhi = 0.29;
    this.orbitRadius = 2.0;
  }

  // ------------------------------------------------------------- event wiring

  private setPointerFromEvent(e: PointerEvent): void {
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private raycastCube(): THREE.Intersection | null {
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const targets: THREE.Object3D[] = [];
    for (const c of this.cube.cubies) targets.push(c.mesh);
    const hits = this.raycaster.intersectObjects(targets, true);
    return hits.length > 0 ? hits[0] : null;
  }

  /** Ray-sphere intersection; returns t (along ray) or -1. */
  private raySphereT(center: THREE.Vector3, radius: number): number {
    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;
    const oc = new THREE.Vector3().subVectors(o, center);
    const b = oc.dot(d);
    const c = oc.dot(oc) - radius * radius;
    const disc = b * b - c;
    if (disc < 0) return -1;
    const t = -b - Math.sqrt(disc);
    return t >= 0 ? t : -1;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.activePointers.size === 2) {
      // two fingers → pinch zoom; cancel any in-progress turn
      if (this.drag?.mode === 'turn') this.cube.endLiveTurn();
      this.drag = null;
      const pts = [...this.activePointers.values()];
      this.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      return;
    }

    this.setPointerFromEvent(e);
    const hit = this.raycastCube();
    const wantsOrbit = e.shiftKey || hit === null;

    if (wantsOrbit) {
      this.drag = { mode: 'orbit', axis: 0, layer: 0, baseAngle: 0, lastX: e.clientX, lastY: e.clientY };
      return;
    }

    // start a slice turn — axis = the clicked face's normal
    const cubieMesh = (hit!.object as THREE.Mesh).parent as THREE.Group;
    const cubieObj = this.cube.cubies.find((c) => c.mesh === cubieMesh);
    if (cubieObj === undefined) return;
    const face = hit!.face;
    if (!face) return;

    const worldNormal = face.normal.clone().transformDirection((hit!.object as THREE.Mesh).matrixWorld);
    const cubeQuatInv = this.cube.getWorldQuaternion(new THREE.Quaternion()).invert();
    const localNormal = worldNormal.applyQuaternion(cubeQuatInv);

    let axis: AxisIndex = 0;
    let best = -1;
    for (const a of [0, 1, 2] as AxisIndex[]) {
      const v = Math.abs(localNormal.getComponent(a));
      if (v > best) {
        best = v;
        axis = a;
      }
    }
    const layer = cubieObj.logical.getComponent(axis);
    if (!this.cube.beginLiveTurn(axis, layer)) return;

    // base angle from the tracking sphere point (ray already set by raycastCube)
    const center = this.cube.getWorldPosition(new THREE.Vector3());
    const t = this.raySphereT(center, TURN_SPHERE_RADIUS);
    let local: THREE.Vector3;
    if (t >= 0) {
      local = this.cube.worldToLocal(
        this.raycaster.ray.origin.clone().addScaledVector(this.raycaster.ray.direction, t),
      );
    } else {
      local = this.cube.worldToLocal(hit!.point.clone());
    }
    this.drag = {
      mode: 'turn',
      axis,
      layer,
      baseAngle: angleAround(local, axis),
      lastX: e.clientX,
      lastY: e.clientY,
    };
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled || this.drag === null) return;
    const prev = this.activePointers.get(e.pointerId);
    if (prev) {
      prev.x = e.clientX;
      prev.y = e.clientY;
    }

    if (this.activePointers.size >= 2) {
      const pts = [...this.activePointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.pinchDist > 0 && dist > 0) {
        this.orbitRadius = THREE.MathUtils.clamp(this.orbitRadius * (this.pinchDist / dist), MIN_RADIUS, MAX_RADIUS);
      }
      this.pinchDist = dist;
      return;
    }

    const dx = e.clientX - this.drag.lastX;
    const dy = e.clientY - this.drag.lastY;
    this.drag.lastX = e.clientX;
    this.drag.lastY = e.clientY;

    if (this.drag.mode === 'orbit') {
      this.orbitTheta -= dx * ORBIT_SENSITIVITY;
      this.orbitPhi = THREE.MathUtils.clamp(this.orbitPhi + dy * ORBIT_SENSITIVITY, -1.4, 1.4);
      return;
    }

    // turn: track the pointer against a sphere around the cube centre
    this.setPointerFromEvent(e);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const center = this.cube.getWorldPosition(new THREE.Vector3());
    const t = this.raySphereT(center, TURN_SPHERE_RADIUS);
    if (t < 0) return;
    const world = this.raycaster.ray.origin.clone().addScaledVector(this.raycaster.ray.direction, t);
    const local = this.cube.worldToLocal(world);
    const angle = angleAround(local, this.drag.axis);
    const live = wrapAngle(angle - this.drag.baseAngle) * TURN_GAIN;
    this.cube.setLiveAngle(THREE.MathUtils.clamp(live, -Math.PI * 1.5, Math.PI * 1.5));
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.enabled) return;
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size === 0) {
      if (this.drag?.mode === 'turn') this.cube.endLiveTurn();
      this.drag = null;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    this.orbitRadius = THREE.MathUtils.clamp(this.orbitRadius * Math.exp(e.deltaY * 0.0012), MIN_RADIUS, MAX_RADIUS);
  };
}
