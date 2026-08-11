# AGENTS.md — VR Rubik's Cube

## Project summary & current feature state

A minimal, playable 3D Rubik's Cube that runs two ways from the same scene:

1. **Desktop / mobile browser** — mouse & touch only (no keyboard required): drag on a cube face to turn that layer, drag empty space to orbit the camera, scroll/pinch to zoom. Scramble, Reset-to-solved and Undo buttons in a small HUD.
2. **WebXR — hand-tracked immersive** — prefers **AR passthrough** (`immersive-ar`, cube floats in the player's real room); falls back to **immersive VR** (`immersive-vr`) with a fully procedural nebula/starfield skybox. Two input styles, both supported simultaneously:
   - **Hand tracking** (no controllers): **index-finger pinch** (thumb↔index) grabs a layer to turn; **middle-finger pinch** (thumb↔middle) grabs the whole cube to move/rotate it.
   - **Quest controllers**: aim the laser at a face and pull the **trigger** to turn that slice; hold the **grip** button to grab and move the whole cube.
   The controller laser and proximity show a blue "hitbox" glow. When the player lets go, the cube stays floating exactly where it was released — no gravity, no drift.

Everything visual is generated in code (procedural geometry, shaders, runtime canvas/favicon). No downloaded models, textures, fonts or audio. The only documented exception to the "hand-built only" rule is the hand visualisation: the hands are a lightweight procedural rig (spheres + cylinders at the `XRHand` joint positions), not an imported rigged hand.

**What's done (tested):**
- Full Rubik's Cube model: 27 cubies, per-face stickers, eased layer turns, live "drag" turns that snap to the nearest 90° on release, move history, undo, scramble, reset, solved detection.
- Desktop controls (pointer/touch), camera orbit + zoom.
- WebXR session management (AR-first button, VR fallback button, hand-tracking feature request), AR vs VR environment switching.
- Procedural nebula skybox shader.
- Procedural hand rig + pinch detection (thumb–index distance with hysteresis).
- Quest controller support (trigger = slice turn via laser pick, grip = whole-cube grab) with a procedural controller visual + aim beam.
- VR grab logic (slice turn by hand/controller orbit, whole-cube grab) shared by hands and controllers.
- Blue "hitbox" outlines: the cubie under a controller laser and the cube's edges when close are outlined in thick blue (built from thin boxes — WebGL ignores `linewidth > 1`).
- VR menu: a floating 3D panel (Scramble / Reset / Undo, canvas-texture labels) toggled with the **☰ menu button** on the left controller; beam + trigger on a button activates it (hovered button glows).
- Alyx-style gravity pull: hold grip on the cube, yank the controller back ("pull"), and the cube flies to a hold point just in front of the controller.
- Rotating-face outline, thumbstick layer turns, and two-hand resize.
- Even lighting (ambient + hemisphere + key/rim/fill + up-light) so all six faces, including the bottom, are readable.
- Test suite: cube-logic smoke test (headless, no browser) and a Puppeteer browser smoke test (desktop interactions, no-JS-errors, frame-content check, XR button creation).

**What's stubbed / TODO / known-gaps:**
- **VR interactions have NOT been exercised on real hardware.** The logic is reasoned about and structured per three.js documented patterns, but no Quest/headset was available in this environment. Verify pinch thresholds, the ambiguous-axis heuristic and hand-rig sizing on a real device (see "Testing on a real headset").
- No solver. "Reset to Solved" rebuilds the cube to solved; there is no solve animation (a Kociemba-style solver or reverse-history playback would be the natural next step).
- Single interaction at a time in VR (first hand to pinch wins; a second simultaneous pinch is ignored until the first releases).
- Two-handed layer-turn anchoring (spec suggestion) is **not** implemented — one hand alone drives a turn by orbiting the slice axis; a middle-finger pinch (hands) or grip button (controllers) serves the "move the cube" role instead.
- The hand rig is intentionally primitive (spheres/cylinders) per the asset policy exception.
- No hit-testing/anchor placement: the cube always spawns at a fixed offset in front of the user; it does not sit on a real surface.
- ~200 draw calls (27 cubies × body+stickers, plus hand joints) — fine for Quest-class headsets, but could be optimised with `InstancedMesh` if profiling shows a need.

## Commands

```bash
bun install          # install dependencies
bun run dev          # start Vite dev server over plain HTTP (easiest for testing from a Quest 2)
bun run dev:host     # same, explicitly binds to the LAN (http://<your-lan-ip>:5173)
bun run dev:https    # HTTPS variant (self-signed cert via @vitejs/plugin-basic-ssl) — WebXR on remote devices
bun run dev:host:https # HTTPS variant, explicitly bound to the LAN
bun run build        # typecheck (tsc --noEmit) + production build into docs/
bun run preview      # serve the built docs/ locally
bun run typecheck    # tsc --noEmit only
bun run smoke        # headless logic test of the cube mechanics (no browser needed)
bun run browser:smoke# headless-Chromium test of the live app (requires `bun run dev` running)
```

`browser:smoke` needs the dev server on `http://localhost:5173` (start it in a second terminal). It launches the system Edge/Chrome via `puppeteer-core` (`CHROME_PATH` env var overrides the executable). There is no linter configured.

## Architecture

Flat module layout in `src/` — deliberately small, no framework.

| File | Responsibility |
| --- | --- |
| `src/main.ts` | Entry point. Creates renderer/camera/scene/lights, instantiates the cube, skybox, desktop controls and XR controls; wires HUD buttons, status text, win toast; the `renderer.setAnimationLoop` main loop calls `cube.update(dt)`, `skybox.update(t)`, `desktopControls.update()`, `handRig.update()` (when presenting) and `checkSolved()`. Holds spawn constants and the AR/VR environment switching (hide skybox + `scene.background = null` for AR passthrough). |
| `src/cube.ts` | The Rubik's Cube model. `Cubie` builds its own geometry (black body box + sticker planes, shared materials). `RubiksCube` tracks the 27 cubies' integer `logical` positions, turns slices (queued eased turns + live drag turns), records `history`, and exposes `scramble()`, `undo()`, `buildSolved()` (reset), `isSolved()` (facelet-colour check via cubie orientations), `cubieAt(point, radius)`, `cubiesInSlice(axis, layer)`. |
| `src/skybox.ts` | `NebulaSkybox`: a `BackSide` sphere with a hand-written fragment shader (fbm value-noise nebula clouds + hash-based star field + twinkle). No textures. |
| `src/controlsDesktop.ts` | `DesktopControls`: pointer/touch handlers. Raycasts to decide face-turn vs orbit; tracks the pointer's angle around the slice axis against a virtual sphere; wheel/pinch zoom; shift+drag forces orbit. Each frame it repositions the camera to orbit the cube's world position. |
| `src/hands.ts` | `PinchSource` interface (shared by hands & controllers) + `HandRig`: builds the procedural hand (sphere per `XRHand` joint + cylinder per finger bone) from the joint groups three.js maintains on `renderer.xr.getHand(i)`. Detects pinch (thumb-tip ↔ index-tip distance, hysteresis) and exposes world-space `pinchPoint`, `palmPos`, `palmQuat` plus start/move/end callbacks. |
| `src/controllers.ts` | `ControllerSource`: drives the same interactions with Quest controllers. Trigger (`select`) raycasts the laser to pick the slice under the beam and turns it by controller orbit; grip (`squeeze`) grabs the whole cube. Includes a small procedural controller body + aim beam and tracks the beam-hit cubie / cube proximity for the blue hitbox glow. |
| `src/xrControls.ts` | `XRControls`: VR interaction state machine over any `PinchSource`. The **layer** channel (index pinch / trigger) decides **layer turn** — hand: pinched cubies share a slice; controller: laser hit. The **whole-cube** channel (middle pinch / grip button) attaches the cube to the hand/controller. Drives `beginLiveTurn/setLiveAngle/endLiveTurn` for slices. One active interaction at a time. |
| `src/xrSession.ts` | `setupXRButtons(renderer, events)`: queries `navigator.xr.isSessionSupported` for AR and VR, builds the "Enter AR" / "Enter VR" buttons, requests sessions (`optionalFeatures: ['local-floor','bounded-floor','hand-tracking','layers']`), sets the reference space to `local-floor`, and fires `onSessionStart`/`onSessionEnd`/`onError`. |
| `src/menu.ts` | `VRMenu`: a floating 3D panel (Scramble / Reset / Undo) with canvas-texture labels and a blue hover outline, anchored in front-and-to-the-right of the user. |
| `src/outline.ts` | `buildBoxFrame` / `buildRectFrame`: thick blue wireframe frames built from thin boxes (WebGL ignores `linewidth > 1`). |
| `index.html` | HUD markup + styles (status pill, toolbar, win toast, hint bar). Favicon is an inline data-URI SVG (hand-authored). |
| `scripts/smoke.ts` | Headless logic test of the cube (turns, live-drag snapping, undo, scramble/reverse, reset, state integrity). |
| `scripts/browserSmoke.ts` | Puppeteer test: loads the app, drives real mouse drags (horizontal sweep to turn a layer), checks undo, scramble, screenshot pixel content, no console errors, and that XR enter-buttons appear when `navigator.xr` is faked. |
| `vite.config.ts` | HTTP dev server (default, bound to all interfaces). `vite.config.https.ts` is the HTTPS variant used by `dev:https`. |

### How the parts connect

- `main.ts` owns the singleton `RubiksCube`, `NebulaSkybox`, `DesktopControls`, `XRControls` and the two `HandRig`s.
- **Desktop path:** pointer events → `DesktopControls` → raycast against `cube.cubies` → `cube.beginLiveTurn(...)`/`setLiveAngle(...)`/`endLiveTurn()` → `cube.update(dt)` animates and commits, pushing to `history`. The HUD reads `history`/`isSolved()`.
- **XR path:** `xrSession.ts` starts a session → `main.ts`'s `onSessionStart` disables desktop controls, respawns the cube in front of the user, creates/reuses hand rigs and controller sources and attaches them to `XRControls` → each frame `HandRig.update()`/`ControllerSource.update()` detect grab state and call into `XRControls` → `XRControls` drives the same `cube` turn API, or moves the cube group directly (whole-cube grab). `onSessionEnd` re-enables desktop controls and restores the skybox.
- **Cube state** is fully contained in `RubiksCube`; both control paths mutate it through the same API, so state stays consistent when switching between desktop and VR.

## Asset policy (mandatory)

- **Everything hand-built in code.** Procedural geometry (`BoxGeometry`, `PlaneGeometry`, `SphereGeometry`, `CylinderGeometry`), `MeshStandardMaterial` colours, shader-based skybox, inline SVG favicon. The nebula/starfield is a fragment shader.
- **No downloaded 3D models, texture packs, sprite atlases, or stock assets.** Do not import one "to save time" — keep the constraint.
- **The single exception is hand tracking:** the hands are rendered as a lightweight procedural rig built from `XRHand` joint data (spheres + cylinders). This is intentional and documented. If you replace it with a nicer procedural hand, keep it procedural (e.g. capsules/swept geometry from the joint data) — still no imported models.

## Non-obvious decisions (the "why")

- **Vite, not Bun's bundler.** `bun build` (Bun's bundler) has rough edges with three.js/WebXR addons; Vite (rolldown-based) gives a reliable dev server + production build with HMR. Bun is the task runner and package manager everywhere (`bun run …`).
- **HTTP by default, HTTPS opt-in.** The default dev server serves **plain HTTP** (`vite.config.ts`) because a Quest 2 (and most headset browsers) will happily load `http://<your-lan-ip>:5173` with no certificate hassle — the primary workflow for testing on a headset. WebXR technically requires a **secure context**: `http://localhost` is treated as secure by browsers, but `http://<lan-ip>` is **not**, so over plain HTTP the "Enter AR/VR" buttons may not appear (WebXR is gated by `isSecureContext`). When you need real WebXR from the headset, use the HTTPS variant (`vite.config.https.ts`, `bun run dev:https`, self-signed cert via `@vitejs/plugin-basic-ssl`) and either trust the cert on the device or tunnel it (see "Testing on a real headset").
- **Custom XR buttons instead of three.js `VRButton`/`ARButton`.** The spec suggested three's buttons, but they inject fixed-position inline styles that fight the HUD. The custom buttons in `xrSession.ts` do the identical request flow and add `'hand-tracking'` to `optionalFeatures`.
- **AR-first.** `xrSession.ts` shows "Enter AR" whenever `immersive-ar` is supported and "Enter VR" as a secondary option. In AR, `scene.background = null` so passthrough shows; the skybox is hidden. In VR (and desktop) the nebula skybox is the backdrop. AR vs VR is decided purely by `navigator.xr.isSessionSupported`, with the environment blend mode (`session.environmentBlendMode`) used only for the status text.
- **Spawn positions.** Desktop: cube at `(0, 1.35, 0)` with the camera orbiting it. XR: cube at `(0, 1.2, -1.0)` in the `local-floor` reference space (origin at the user's feet, −Z forward at session start) — close enough to grab, slightly below eye height. On entering XR the cube teleports to the XR spawn and its orientation resets to identity, but the scrambled state is preserved.
- **Cubie size 0.06 m** (whole cube ~0.18 m) — reads as a small cube you can hold in your hand in VR, still fine to pinch individual cubies. (Earlier 0.6 m at the old 2.6 m spawn read as gigantic.)
- **Turn mechanics.** A slice turn is a rotation of a snapshot of the slice's cubies around the slice axis, eased with exponential damping, then committed at an exact multiple of 90°. Snapshots are taken **when the turn starts**, not when it is queued — queued moves (scramble/undo) must capture the state that exists at execution time, or later turns apply to stale positions (this caused a duplicate-position bug early on).
- **Live turns vs queued turns.** Desktop drags and VR pinches are "live": the angle follows the input continuously and, on release, eases to the nearest 90° (`endLiveTurn`). A no-op release (angle rounds to 0) restores the slice with no history entry.
- **Undo** replays the last move's inverse with `record = false` so undoing doesn't grow `history` again.
- **Scramble = 22 random quarter-turns**, skipping consecutive inverse moves on the same slice. No solver — Reset rebuilds the solved cube.
- **Desktop turn axis = the face normal of the clicked face; layer = the clicked cubie's coordinate along that axis.** The pointer's angle around the axis is tracked against a **virtual sphere** around the cube centre and multiplied by a **`TURN_GAIN` (7×)** so short drags and any drag direction turn the layer. **Drag on empty space (or Shift+drag) orbits the camera**; wheel/pinch zoom.
- **Pinch thresholds:** engage a grab when thumb-tip↔finger-tip distance < **3.5 cm**, release above **5.5 cm** (hysteresis). three.js's built-in `pinchstart/pinchend` events use much tighter thresholds (~2 cm), which felt too fragile for a "grab a cubie" interaction, so `hands.ts` implements its own. The **index-finger pinch drives layer turns** and the **middle-finger pinch drives whole-cube grabs** — an explicit finger split so "turn a layer" and "move the cube" never conflict.
- **VR layer-turn axis is chosen from the drag direction.** The slice is NOT locked to the clicked face's normal. `pickTurnAxis(cubiePosLocal, dragDirLocal)` picks the cube axis whose rotation best follows the grab point's motion (maximising `(A × r̂) · d̂`) — so dragging left↔right turns around the vertical axis, up↔down around a horizontal one, and any of the 3 layers through the grabbed cubie can be turned. Controllers and hands share this rule.
- **Whole-cube grab in VR** = middle-finger pinch (hands) **within reach of the cube**, or the **grip** button (controllers) **while the laser is on the cube**. A **1 m range gate** splits the behaviour: from **farther than 1 m** the grip only arms the grab and an explicit **pull gesture** (yank the controller back, ≥ 6 cm) triggers the **gravity pull** — the cube flies to a hold point ~0.1 m in front of the controller tip (Half-Life: Alyx style), locks on, follows, then floats where released. **Within 1 m** there is no pull: grip grabs directly (rigid attach), and layer turns work. Hands grab directly (a middle pinch is already at the cube).
- **Layer turns only within 1 m.** The 1 m range gate in `onPinchStart` means faces can only be rotated when the controller/hand is close to the cube; from farther away the trigger does nothing (the menu / gravity pull take over).
- **Hitbox feedback, distance-based.** Beyond 1 m the cube's **edge outline** glows with a neon pulse — but only while the laser line actually passes near the cube (`aimingAtCube`: perpendicular ray-to-centre distance < 0.45 m), so it never lingers when you're not pointing at it. Within 1 m the laser-targeted cubie gets its own outline and the cube's edges glow when the tip is within 0.4 m (direct-grab range). Outlines are thin box frames (`src/outline.ts`, ~3–4 mm bars) because WebGL ignores `linewidth > 1`; sticker colours stay readable.
- **Rotating-face outline.** While a layer is turning (drag or snap animation) the cube draws a frame around that slice/face (`showSliceOutline`) so you can always see which axis is being rotated.
- **Thumbstick turns.** While holding a piece with the trigger, the controller's thumbstick drives the layer: up/down → the vertical (Y) axis, left/right → the horizontal (X) axis, deflection = turn angle (snaps to 90° on release). The motion-based hand turn still works alongside.
- **Two-hand resize.** Hold the cube with one hand/controller (grip or middle pinch), then grab it with the other (within 0.7 m) and stretch your hands apart to enlarge or bring them together to shrink (0.4×–3×). The size persists after release.
- **VR menu** (`src/menu.ts`) — a floating 3D panel with Scramble / Reset / Undo buttons (canvas-texture labels; regular DOM can't show inside an immersive session). Toggled with the **☰ menu button** on the left controller (read from the input source's gamepad; the left trigger on empty space also toggles as a fallback). It's anchored once, **centred in front of the user** at eye height (fixed in the world — it doesn't follow your head). Beam on a button outlines it blue; trigger on a button activates it.
- **Controller events are one-shot.** WebXR only fires `selectstart`/`selectend` and `squeezestart`/`squeezeend` (no stream while held), so `ControllerSource` uses the events for grab start/end and **polls the move callbacks every frame** in `update()` while a button is held. Without that polling the cube would attach but never follow the hand.
- **Layer-turn snapping angle = 90°** (nearest quarter-turn), the standard Rubik's constraint; a 180° drag commits a half-turn.
- **Solved detection** checks every face of the cube in cube-local space by transforming each cubie's outward face normal by its stored orientation quaternion and comparing sticker colours — it does not compare world positions, so it is valid even after the cube has been arbitrarily rotated/moved by grabs.
- **Hands connect asynchronously.** three.js populates `renderer.xr.getHand(i)`'s joint children only after an input source with a `hand` appears, so `HandRig` (re)builds its rig on the hand group's `connected` event.
- **`window.__cubeDebug`/`__renderer`/`__camera`/`__desktop` hooks** are exposed at the end of `main.ts` solely for the automated tests; harmless in production.

