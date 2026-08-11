import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Rubik's Cube model + procedural geometry.
//
// The cube is a 3x3x3 lattice of cubies (small cubes). Each cubie knows its
// integer "logical" position in cube-local space ({-1,0,1}^3) and its mesh.
// A "move" turns one slice (all cubies with a fixed coordinate along an axis)
// by +/-90 degrees around the axis. Turns are animated with easing, then the
// logical positions are recomputed by rounding the rotated coordinates — the
// rotation is always an exact multiple of 90 degrees so there is no drift.
// ---------------------------------------------------------------------------

export const CUBIE_SIZE = 0.16; // metres per cubie (whole cube ~0.48 m)
const HALF = CUBIE_SIZE / 2;
const STICKER_SIZE = CUBIE_SIZE * 0.8;
const STICKER_OFFSET = HALF + 0.0015;

// Classic Rubik's colour scheme (standard on Western cubes).
export const COLORS = {
  red: 0xc41e3a,
  orange: 0xff5800,
  white: 0xffffff,
  yellow: 0xffd500,
  green: 0x009e60,
  blue: 0x0051ba,
  black: 0x101014,
  blackRough: 0x0a0a0d,
} as const;

const FACE_COLOR: Record<string, number> = {
  '+x': COLORS.red,
  '-x': COLORS.orange,
  '+y': COLORS.white,
  '-y': COLORS.yellow,
  '+z': COLORS.green,
  '-z': COLORS.blue,
};

const AXIS_VECTORS = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];

export type AxisIndex = 0 | 1 | 2;

export interface MoveRecord {
  axis: AxisIndex;
  layer: number; // -1 | 0 | 1
  dir: number; // +/-1 (or +/-2 for a half-turn)
}

// ---------------------------------------------------------------------------
// Materials — one shared instance per colour so the whole cube stays cheap.
// ---------------------------------------------------------------------------

let bodyMaterial: THREE.MeshStandardMaterial | null = null;
const stickerMaterials = new Map<number, THREE.MeshStandardMaterial>();

function getBodyMaterial(): THREE.MeshStandardMaterial {
  if (bodyMaterial === null) {
    bodyMaterial = new THREE.MeshStandardMaterial({
      color: COLORS.blackRough,
      roughness: 0.55,
      metalness: 0.05,
    });
  }
  return bodyMaterial;
}

function getStickerMaterial(color: number): THREE.MeshStandardMaterial {
  let mat = stickerMaterials.get(color);
  if (mat === undefined) {
    mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.3,
      metalness: 0.02,
    });
    stickerMaterials.set(color, mat);
  }
  return mat;
}

// ---------------------------------------------------------------------------
// A single cubie: its logical position and its visual meshes.
// ---------------------------------------------------------------------------

export class Cubie {
  logical: THREE.Vector3;
  original: THREE.Vector3; // logical position when the cube was built (solved)
  mesh: THREE.Group;

  constructor(x: number, y: number, z: number) {
    this.logical = new THREE.Vector3(x, y, z);
    this.original = new THREE.Vector3(x, y, z);
    this.mesh = new THREE.Group();

    const body = new THREE.Mesh(new THREE.BoxGeometry(CUBIE_SIZE, CUBIE_SIZE, CUBIE_SIZE), getBodyMaterial());
    this.mesh.add(body);

    const stickerPlane = new THREE.PlaneGeometry(STICKER_SIZE, STICKER_SIZE);
    const faces: { key: string; normal: THREE.Vector3 }[] = [
      { key: '+x', normal: new THREE.Vector3(1, 0, 0) },
      { key: '-x', normal: new THREE.Vector3(-1, 0, 0) },
      { key: '+y', normal: new THREE.Vector3(0, 1, 0) },
      { key: '-y', normal: new THREE.Vector3(0, -1, 0) },
      { key: '+z', normal: new THREE.Vector3(0, 0, 1) },
      { key: '-z', normal: new THREE.Vector3(0, 0, -1) },
    ];
    const axisOf = (key: string): AxisIndex => (key[1] === 'x' ? 0 : key[1] === 'y' ? 1 : 2);

    for (const face of faces) {
      const coord = this.logical.getComponent(axisOf(face.key));
      const isOnFace = face.key.startsWith('+') ? coord === 1 : coord === -1;
      if (isOnFace) {
        const sticker = new THREE.Mesh(stickerPlane, getStickerMaterial(FACE_COLOR[face.key]));
        sticker.position.copy(face.normal).multiplyScalar(STICKER_OFFSET);
        sticker.lookAt(face.normal);
        this.mesh.add(sticker);
      }
    }

    this.mesh.position.set(x * CUBIE_SIZE, y * CUBIE_SIZE, z * CUBIE_SIZE);
  }
}

