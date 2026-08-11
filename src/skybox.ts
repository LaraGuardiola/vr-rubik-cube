import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Procedural space skybox — dark nebula clouds + a star field, all generated
// in a fragment shader. No textures, no assets. Used for the desktop backdrop
// and the immersive-VR fallback environment. Hidden during AR passthrough.
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  uniform float uTime;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash(i);
    float n100 = hash(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = p * 2.03 + vec3(13.7, 7.1, 3.9);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vWorldPos);

    // soft nebula clouds
    float n1 = fbm(dir * 1.4 + vec3(0.0, 0.0, uTime * 0.004));
    float n2 = fbm(dir * 3.2 - vec3(uTime * 0.002, 0.0, 0.0));
    float nebula = n1 * 0.6 + n2 * 0.4;

    // a subtle "galactic band"
    float band = pow(abs(dot(dir, normalize(vec3(0.35, 0.18, 0.9)))), 2.2);
    nebula += band * 0.35;

    vec3 cDeep  = vec3(0.008, 0.012, 0.028);
    vec3 cBlue  = vec3(0.05, 0.06, 0.16);
    vec3 cPurple = vec3(0.13, 0.05, 0.22);
    vec3 cTeal  = vec3(0.04, 0.11, 0.13);
    vec3 cWarm  = vec3(0.16, 0.09, 0.06);

    vec3 col = cDeep;
    col = mix(col, cBlue, smoothstep(0.35, 0.85, nebula));
    col += cPurple * smoothstep(0.55, 0.95, n2) * 0.8;
    col += cTeal * smoothstep(0.6, 1.0, n1 * band) * 0.6;
    col += cWarm * smoothstep(0.7, 1.0, n1 * n2) * 0.4;

    // star field
    vec3 sd = dir * 320.0;
    vec3 cell = floor(sd);
    vec3 f = fract(sd);
    float starHash = hash(cell);
    float star = 0.0;
    if (starHash > 0.995) {
      vec3 center = vec3(0.5);
      float d = distance(f, center);
      star = smoothstep(0.045, 0.0, d);
      float twinkle = 0.75 + 0.25 * sin(uTime * (1.5 + starHash * 8.0) + starHash * 40.0);
      star *= twinkle;
      // occasional colored stars
      vec3 starCol = mix(vec3(1.0), vec3(0.7, 0.85, 1.0), starHash * 0.6);
      col += star * starCol * (2.0 + 6.0 * pow(starHash, 40.0));
    }

    // faint distant star dust
    col += hash(cell + 17.0) * smoothstep(0.0, 0.6, hash(cell)) * 0.012;

    // gentle falloff toward the horizon for depth
    float up = clamp(dir.y + 0.4, 0.0, 1.0);
    col = mix(col * 0.35, col, up);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class NebulaSkybox extends THREE.Mesh {
  private shaderMaterial: THREE.ShaderMaterial;

  constructor() {
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: { value: 0 } },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    super(new THREE.SphereGeometry(60, 48, 32), material);
    this.shaderMaterial = material;
    this.renderOrder = -10;
    this.frustumCulled = false;
  }

  update(time: number): void {
    this.shaderMaterial.uniforms.uTime.value = time;
  }
}
