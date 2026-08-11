import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Thick blue "wireframe" frames built from thin solid boxes (WebGL ignores
// LineBasicMaterial.linewidth > 1, so boxes give guaranteed-thick edges).
// Used for the cube's hitbox outline, the per-cubie beam highlight, and the
// VR menu hover frame. All procedural.
// ---------------------------------------------------------------------------

export interface BoxFrame {
  group: THREE.Group;
  material: THREE.MeshBasicMaterial;
}

const _axis: Record<'x' | 'y' | 'z', [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

function makeBar(length: number, thickness: number, material: THREE.MeshBasicMaterial, axis: 'x' | 'y' | 'z'): THREE.Mesh {
  const s = _axis[axis];
  const geo = new THREE.BoxGeometry(
    s[0] ? length : thickness,
    s[1] ? length : thickness,
    s[2] ? length : thickness,
  );
  const bar = new THREE.Mesh(geo, material);
  return bar;
}

export function buildBoxFrame(size: number, thickness: number): BoxFrame {
  const material = new THREE.MeshBasicMaterial({
    color: 0x3d7bff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const group = new THREE.Group();
  const h = size / 2;
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const bar = makeBar(size, thickness, material, 'x');
      bar.position.set(0, sy * h, sz * h);
      group.add(bar);
    }
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const bar = makeBar(size, thickness, material, 'y');
      bar.position.set(sx * h, 0, sz * h);
      group.add(bar);
    }
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const bar = makeBar(size, thickness, material, 'z');
      bar.position.set(sx * h, sy * h, 0);
      group.add(bar);
    }
  }
  return { group, material };
}

export function buildRectFrame(width: number, height: number, thickness: number): BoxFrame {
  const material = new THREE.MeshBasicMaterial({
    color: 0x3d7bff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const group = new THREE.Group();
  for (const sy of [-1, 1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(width, thickness, thickness), material);
    bar.position.set(0, (sy * height) / 2, 0);
    group.add(bar);
  }
  for (const sx of [-1, 1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(thickness, height, thickness), material);
    bar.position.set((sx * width) / 2, 0, 0);
    group.add(bar);
  }
  return { group, material };
}