// ---------------------------------------------------------------------------
// The cube itself.
// ---------------------------------------------------------------------------

interface SliceTurn {
  axis: AxisIndex;
  layer: number;
  target: number;
  current: number; // current angle (radians), animated toward target
  speed: number;
  record: boolean; // whether to append to move history on commit (false for undo)
  snapshot: { cubies: Cubie[]; basePos: THREE.Vector3[]; baseQuat: THREE.Quaternion[] } | null;
}

const _qAxis = new THREE.Quaternion();

export class RubiksCube extends THREE.Group {
  cubies: Cubie[] = [];
  private queue: SliceTurn[] = [];
  private activeTurn: SliceTurn | null = null;
  private liveTurn: SliceTurn | null = null; // a turn being dragged, not yet committed
  history: MoveRecord[] = [];
  onMove: ((move: MoveRecord) => void) | null = null;

  constructor() {
    super();
    this.buildSolved();
  }

  buildSolved(): void {
    while (this.children.length) this.remove(this.children[0]);
    this.cubies = [];
    this.queue = [];
    this.activeTurn = null;
    this.liveTurn = null;
    this.history = [];
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const cubie = new Cubie(x, y, z);
          this.cubies.push(cubie);
          this.add(cubie.mesh);
        }
      }
    }
  }

  isAnimating(): boolean {
    return this.activeTurn !== null || this.queue.length > 0;
  }

  // --------------------------------------------------------------- turn queue

  private snapshotSlice(axis: AxisIndex, layer: number): { cubies: Cubie[]; basePos: THREE.Vector3[]; baseQuat: THREE.Quaternion[] } {
    const cubies = this.cubies.filter((c) => c.logical.getComponent(axis) === layer);
    const basePos: THREE.Vector3[] = [];
    const baseQuat: THREE.Quaternion[] = [];
    for (const c of cubies) {
      basePos.push(c.mesh.position.clone());
      baseQuat.push(c.mesh.quaternion.clone());
    }
    return { cubies, basePos, baseQuat };
  }

  /** Queue an animated turn of a slice by dir*90deg. dir must be +/-1 or +/-2. */
  queueTurn(axis: AxisIndex, layer: number, dir: number, speed = 8, record = true): boolean {
    if (this.liveTurn !== null) return false;
    if (dir === 0) return false;
    if (this.cubiesInSlice(axis, layer).length === 0) return false;
    this.queue.push({
      axis,
      layer,
      current: 0,
      target: dir * (Math.PI / 2),
      speed,
      record,
      snapshot: null, // taken when the turn starts, after any prior turn commits
    });
    return true;
  }

  // ------------------------------------------------------------- live turns

  /** Begin a drag turn. The slice follows the current angle until endLiveTurn. */
  beginLiveTurn(axis: AxisIndex, layer: number): boolean {
    if (this.activeTurn !== null || this.liveTurn !== null) return false;
    const snapshot = this.snapshotSlice(axis, layer);
    if (snapshot.cubies.length === 0) return false;
    this.liveTurn = { axis, layer, target: 0, current: 0, speed: 0, record: true, snapshot };
    return true;
  }

  /** Set the current live-turn angle (radians). */
  setLiveAngle(angle: number): void {
    if (this.liveTurn === null) return;
    this.liveTurn.current = angle;
    this.applyTurn(this.liveTurn, angle);
  }

  /** End the live turn, easing to the nearest 90deg step, then committing. */
  endLiveTurn(): void {
    if (this.liveTurn === null) return;
    const live = this.liveTurn;
    const snapped = Math.round(live.current / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(snapped) < 0.001) {
      // ended where it started — restore the slice and cancel
      this.applyTurn(live, 0);
      this.liveTurn = null;
      return;
    }
    // Promote the live turn to an animated turn continuing from the current angle.
    this.queue.push({
      axis: live.axis,
      layer: live.layer,
      current: live.current,
      target: snapped,
      speed: 10,
      record: true,
      snapshot: live.snapshot, // still current — nothing can have moved meanwhile
    });
    this.liveTurn = null;
  }

  // -------------------------------------------------------------- animation

  update(dt: number): void {
    if (this.liveTurn !== null) return; // live turns are driven by input
    if (this.activeTurn === null && this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.snapshot === null) next.snapshot = this.snapshotSlice(next.axis, next.layer);
      this.activeTurn = next;
    }
    const t = this.activeTurn;
    if (t === null || t.snapshot === null) return;

    t.current += (t.target - t.current) * Math.min(1, dt * t.speed);
    if (Math.abs(t.target - t.current) < 0.001) {
      t.current = t.target;
    }
    this.applyTurn(t, t.current);

    if (t.current === t.target) {
      this.commitTurn(t);
      this.activeTurn = null;
    }
  }

  private applyTurn(t: SliceTurn, angle: number): void {
    const ax = AXIS_VECTORS[t.axis];
    const snap = t.snapshot!;
    _qAxis.setFromAxisAngle(ax, angle);
    for (let i = 0; i < snap.cubies.length; i++) {
      const mesh = snap.cubies[i].mesh;
      mesh.position.copy(snap.basePos[i]).applyAxisAngle(ax, angle);
      mesh.quaternion.copy(_qAxis).multiply(snap.baseQuat[i]);
    }
  }

  private commitTurn(t: SliceTurn): void {
    const ax = AXIS_VECTORS[t.axis];
    const snap = t.snapshot!;
    _qAxis.setFromAxisAngle(ax, t.target);
    for (let i = 0; i < snap.cubies.length; i++) {
      const cubie = snap.cubies[i];
      const rotated = snap.basePos[i].clone().applyAxisAngle(ax, t.target);
      cubie.logical.set(
        Math.round(rotated.x / CUBIE_SIZE),
        Math.round(rotated.y / CUBIE_SIZE),
        Math.round(rotated.z / CUBIE_SIZE),
      );
      cubie.mesh.quaternion.copy(_qAxis).multiply(snap.baseQuat[i]);
      cubie.mesh.position.copy(rotated);
    }
    const dir = Math.round(t.target / (Math.PI / 2));
    if (t.record && dir !== 0) {
      const move: MoveRecord = { axis: t.axis, layer: t.layer, dir };
      this.history.push(move);
      this.onMove?.(move);
    }
  }

  // --------------------------------------------------------------- game ops

  scramble(moves = 22): void {
    if (this.isAnimating() || this.liveTurn !== null) return;
    const layers: number[] = [-1, 0, 1];
    let prevKey = '';
    for (let i = 0; i < moves; i++) {
      let axis = Math.floor(Math.random() * 3) as AxisIndex;
      const layer = layers[Math.floor(Math.random() * layers.length)];
      const dir = Math.random() < 0.5 ? 1 : -1;
      // avoid pointless consecutive inverse moves on the same slice
      const key = `${axis}${layer}`;
      if (key === prevKey) {
        i--;
        continue;
      }
      prevKey = key;
      this.queueTurn(axis, layer, dir, 14);
    }
  }

  undo(): void {
    if (this.liveTurn !== null) return;
    const last = this.history.pop();
    if (last) {
      this.queueTurn(last.axis, last.layer, -last.dir, 10, false);
    }
  }

  /** Is every face a single solid colour? */
  isSolved(): boolean {
    const signAxes: AxisIndex[] = [0, 1, 2];
    const _inv = new THREE.Quaternion();
    const _n = new THREE.Vector3();
    const _d = new THREE.Vector3();
    for (const axis of signAxes) {
      for (const sign of [-1, 1]) {
        const expected = FACE_COLOR[`${sign > 0 ? '+' : '-'}${['x', 'y', 'z'][axis]}`];
        for (const cubie of this.cubies) {
          if (cubie.logical.getComponent(axis) !== sign) continue;
          // outward face normal in cube-local space
          _n.set(0, 0, 0).setComponent(axis, sign);
          // which cubie-local face is outward?
          _inv.copy(cubie.mesh.quaternion).invert();
          _d.copy(_n).applyQuaternion(_inv);
          let da: AxisIndex = 0;
          let best = -1;
          for (const a of [0, 1, 2] as AxisIndex[]) {
            const v = Math.abs(_d.getComponent(a));
            if (v > best) {
              best = v;
              da = a;
            }
          }
          const ds = _d.getComponent(da) > 0 ? '+' : '-';
          const hasSticker = cubie.original.getComponent(da) === (ds === '+' ? 1 : -1);
          if (!hasSticker) return false;
          if (FACE_COLOR[`${ds}${['x', 'y', 'z'][da]}`] !== expected) return false;
        }
      }
    }
    return true;
  }

  /** Cubies whose logical coordinate along `axis` equals `layer`. */
  cubiesInSlice(axis: AxisIndex, layer: number): Cubie[] {
    return this.cubies.filter((c) => c.logical.getComponent(axis) === layer);
  }

  /** True if any cubie mesh lies within `radius` of `point` (world space). */
  cubieAt(point: THREE.Vector3, radius: number): Cubie[] {
    const local = this.worldToLocal(point.clone());
    const hits: Cubie[] = [];
    for (const c of this.cubies) {
      const d = local.distanceTo(c.logical.clone().multiplyScalar(CUBIE_SIZE));
      if (d <= radius) hits.push(c);
    }
    return hits;
  }
}
