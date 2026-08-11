import * as THREE from 'three';
import { buildRectFrame } from './outline';

// ---------------------------------------------------------------------------
// VR menu — a simple floating 3D panel with Scramble / Reset / Undo buttons.
// Rendered in the scene (regular DOM can't show inside an immersive session),
// with canvas-texture labels (procedural, no fonts/asset downloads). Opened by
// pressing the ☰ menu button on the left controller; hovered buttons light up
// (a plain blue backing plane + tint — no fragile wireframe); trigger on a
// button activates it.
// ---------------------------------------------------------------------------

export type MenuAction = 'scramble' | 'solve' | 'reset' | 'undo';

const ACTIONS: { action: MenuAction; label: string }[] = [
  { action: 'scramble', label: 'Scramble' },
  { action: 'solve', label: 'Solve' },
  { action: 'reset', label: 'Reset to Solved' },
  { action: 'undo', label: 'Undo' },
];

const BTN_W = 0.56;
const BTN_H = 0.11;
const BTN_GAP = 0.05;

const _dir = new THREE.Vector3();

function makeLabelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#12121e';
  ctx.beginPath();
  ctx.roundRect(4, 4, c.width - 8, c.height - 8, 14);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class VRMenu extends THREE.Group {
  private buttons: {
    action: MenuAction;
    mesh: THREE.Mesh;
    backing: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
  }[] = [];

  constructor() {
    super();
    this.visible = false;

    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(0.74, 0.74, 0.02),
      new THREE.MeshBasicMaterial({ color: 0x0a0a16, transparent: true, opacity: 0.92 }),
    );
    this.add(panel);
    const border = buildRectFrame(0.76, 0.76, 0.006);
    border.material.opacity = 0.5;
    this.add(border.group);

    // one shared bright-blue backing material; each button gets its own backing
    // plane slightly larger than the button, just behind it — on hover the
    // backing shows as a clean blue border around the (opaque) button. No thin
    // wireframe bars, so nothing can clip or look broken from any angle.
    const backingMat = new THREE.MeshBasicMaterial({ color: 0x3d7bff });
    const startY = 0.74 / 2 - BTN_H / 2 - 0.03;
    ACTIONS.forEach((a, i) => {
      const material = new THREE.MeshBasicMaterial({ map: makeLabelTexture(a.label), transparent: true });
      const y = startY - i * (BTN_H + BTN_GAP);
      const backing = new THREE.Mesh(new THREE.PlaneGeometry(BTN_W + 0.016, BTN_H + 0.016), backingMat);
      backing.position.set(0, y, 0.015);
      backing.visible = false;
      this.add(backing);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BTN_W, BTN_H), material);
      mesh.position.set(0, y, 0.02);
      this.add(mesh);
      this.buttons.push({ action: a.action, mesh, backing, material });
    });
  }

  get isOpen(): boolean {
    return this.visible;
  }

  get buttonMeshes(): THREE.Mesh[] {
    return this.buttons.map((b) => b.mesh);
  }

  actionFor(object: THREE.Object3D | null): MenuAction | null {
    if (object === null) return null;
    return this.buttons.find((b) => b.mesh === object)?.action ?? null;
  }

  /** Open the menu, centred in front of the user at a fixed world position. */
  open(camera: THREE.Camera): void {
    this.visible = true;
    camera.getWorldDirection(_dir);
    this.position.copy(camera.position).addScaledVector(_dir, 1.15);
    this.position.y = camera.position.y; // eye height, straight ahead
    this.lookAt(camera.position);
  }

  close(): void {
    this.visible = false;
    this.setHovered(null);
  }

  setHovered(action: MenuAction | null): void {
    for (const b of this.buttons) {
      const on = b.action === action;
      b.backing.visible = on; // blue border behind the button
      b.material.color.set(on ? 0xa9c2ff : 0xffffff); // brighten the hovered button
    }
  }
}
