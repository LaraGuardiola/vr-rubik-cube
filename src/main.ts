import * as THREE from 'three';
import { RubiksCube } from './cube';
import { NebulaSkybox } from './skybox';
import { DesktopControls } from './controlsDesktop';
import { HandRig } from './hands';
import { XRControls } from './xrControls';
import { setupXRButtons } from './xrSession';

// ---------------------------------------------------------------------------
// Entry point — wires the renderer, scene, cube, skybox, desktop controls,
// XR session handling and hand tracking together.
// ---------------------------------------------------------------------------

const SPAWN_DESKTOP = new THREE.Vector3(0, 1.35, 0);
const SPAWN_XR = new THREE.Vector3(0, 1.35, -2.6);

const container = document.getElementById('app') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const winToastEl = document.getElementById('winToast') as HTMLElement;
const hintEl = document.getElementById('hint') as HTMLElement;
const btnScramble = document.getElementById('btnScramble') as HTMLButtonElement;
const btnReset = document.getElementById('btnReset') as HTMLButtonElement;
const btnUndo = document.getElementById('btnUndo') as HTMLButtonElement;

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.xr.enabled = true;
container.appendChild(renderer.domElement);

// ------------------------------------------------------------------ camera
const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 200);

// ------------------------------------------------------------------- scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050510);

const skybox = new NebulaSkybox();
scene.add(skybox);

// Lighting: a hemisphere base + key + cool rim. Works in passthrough AR too.
scene.add(new THREE.HemisphereLight(0x8fa2ff, 0x1a2233, 1.0));
const keyLight = new THREE.DirectionalLight(0xfff4e6, 1.8);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x4499ff, 0.8);
rimLight.position.set(-4, 1, -3);
scene.add(rimLight);
const fillLight = new THREE.DirectionalLight(0xff8844, 0.35);
fillLight.position.set(0, -2, 3);
scene.add(fillLight);

// -------------------------------------------------------------------- cube
const cube = new RubiksCube();
cube.position.copy(SPAWN_DESKTOP);
scene.add(cube);

// ---------------------------------------------------------------- controls
const desktopControls = new DesktopControls(container, camera, cube);
const xrControls = new XRControls(cube);
const handRigs: HandRig[] = [];

// -------------------------------------------------------------------- hints
function setHint(text: string): void {
  hintEl.textContent = text;
}
setHint('Drag a face to turn that layer\nDrag empty space to orbit · Scroll to zoom');

function showWinToast(): void {
  winToastEl.classList.add('show');
  winToastEl.textContent = 'Solved!';
  window.setTimeout(() => winToastEl.classList.remove('show'), 3000);
}

// ------------------------------------------------------------- game actions
let scrambling = false;
btnScramble.addEventListener('click', () => {
  cube.scramble(22);
  scrambling = true;
  statusEl.textContent = 'Scrambling…';
});
btnReset.addEventListener('click', () => {
  cube.buildSolved();
  scrambling = false;
  statusEl.textContent = 'Solved';
});
btnUndo.addEventListener('click', () => {
  cube.undo();
});

// ------------------------------------------------------------------- XR
function respawnCube(xrMode: boolean): void {
  cube.updateMatrixWorld(true);
  cube.position.copy(xrMode ? SPAWN_XR : SPAWN_DESKTOP);
  cube.quaternion.identity();
}

function attachHands(): void {
  for (let i = 0; i < 2; i++) {
    const hand = renderer.xr.getHand(i);
    if (!hand.parent) scene.add(hand);
    if (handRigs[i] === undefined) {
      const rig = new HandRig(hand);
      handRigs[i] = rig;
      xrControls.attach(rig.state);
    }
  }
}

void setupXRButtons(renderer, {
  onSessionStart: (session, mode) => {
    desktopControls.setEnabled(false);
    respawnCube(true);
    attachHands();
    if (mode === 'ar') {
      // passthrough backdrop — hide the nebula
      skybox.visible = false;
      scene.background = null;
    } else {
      skybox.visible = true;
      scene.background = null;
    }
    setHint('Pinch thumb + index to grab a layer\nTwist your hand to turn · Pinch near the cube to move it');
    statusEl.textContent = session.environmentBlendMode === 'additive' ? 'Immersive VR' : 'Immersive AR';
  },
  onSessionEnd: () => {
    desktopControls.setEnabled(true);
    desktopControls.resetView();
    skybox.visible = true;
    scene.background = new THREE.Color(0x050510);
    setHint('Drag a face to turn that layer\nDrag empty space to orbit · Scroll to zoom');
    statusEl.textContent = 'Desktop';
  },
  onError: (err) => {
    console.error('XR session error:', err);
    statusEl.textContent = 'Could not start XR session';
  },
});

// -------------------------------------------------------------- solve check
let wasSolved = true;
function checkSolved(): void {
  if (scrambling) {
    if (!cube.isAnimating()) {
      scrambling = false;
      statusEl.textContent = `Scrambled — ${cube.history.length} moves`;
    }
    return;
  }
  if (cube.isAnimating() || renderer.xr.isPresenting) return;
  const solved = cube.isSolved();
  if (solved && !wasSolved) showWinToast();
  wasSolved = solved;
  statusEl.textContent = solved ? 'Solved!' : `${cube.history.length} move${cube.history.length === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- main loop
let lastTime = 0;
renderer.setAnimationLoop((time) => {
  const dt = lastTime === 0 ? 0.016 : (time - lastTime) / 1000;
  lastTime = time;
  skybox.update(time * 0.001);
  cube.update(dt);
  desktopControls.update();
  if (renderer.xr.isPresenting) {
    for (const rig of handRigs) {
      if (rig) rig.update();
    }
  }
  checkSolved();
  renderer.render(scene, camera);
});

// ----------------------------------------------------------------- resize
window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

statusEl.textContent = 'Desktop';

// small debug hook for automated tests (harmless in production)
Object.assign(window, {
  THREE,
  __cubeDebug: cube,
  __renderer: renderer,
  __camera: camera,
  __scene: scene,
  __desktop: desktopControls,
});