## Testing on a real headset

- **Same Wi-Fi, plain HTTP (default, easiest):** `bun run dev` (or `bun run dev:host`) and open **`http://<your-lan-ip>:5173`** in the Quest 2 browser. No cert warnings, no setup. Caveat: over HTTP from a non-localhost origin the browser is **not** a secure context, so WebXR (`navigator.xr`) may be unavailable — you'll still see the full desktop 3D view (drag faces, orbit, scramble), just no "Enter AR/VR" buttons.
- **WebXR from the headset (needs a secure context):** pick one —
  1. **`adb reverse`** — with the Quest connected over USB, run `adb reverse tcp:5173 tcp:5173`, then open `http://localhost:5173` on the Quest. `localhost` is a secure context, so WebXR works over plain HTTP.
  2. **HTTPS variant** — `bun run dev:https` (self-signed cert via `@vitejs/plugin-basic-ssl`), then open `https://<your-lan-ip>:5173` and make the headset trust the cert (most headset browsers won't accept self-signed certs for WebXR without it).
  3. **Tunnel with a real cert** — e.g. `cloudflared tunnel --url http://localhost:5173` or `ngrok http http://localhost:5173`, then open the provided HTTPS URL on the Quest. No external service is wired into the project itself; this is only a testing option.
- On a Quest: use the Meta Quest Browser, allow "Hands and Controllers" tracking, and prefer "Enter AR" (passthrough) if you want the cube in your room; otherwise "Enter VR".

## Hosting on GitHub Pages (HTTPS → WebXR works)

The production build uses **relative asset paths** (`base: './'`) and outputs to **`docs/`** (`build.outDir`), so GitHub Pages can serve the built app directly from the `main` branch — no Actions workflow needed. HTTPS is a secure context, so WebXR (hand tracking, AR/VR) works from a headset with no cert hassles.

- Run `bun run build`, commit the resulting `docs/` folder, and push to `main`.
- In **Settings → Pages → Build and deployment → Source**: choose **"Deploy from a branch"**, branch **`main`**, folder **`/docs`**.
- GitHub re-publishes the site on every push to `main` automatically.
- Open `https://<user>.github.io/<repo>/` in the Quest 2 browser.
- A CI workflow (`.github/workflows/ci.yml`) typechecks and builds on every push so the `docs/` output is validated before it's served. (An older artifact-based deploy workflow was replaced by this — the branch `/docs` approach is deterministic and needs no per-run setup.)
- If you host at a custom domain or as a `username.github.io` user site, `base: './'` still resolves correctly (no config change needed).

## Known limitations & suggested next steps

1. **Verify VR on hardware** — pinch thresholds (3.5/5.5 cm), the drag-direction axis picker, the 0.055 m grab radius, the gravity-pull feel, and hand-rig scale all need a real pass on a headset.
2. **Two-handed gestures** — anchor a slice turn with the second hand (per the original spec), and/or use two hands for whole-cube moves (position = hands' midpoint, rotation = relative hand rotation).
3. **Solve animation / solver** — add a Kociemba solver or replay the reverse of `history` as an animated solve instead of an instant Reset.
4. **Real hand models** — replace the sphere/cylinder rig with a nicer procedural hand (e.g. capsules along the joint chains), still no imported assets.
5. **Performance** — merge cubie geometry (`InstancedMesh`) or sticker draw calls if frame time matters on low-end headsets; the scene is currently ~200 draw calls.
6. **AR placement** — use WebXR hit-test to let the user place the cube on a real surface instead of the fixed spawn offset.
7. **Cube feel** — add sound (procedural WebAudio ticks) and a subtle spawn/undo animation; both are out of scope for the current build.
