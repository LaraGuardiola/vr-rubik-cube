import * as THREE from 'three';
import { RubiksCube } from './cube';
import { NebulaSkybox } from './skybox';
import { DesktopControls } from './controlsDesktop';
import { HandRig } from './hands';
import { ControllerSource } from './controllers';
import { XRControls } from './xrControls';
import { setupXRButtons } from './xrSession';
import { VRMenu } from './menu';

// ---------------------------------------------------------------------------
// Entry point — wires the renderer, scene, cube, skybox, desktop controls,
// XR session handling and hand tracking together.
// ---------------------------------------------------------------------------

const SPAWN_DESKTOP = new THREE.Vector3(0, 1.35, 0);
// In VR the cube spawns close and low so it can basically be grabbed. (The
// cubies are 0.16 m, so the whole cube is ~0.48 m.)
const SPAWN_XR = new THREE.Vector3(0, 1.2, -1.0);

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

console.log('VR Rubik\'s Cube loaded — build v2'); // harmless; used to trigger deployments

const skybox = new NebulaSkybox();
scene.add(skybox);

// Lighting: even fill from all directions so every sticker face (including the
// bottom) is readable. Hemisphere + key + rim + fill + a soft up-light.
scene.add(new THREE.AmbientLight(0x8899cc, 0.6));
scene.add(new THREE.HemisphereLight(0x8fa2ff, 0x556080, 1.0));
const keyLight = new THREE.DirectionalLight(0xfff4e6, 1.6);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x4499ff, 0.8);
rimLight.position.set(-4, 1, -3);
scene.add(rimLight);
const fillLight = new THREE.DirectionalLight(0xff8844, 0.5);
fillLight.position.set(2, -1, 3);
scene.add(fillLight);
const upLight = new THREE.DirectionalLight(0x88aaff, 0.7); // lights the bottom face
upLight.position.set(0, -4, 0);
scene.add(upLight);

// -------------------------------------------------------------------- cube
const cube = new RubiksCube();
cube.position.copy(SPAWN_DESKTOP);
scene.add(cube);

// ---------------------------------------------------------------- controls
const desktopControls = new DesktopControls(container, camera, cube);
const xrControls = new XRControls(cube);
const handRigs: HandRig[] = [];
const controllerSources: ControllerSource[] = [];

// VR floating menu (opened with the ☰ menu button on the left controller)
const vrMenu = new VRMenu();
scene.add(vrMenu);
const prevSelect = [false, false];
const prevMenu = [false, false];
const _cubeCenter = new THREE.Vector3();

function activateMenu(action: 'scramble' | 'reset' | 'undo'): void {
  if (action === 'scramble') {
    cube.scramble(22);
    scrambling = true;
    statusEl.textContent = 'Scrambling…';
  } else if (action === 'reset') {
    cube.buildSolved();
    scrambling = false;
    statusEl.textContent = 'Solved';
  } else if (action === 'undo') {
    cube.undo();
  }
}

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

// Attach hand rigs AND controller sources for both input slots. Whichever the
// user has (tracked hands or Quest controllers) drives the same interactions.
function attachInputSources(): void {
  for (let i = 0; i < 2; i++) {
    const hand = renderer.xr.getHand(i);
    if (!hand.parent) scene.add(hand);
    if (handRigs[i] === undefined) {
      const rig = new HandRig(hand);
      handRigs[i] = rig;
      xrControls.attach(rig);
    }

    const grip = renderer.xr.getControllerGrip(i);
    const ray = renderer.xr.getController(i);
    if (!grip.parent) scene.add(grip);
    if (!ray.parent) scene.add(ray);
    if (controllerSources[i] === undefined) {
      const source = new ControllerSource(grip, ray, cube);
      controllerSources[i] = source;
      xrControls.attach(source);
    }
  }
}

void setupXRButtons(renderer, {
  onSessionStart: (session, mode) => {
    desktopControls.setEnabled(false);
    respawnCube(true);
    attachInputSources();
    if (mode === 'ar') {
      // passthrough backdrop — hide the nebula
      skybox.visible = false;
      scene.background = null;
    } else {
      skybox.visible = true;
      scene.background = null;
    }
    setHint(
      '☰ menu button = menu · Aim + trigger = turn layer · Grip = grab/pull\n' +
        'Far (>1m): pull the cube · Close: turn layers & grab directly\nHands: index = layer · middle = move',
    );
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

  // outline the face/slice currently being turned (so you can see the axis);
  // shown before update() so the frame rotates with the slice as it turns
  const activeSlice = cube.currentSlice();
  if (activeSlice) cube.showSliceOutline(activeSlice.axis, activeSlice.layer);
  else cube.hideSliceOutline();
  cube.update(dt);
  desktopControls.update();

  if (renderer.xr.isPresenting) {
    xrControls.update(dt);
    for (const rig of handRigs) {
      if (rig) rig.update();
    }
    for (const source of controllerSources) {
      if (source) source.update();
    }

    // hitbox hint, distance-based: far away the cube's edges glow with a neon
    // pulse (only while pointing at it); close up the targeted cubie is outlined
    // and the whole cube glows when within direct-grab range
    cube.clearHighlights();
    for (const source of controllerSources) {
      if (!source) continue;
      const dist = source.pinchPoint.distanceTo(cube.getWorldPosition(_cubeCenter));
      if (dist <= 1.0) {
        if (source.beamCubie) cube.showCubieOutline(source.beamCubie);
        if (dist < 0.4) cube.setGlow(0.6);
      } else if (source.aimingAtCube) {
        cube.setGlow(0.7 + 0.25 * Math.sin(time * 0.006)); // neon pulse
      }
    }

    // VR menu: the ☰ menu button (left controller) toggles it; beam + trigger
    // on a button activates it. (Left trigger on empty space also toggles.)
    for (let i = 0; i < controllerSources.length; i++) {
      const source = controllerSources[i];
      if (!source) continue;
      const sel = source.selectPressed;
      const justPressed = sel && !prevSelect[i];
      prevSelect[i] = sel;
      const menuPressed = source.menuPressed;
      const menuJustPressed = menuPressed && !prevMenu[i];
      prevMenu[i] = menuPressed;

      const hovered = vrMenu.isOpen ? vrMenu.actionFor(source.castBeam(vrMenu.buttonMeshes)?.object ?? null) : null;
      if (vrMenu.isOpen) vrMenu.setHovered(hovered);

      if (menuJustPressed && i === 0) {
        vrMenu.isOpen ? vrMenu.close() : vrMenu.open(camera);
      }
      if (justPressed) {
        if (vrMenu.isOpen) {
          if (hovered !== null) {
            activateMenu(hovered);
          } else if (i === 0) {
            vrMenu.close();
          }
        } else if (i === 0 && source.beamCubie === null) {
          vrMenu.open(camera);
        }
      }
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
