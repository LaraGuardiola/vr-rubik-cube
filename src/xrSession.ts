import * as THREE from 'three';

// ---------------------------------------------------------------------------
// WebXR session management.
//
// Prefers an AR session (immersive-ar, passthrough) when the device supports
// it, otherwise immersive VR with the procedural nebula skybox. Provides a
// small on-screen button per supported mode — the spec mentioned three.js's
// VRButton/ARButton, but those use inline styles that fight the HUD, so we
// implement equivalent buttons here (same request flow, plus 'hand-tracking').
// ---------------------------------------------------------------------------

export interface XRSessionEvents {
  onSessionStart?: (session: XRSession, mode: 'ar' | 'vr') => void;
  onSessionEnd?: () => void;
  onError?: (err: unknown) => void;
}

let currentSession: XRSession | null = null;

export async function setupXRButtons(
  renderer: THREE.WebGLRenderer,
  events: XRSessionEvents,
): Promise<{ arSupported: boolean; vrSupported: boolean }> {
  const container = document.getElementById('xrButtons');
  const nav = navigator as Navigator & { xr?: XRSystem };
  if (container === null || nav.xr === undefined) {
    return { arSupported: false, vrSupported: false };
  }

  const [arSupported, vrSupported] = await Promise.all([
    nav.xr.isSessionSupported('immersive-ar').catch(() => false),
    nav.xr.isSessionSupported('immersive-vr').catch(() => false),
  ]);

  if (!arSupported && !vrSupported) {
    const note = document.createElement('div');
    note.className = 'xr-btn';
    note.textContent = 'WebXR not supported';
    note.style.opacity = '0.6';
    note.style.pointerEvents = 'none';
    container.appendChild(note);
    return { arSupported: false, vrSupported: false };
  }

  const createButton = (label: string, mode: 'immersive-ar' | 'immersive-vr'): void => {
    const button = document.createElement('button');
    button.className = 'xr-btn';
    button.textContent = label;
    button.onclick = () => void toggle(renderer, mode, button, events);
    container.appendChild(button);
  };

  // AR first if available, VR as a secondary option.
  if (arSupported) createButton('Enter AR', 'immersive-ar');
  if (vrSupported) createButton('Enter VR', 'immersive-vr');

  return { arSupported, vrSupported };
}

async function toggle(
  renderer: THREE.WebGLRenderer,
  mode: 'immersive-ar' | 'immersive-vr',
  button: HTMLButtonElement,
  events: XRSessionEvents,
): Promise<void> {
  if (currentSession !== null) {
    await currentSession.end();
    return;
  }
  const nav = navigator as Navigator & { xr?: XRSystem };
  if (nav.xr === undefined) return;
  try {
    const session = await nav.xr.requestSession(mode, {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
    });
    currentSession = session;
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    button.textContent = mode === 'immersive-ar' ? 'Exit AR' : 'Exit VR';
    session.addEventListener('end', () => {
      currentSession = null;
      button.textContent = mode === 'immersive-ar' ? 'Enter AR' : 'Enter VR';
      events.onSessionEnd?.();
    });
    events.onSessionStart?.(session, mode === 'immersive-ar' ? 'ar' : 'vr');
  } catch (err) {
    currentSession = null;
    events.onError?.(err);
  }
}
