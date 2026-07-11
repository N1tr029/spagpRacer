import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import trackData from './track.json';
import forestData from './forest.json';

// base-relative asset root, so /public files resolve whether the game is served
// from a domain root or a subpath (e.g. GitHub Pages /spagpRacer/)
const ASSET = import.meta.env.BASE_URL;

// touch device? drives the on-screen controls + a lighter render for phones
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

// graphics quality (Low avoids the heavy passes so phones don't crash):
//   low    = direct render, no post/env/shadows/mirror, 1x pixels
//   medium = bloom + colour grade + env + shadows (no SMAA, no mirror)
//   high   = everything (+ SMAA anti-aliasing + rear-view mirror)
const QUALITY = localStorage.getItem('ardennes.quality') || (IS_TOUCH ? 'low' : 'high');
const USE_POST = QUALITY !== 'low', USE_SMAA = QUALITY === 'high', USE_REAR = QUALITY === 'high', USE_SHADOW = QUALITY !== 'low';

// real OSM forest extent around Spa (landuse=forest), rasterised to a grid in
// game coordinates — trees only grow where there's actually forest, so La Source
// and the pit straight stay open while Kemmel/Blanchimont are tree-lined
const FMASK = (() => { const b = atob(forestData.mask); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; })();
const isForest = (x, z) => {
  const c = ((x - forestData.minX) / forestData.cell) | 0, r = ((z - forestData.minZ) / forestData.cell) | 0;
  return c >= 0 && c < forestData.cols && r >= 0 && r < forestData.rows && FMASK[r * forestData.cols + c] === 1;
};

// ---------------------------------------------------------------------------
// Track data: real Spa-Francorchamps centerline (OpenStreetMap, ODbL) with
// real elevation, resampled every 4 m. Index 0 = start/finish line.
// ---------------------------------------------------------------------------
const PTS = trackData.points;          // [x, y, z] meters
const CURV = trackData.curv;           // signed curvature per point
const CORNERS = trackData.corners;     // { name, i }
const N = PTS.length;
const STEP = trackData.step;
const TRACK_LEN = trackData.total;
const HALF_W = 6.5;                    // track half-width (m)
const KERB_W = 1.4;

const P = i => PTS[((i % N) + N) % N];
const C = i => CURV[((i % N) + N) % N];

// allowed-speed profile for brake assist: corner speed cap + backward pass
// so the assist knows braking points, not just apex speeds
// calibrated to F1 25's braking-zone speeds (read off the reference lap): a
// downforce-aware grip model (base ~2.5 lateral g + speed downforce) instead of
// a flat ~1.2 g, so corners carry realistic speed and braking starts late.
const V_ALLOW = new Float32Array(N);
const VA_MU = 2.5, VA_DFK = 0.00035, VA_CAP = 94;
const vAllowAt = R => { const den = 1 - VA_MU * R * VA_DFK; return den > 0.06 ? Math.min(VA_CAP, Math.sqrt(VA_MU * R * 9.81 / den)) : VA_CAP; };
{
  for (let i = 0; i < N; i++) V_ALLOW[i] = vAllowAt(Math.abs(CURV[i]) > 1e-5 ? 1 / Math.abs(CURV[i]) : 9999);
  for (let pass = 0; pass < 3; pass++)
    for (let i = N - 1; i >= 0; i--)
      V_ALLOW[i] = Math.min(V_ALLOW[i], Math.sqrt(V_ALLOW[(i + 1) % N] ** 2 + 2 * 42 * STEP));   // ~4.3 g braking
}

// variable track half-width: broaden the OUTSIDE of tight corners (like the real
// wide La Source) so the car has room; the inside stays at the kerb so no edge
// folds. HWp/HWm = half-width toward +normal / -normal.
const HWp = new Float32Array(N).fill(HALF_W);
const HWm = new Float32Array(N).fill(HALF_W);
for (let i = 0; i < N; i++) {
  const c = CURV[i], r = Math.abs(c) > 1e-5 ? 1 / Math.abs(c) : 9999;
  if (r < 45) {
    const extra = Math.min(5, (45 - r) / 45 * 9);
    if (c > 0) HWm[i] = HALF_W + extra;   // inside is +normal -> widen the -normal (outside) edge
    else HWp[i] = HALF_W + extra;
  }
}
for (let pass = 0; pass < 12; pass++) {
  const op = HWp.slice(), om = HWm.slice();
  for (let i = 0; i < N; i++) {
    HWp[i] = 0.5 * op[i] + 0.25 * op[(i - 1 + N) % N] + 0.25 * op[(i + 1) % N];
    HWm[i] = 0.5 * om[i] + 0.25 * om[(i - 1 + N) % N] + 0.25 * om[(i + 1) % N];
  }
}
// a wider corner gives a bigger racing-line radius -> allow more speed through it
for (let i = 0; i < N; i++) {
  const extra = Math.max(HWp[i], HWm[i]) - HALF_W;
  if (extra > 0.3) {
    const R = Math.abs(CURV[i]) > 1e-5 ? 1 / Math.abs(CURV[i]) : 9999;
    V_ALLOW[i] = vAllowAt(R + extra * 1.2);
  }
}
for (let pass = 0; pass < 3; pass++)
  for (let i = N - 1; i >= 0; i--)
    V_ALLOW[i] = Math.min(V_ALLOW[i], Math.sqrt(V_ALLOW[(i + 1) % N] ** 2 + 2 * 42 * STEP));

// Tangents and left-normals (xz plane), smoothed
const tangents = [], normals = [];
for (let i = 0; i < N; i++) {
  const a = P(i - 2), b = P(i + 2);
  let tx = b[0] - a[0], tz = b[2] - a[2];
  const l = Math.hypot(tx, tz) || 1;
  tx /= l; tz /= l;
  tangents.push([tx, tz]);
  normals.push([-tz, tx]); // left of travel direction
}

// ---------------------------------------------------------------------------
// Pit lane: a spline that branches off the start/finish straight just after
// the Bus Stop chicane, runs down the left (+normal — the pit-building side)
// past the garage boxes, and merges back before La Source. Its index range
// wraps through the start/finish line (index 0). It shares the track's world
// space, so the car physics drives it for real; a locator maps a world point
// to pit progress + lateral offset from the lane centre.
// ---------------------------------------------------------------------------
const PIT_IN_I = 1660;          // entry — just after the Bus Stop chicane (1647)
const PIT_OUT_I = 40;           // exit  — back onto the S/F straight before La Source (60)
const PIT_OFF = 15.5;           // lane centre offset from the track centre (m, left)
const PIT_HW = 2.4;             // pit-lane half width (m)
const PIT_LIMIT = 80 / 3.6;     // pit speed limit — 80 km/h
const PIT_TAPER = 16;           // nodes over which the lane blends on/off the track

const pitIdx = [];
for (let i = PIT_IN_I; ; i = (i + 1) % N) { pitIdx.push(i); if (i === PIT_OUT_I) break; }
const PIT_NN = pitIdx.length;
const pitSmooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// lateral offset of the lane centre at pit node k: 0 at the tapered ends,
// PIT_OFF across the middle where the garages sit
const pitLatAt = k => PIT_OFF * Math.min(pitSmooth(k / PIT_TAPER), pitSmooth((PIT_NN - 1 - k) / PIT_TAPER));
// world polyline of the lane centre, with cumulative length in .s
const pitPath = pitIdx.map((i, k) => {
  const lat = pitLatAt(k), p = P(i), n = normals[i];
  return { i, k, lat, x: p[0] + n[0] * lat, y: p[1], z: p[2] + n[1] * lat, s: 0 };
});
for (let k = 1; k < PIT_NN; k++)
  pitPath[k].s = pitPath[k - 1].s + Math.hypot(pitPath[k].x - pitPath[k - 1].x, pitPath[k].z - pitPath[k - 1].z);
const PIT_LEN = pitPath[PIT_NN - 1].s;
// reverse map track index -> pit node (for seeding the locator's search)
const pitKofTrack = new Int16Array(N).fill(-1);
pitIdx.forEach((i, k) => { if (pitKofTrack[i] < 0) pitKofTrack[i] = k; });

// nearest lane-centre node to a world point (windowed around a hint), with the
// signed lateral offset from the lane centre (measured along the track normal)
function pitInfo(x, z, hintK) {
  const c = ((hintK | 0) % PIT_NN + PIT_NN) % PIT_NN;
  let bk = c, bd = 1e18;
  for (let d = -26; d <= 26; d++) {
    const k = ((c + d) % PIT_NN + PIT_NN) % PIT_NN;
    const nd = (pitPath[k].x - x) ** 2 + (pitPath[k].z - z) ** 2;
    if (nd < bd) { bd = nd; bk = k; }
  }
  const node = pitPath[bk], n = normals[node.i];
  const lat = (x - node.x) * n[0] + (z - node.z) * n[1];
  return { k: bk, i: node.i, lat, dist: Math.sqrt(bd), s: node.s, laneLat: node.lat };
}

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY === 'low' ? 1 : QUALITY === 'medium' ? 1.5 : (IS_TOUCH ? 1.6 : 2)));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = USE_SHADOW;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;   // softer, less aliased contact shadows
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;                // a touch darker; bloom adds the glow back
const app = document.getElementById('app');
app.innerHTML = ''; // drop any canvas from a previous module instance (HMR)
app.appendChild(renderer.domElement);
window.__gen = (window.__gen || 0) + 1;
const GEN = window.__gen; // stale render loops check this and stop

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6ea6e6);           // richer Ardennes-summer blue
scene.fog = new THREE.Fog(0x9dc0e6, 550, 4200);        // lighter haze, pushed back

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.3, 6000);

const hemi = new THREE.HemisphereLight(0xd8e8ff, 0x42603a, 0.6);   // lower: the env map now adds ambient fill
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe7bd, 2.15);
sun.position.set(-350, 500, 200);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 50; sun.shadow.camera.far = 1400;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;   // kill shadow acne / peter-panning
const sc = 120;
sun.shadow.camera.left = -sc; sun.shadow.camera.right = sc;
sun.shadow.camera.top = sc; sun.shadow.camera.bottom = -sc;
scene.add(sun); scene.add(sun.target);

// Post-processing: a filmic bloom for sky/sun/kerb glow, then tone-map + sRGB.
// A soft depth-vignette darkens the frame edges the way a broadcast lens does.
let composer = null;
if (USE_POST) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.7, 0.82));
  composer.addPass(new OutputPass());
  if (USE_SMAA) composer.addPass(new SMAAPass(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio()));
  // colour grade: gentle contrast + saturation + broadcast vignette, applied to
  // the tone-mapped image. This is what pulls the Ardennes greens out of the wash.
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null }, contrast: { value: 1.11 }, saturation: { value: 1.22 }, vignette: { value: 0.85 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float contrast, saturation, vignette; varying vec2 vUv;
      void main(){
        vec4 c = texture2D(tDiffuse, vUv); vec3 col = c.rgb;
        col = (col - 0.5) * contrast + 0.5;
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, saturation);
        vec2 uv = vUv - 0.5;
        col *= clamp(1.0 - vignette * dot(uv, uv), 0.0, 1.0);
        gl_FragColor = vec4(col, c.a);
      }`,
  }));
}

// Image-based lighting: a gradient sky/ground env so the glossy car body
// catches real sky reflections (and everything gets softer ambient fill)
if (USE_POST) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const es = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 24, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { top: { value: new THREE.Color(0x3f7fce) }, mid: { value: new THREE.Color(0xc2d8ec) }, bot: { value: new THREE.Color(0x69804f) } },
    vertexShader: 'varying vec3 vp; void main(){ vp = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec3 vp; uniform vec3 top, mid, bot; void main(){ float h = normalize(vp).y; vec3 c = h > 0.0 ? mix(mid, top, h) : mix(mid, bot, -h); gl_FragColor = vec4(c, 1.0); }',
  }));
  es.add(sky);
  scene.environment = pmrem.fromScene(es).texture;
  sky.geometry.dispose(); sky.material.dispose(); pmrem.dispose();
}

// ---------------------------------------------------------------------------
// Rear-view mirror: render the view behind the car into an offscreen target,
// then draw it into a strip up top flipped left-right, like a real mirror
// ---------------------------------------------------------------------------
const RVW = 640, RVH = 180;
let rearRT, rearCam, rvScene, rvCam, rearOn = true;
if (USE_REAR) {
  rearRT = new THREE.WebGLRenderTarget(RVW, RVH, { samples: 4 });
  rearRT.texture.colorSpace = THREE.SRGBColorSpace;
  rearCam = new THREE.PerspectiveCamera(64, RVW / RVH, 0.3, 2200);
  rvScene = new THREE.Scene();
  rvCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2); rvCam.position.z = 1;
  const rvQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ map: rearRT.texture, depthTest: false, depthWrite: false, toneMapped: false }));
  { const uv = rvQuad.geometry.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); uv.needsUpdate = true; }  // flip U = mirror
  rvScene.add(rvQuad);
}
const _rvEye = new THREE.Vector3(), _rvLook = new THREE.Vector3();
function renderRearView() {
  if (!USE_REAR) return;
  const el = document.getElementById('rearview');
  const show = rearOn && sess.mode !== 'menu' && !podiumActive && !state.pitFrozen
    && !(sess.mode === 'race' && sess.phase === 'lights');
  if (!show) { el.classList.remove('show'); return; }
  el.classList.add('show');
  car.updateMatrixWorld(true);
  _rvEye.set(0, 1.85, -0.2).applyMatrix4(car.matrixWorld);      // above/behind the cockpit
  _rvLook.set(0, 1.05, -32).applyMatrix4(car.matrixWorld);      // ~32 m back, angled down
  rearCam.position.copy(_rvEye); rearCam.up.set(0, 1, 0); rearCam.lookAt(_rvLook);
  renderer.setRenderTarget(rearRT); renderer.clear(); renderer.render(scene, rearCam); renderer.setRenderTarget(null);
  const w = innerWidth, h = innerHeight;
  const sw = Math.min(460, w * 0.42), sh = sw * RVH / RVW, sx = (w - sw) / 2, sy = h - sh - 54;
  renderer.autoClear = false;
  renderer.setViewport(sx, sy, sw, sh); renderer.setScissor(sx, sy, sw, sh); renderer.setScissorTest(true);
  renderer.render(rvScene, rvCam);
  renderer.setScissorTest(false); renderer.setViewport(0, 0, w, h); renderer.autoClear = true;
}

// Soft cloud billboards for sky depth (sprites always face the camera)
{
  const cc = document.createElement('canvas'); cc.width = 256; cc.height = 128;
  const x2 = cc.getContext('2d');
  for (const [bx, by, r] of [[128, 78, 56], [82, 84, 40], [174, 84, 40], [110, 62, 34], [150, 64, 34], [128, 90, 48]]) {
    const grd = x2.createRadialGradient(bx, by, 4, bx, by, r);
    // off-white and dim so the bloom pass reads them as soft cloud, not glare
    grd.addColorStop(0, 'rgba(236,242,250,0.62)'); grd.addColorStop(0.55, 'rgba(236,242,250,0.26)'); grd.addColorStop(1, 'rgba(236,242,250,0)');
    x2.fillStyle = grd; x2.beginPath(); x2.arc(bx, by, r, 0, 7); x2.fill();
  }
  const cloudTex = new THREE.CanvasTexture(cc);
  let mnX = 1e9, mxX = -1e9, mnZ = 1e9, mxZ = -1e9;
  for (const p of PTS) { mnX = Math.min(mnX, p[0]); mxX = Math.max(mxX, p[0]); mnZ = Math.min(mnZ, p[2]); mxZ = Math.max(mxZ, p[2]); }
  const cxc = (mnX + mxX) / 2, czc = (mnZ + mxZ) / 2, spanX = mxX - mnX + 3000, spanZ = mxZ - mnZ + 3000;
  let cs = 987654; const crand = () => (cs = (cs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 16; i++) {
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.7, depthWrite: false, fog: false }));
    const sc = 340 + crand() * 420;
    spr.scale.set(sc * 2.2, sc, 1);
    spr.position.set(cxc + (crand() - 0.5) * spanX, 520 + crand() * 320, czc + (crand() - 0.5) * spanZ);
    scene.add(spr);
  }
}

// ---------------------------------------------------------------------------
// Track surface mesh
// ---------------------------------------------------------------------------
function buildRibbon(offA, offB, yLift, colorFn) {
  // offA/offB: functions(i) -> lateral offset (m, +left)
  const pos = [], col = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const p = P(i), n = normals[i % N];
    const oa = offA(i % N), ob = offB(i % N);
    pos.push(p[0] + n[0] * oa, p[1] + yLift, p[2] + n[1] * oa);
    pos.push(p[0] + n[0] * ob, p[1] + yLift, p[2] + n[1] * ob);
    const c = colorFn(i % N);
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    if (i < N) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); // wound so faces point up
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 }));
  m.receiveShadow = true;
  return m;
}

// asphalt with subtle per-segment tone variation
const asphaltTone = [];
{
  let t = 0;
  for (let i = 0; i < N; i++) { t = t * 0.92 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.08; asphaltTone.push(t); }
}

// optional real surface textures (drop your own into /public/textures);
// if a file is missing the painted vertex-color look stays
const texLoader = new THREE.TextureLoader();
function surfaceTex(url, onload) {
  texLoader.load(url, t => {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    onload(t);
  }, undefined, () => {});
}
// per-vertex UVs for a ribbon built by buildRibbon (2 verts per step).
// uStart/uEnd sample a horizontal band of the texture — insetting past the
// baked white edge lines keeps the whole ribbon uniform tarmac.
function addRibbonUVs(mesh, uStart, uEnd, vMeters) {
  const count = mesh.geometry.attributes.position.count;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i <= N; i++) {
    uv[i * 4 + 0] = uStart; uv[i * 4 + 1] = i * STEP / vMeters;
    uv[i * 4 + 2] = uEnd;   uv[i * 4 + 3] = i * STEP / vMeters;
  }
  mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
{
  const road = buildRibbon(i => HWp[i], i => -HWm[i], 0, i => {
    const v = 0.155 + asphaltTone[i] * 0.05;
    return { r: v, g: v, b: v + 0.008 };
  });
  // sample only the clean asphalt band (0.20–0.80), skipping the texture's
  // baked-in white edge lines so the whole surface reads as uniform tar
  addRibbonUVs(road, 0.20, 0.80, 9);
  surfaceTex(ASSET + 'textures/road.png', t => {
    // dark tint pulls the medium-grey photo asphalt toward real charcoal tar
    road.material = new THREE.MeshStandardMaterial({ map: t, color: 0x5f6469, roughness: 0.97 });
  });
  scene.add(road);
}

// (racing groove removed — the road stays one uniform tarmac tone)

// racing line driving aid: follows the computed out-in-out line, colored
// green (flat out) / yellow (cornering) / red (braking zone). Toggle: L
const RACE = trackData.race, RACECOL = trackData.raceCol;
const raceLine = buildRibbon(
  i => RACE[i] + 0.30,
  i => RACE[i] - 0.30,
  0.018,
  i => RACECOL[i] === 2 ? { r: 0.85, g: 0.10, b: 0.08 }
     : RACECOL[i] === 1 ? { r: 0.95, g: 0.72, b: 0.08 }
     : { r: 0.10, g: 0.70, b: 0.22 });
raceLine.material.transparent = true;
raceLine.material.opacity = 0.85;
scene.add(raceLine);
raceLine.visible = false;   // off by default — the broadcast has no green line (toggle: L)

// Skidmarks: rubbered-in racing line that DARKENS the tarmac (near-black,
// per-vertex alpha), widest + heaviest through braking zones and corners
{
  const pos = [], col = [], idx = []; let vi = 0;
  for (let i = 0; i <= N; i++) {
    const ii = i % N, p = P(ii), n = normals[ii], lat = RACE[ii];
    const brake = Math.min(1, Math.max(0, V_ALLOW[ii] - V_ALLOW[(ii + 3) % N]) * 0.5);
    const corner = Math.min(1, Math.abs(CURV[ii]) * 30);
    const heat = Math.min(1, 0.25 + brake * 0.7 + corner * 0.6);
    const w = 0.85 + heat * 0.95;               // wider band where the rubber builds up
    const a = 0.16 + heat * 0.4;                // more opaque (darker) with more heat
    pos.push(p[0] + n[0] * (lat - w), p[1] + 0.04, p[2] + n[1] * (lat - w));
    pos.push(p[0] + n[0] * (lat + w), p[1] + 0.04, p[2] + n[1] * (lat + w));
    col.push(0, 0, 0, a, 0, 0, 0, a);           // black with per-vertex alpha (RGBA)
    if (i < N) idx.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3);
    vi += 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));   // 4-component = per-vertex alpha
  geo.setIndex(idx);
  const skid = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0x000000, vertexColors: true, transparent: true, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  }));
  skid.renderOrder = 1;
  scene.add(skid);
}

// (white edge lines removed — track reads as uniform tarmac to the kerbs)

// kerbs on corners (red/white stripes), placed where curvature is significant
const KERB_THRESH = 0.0045;
function kerbColor(i) {
  // Spa's signature red/yellow kerbing
  return (Math.floor(i / 2) % 2 === 0) ? { r: 0.86, g: 0.11, b: 0.09 } : { r: 0.93, g: 0.74, b: 0.08 };
}
scene.add(buildRibbon(
  i => Math.abs(C(i)) > KERB_THRESH ? HWp[i] + KERB_W : HWp[i] + 0.001,
  i => HWp[i], 0.035, kerbColor));
scene.add(buildRibbon(
  i => -HWm[i],
  i => Math.abs(C(i)) > KERB_THRESH ? -(HWm[i] + KERB_W) : -(HWm[i] + 0.001), 0.035, kerbColor));

// painted tarmac runoff outside medium/fast corners (asphalt apron + green band)
const RUNOFF = i => {
  const c = Math.abs(C(i));
  return c > 0.0045 && c < 0.022;
};
for (const side of [1, -1]) {
  const hw = i => side > 0 ? HWp[i] : HWm[i];
  scene.add(buildRibbon(
    i => side * (RUNOFF(i) ? hw(i) + KERB_W + 4.5 : hw(i) + KERB_W + 0.001),
    i => side * (hw(i) + KERB_W),
    0.02,
    i => { const v = 0.15 + asphaltTone[i] * 0.03; return { r: v, g: v, b: v + 0.004 }; }));
  scene.add(buildRibbon(
    i => side * (RUNOFF(i) ? hw(i) + KERB_W + 6.3 : hw(i) + KERB_W + 4.5 + 0.001),
    i => side * (RUNOFF(i) ? hw(i) + KERB_W + 4.5 : hw(i) + KERB_W + 4.5),
    0.02,
    () => ({ r: 0.12, g: 0.42, b: 0.16 })));
}

// grass shoulders: track edge out to ~22 m, sloping down to meet the sunken
// terrain so the road always sits proud of the ground on crests
for (const side of [1, -1]) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const p = P(i % N), n = normals[i % N];
    const inner = side * ((side > 0 ? HWp[i % N] : HWm[i % N]) + 0.001);
    let outer = side * 22;
    // clamp the inside shoulder at tight corners so it can't fold across the track
    const cc = C(i % N);
    if (side * cc > 0.0004) { const mx = 0.82 / Math.abs(cc); if (Math.abs(outer) > mx) outer = Math.sign(outer) * mx; }
    pos.push(p[0] + n[0] * inner, p[1] - 0.03, p[2] + n[1] * inner);
    pos.push(p[0] + n[0] * outer, p[1] - 2.6, p[2] + n[1] * outer);
    uv.push(0, i * STEP / 8, 2.2, i * STEP / 8);
    if (i < N) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x4d7c3c, roughness: 1, side: THREE.DoubleSide });
  surfaceTex(ASSET + 'textures/grass.png', t => {
    shoulderMat.map = t; shoulderMat.color.set(0xffffff); shoulderMat.needsUpdate = true;
  });
  const m = new THREE.Mesh(g, shoulderMat);
  m.receiveShadow = true;
  scene.add(m);
}

// start/finish line (checkered)
{
  const g = new THREE.PlaneGeometry(HALF_W * 2, 4, 16, 4);
  const cnv = document.createElement('canvas'); cnv.width = 128; cnv.height = 32;
  const ctx = cnv.getContext('2d');
  for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) {
    ctx.fillStyle = (x + y) % 2 ? '#e8e8e8' : '#111';
    ctx.fillRect(x * 8, y * 8, 8, 8);
  }
  const tex = new THREE.CanvasTexture(cnv);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  const p = P(0), t = tangents[0];
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = -Math.atan2(t[1], t[0]);
  m.position.set(p[0], p[1] + 0.02, p[2]);
  scene.add(m);

  // gantry
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.6 });
  const n = normals[0];
  for (const s of [-1, 1]) {
    const pil = new THREE.Mesh(new THREE.BoxGeometry(0.5, 8, 0.5), mat);
    pil.position.set(p[0] + n[0] * s * (HALF_W + 2), p[1] + 4, p[2] + n[1] * s * (HALF_W + 2));
    pil.castShadow = true; scene.add(pil);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 + 4.5, 1.4, 0.6), new THREE.MeshStandardMaterial({ color: 0xe10600, roughness: 0.5 }));
  beam.rotation.y = -Math.atan2(t[1], t[0]) + Math.PI / 2;
  beam.position.set(p[0], p[1] + 7.6, p[2]);
  beam.castShadow = true; scene.add(beam);
}

// ---------------------------------------------------------------------------
// Terrain (follows track elevation nearby) + forest
// ---------------------------------------------------------------------------
const samples = [];
for (let i = 0; i < N; i += 8) samples.push(P(i));
function terrainHeight(x, z) {
  let best = 1e18, by = 0, second = 1e18, sy = 0;
  for (const s of samples) {
    const d = (s[0] - x) ** 2 + (s[2] - z) ** 2;
    if (d < best) { second = best; sy = by; best = d; by = s[1]; }
    else if (d < second) { second = d; sy = s[1]; }
  }
  const y = (by * 2 + sy) / 3;
  const dist = Math.sqrt(best);
  // sink terrain near the track so the coarse mesh never pokes through the
  // road on crests; grass shoulder ribbons cover the seam
  const nearDrop = 2.6 * Math.max(0, 1 - dist / 50);
  return y - 0.4 - nearDrop - Math.min(dist * 0.02, 6) + Math.sin(x * 0.008) * Math.cos(z * 0.011) * Math.min(dist * 0.04, 5);
}
{
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of PTS) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]); }
  const pad = 600, res = 28;
  const nx = Math.ceil((maxX - minX + pad * 2) / res), nz = Math.ceil((maxZ - minZ + pad * 2) / res);
  const g = new THREE.PlaneGeometry(nx * res, nz * res, nx, nz);
  g.rotateX(-Math.PI / 2);
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const posA = g.attributes.position;
  const colA = new Float32Array(posA.count * 3);
  for (let i = 0; i < posA.count; i++) {
    const x = posA.getX(i) + cx, z = posA.getZ(i) + cz;
    posA.setY(i, terrainHeight(x, z));
    const gr = 0.28 + ((Math.sin(x * 0.05) * Math.cos(z * 0.07) + 1) / 2) * 0.10;
    colA[i * 3] = gr * 0.45; colA[i * 3 + 1] = gr; colA[i * 3 + 2] = gr * 0.35;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colA, 3));
  g.computeVertexNormals();
  const terrMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  surfaceTex(ASSET + 'textures/grass.png', t => {
    t.repeat.set(320, 320);
    terrMat.map = t; terrMat.vertexColors = false; terrMat.color.set(0x83a257); terrMat.needsUpdate = true;   // richer Ardennes green
  });
  const terr = new THREE.Mesh(g, terrMat);
  terr.position.set(cx, 0, cz);
  terr.receiveShadow = true;
  scene.add(terr);

  // Ardennes forest — dense crossed-quad billboard trees (cheap; read as walls)
  const treeTex = (kind) => {
    const c = document.createElement('canvas'); c.width = 128; c.height = 160;
    const x = c.getContext('2d'); x.clearRect(0, 0, 128, 160);
    x.fillStyle = '#3f3123'; x.fillRect(58, 130, 12, 30);            // trunk
    const blob = (bx, by, r, col) => { x.fillStyle = col; x.beginPath(); x.arc(bx, by, r, 0, 7); x.fill(); };
    if (kind === 'pine') {
      // full conical spruce — wide overlapping tiers
      const g = ['#173620', '#1f4429', '#285534'];
      for (let L = 0; L < 8; L++) {
        const cy = 16 + L * 16, w = 13 + L * 10.5;
        x.fillStyle = g[L % 3];
        x.beginPath(); x.moveTo(64, cy - 26); x.lineTo(64 - w, cy + 14); x.lineTo(64 + w, cy + 14); x.closePath(); x.fill();
      }
      x.globalAlpha = 0.5; x.fillStyle = '#3a6b41';   // sunlit right side
      for (let L = 1; L < 8; L++) { const cy = 16 + L * 16, w = 13 + L * 10.5; x.beginPath(); x.moveTo(64, cy - 26); x.lineTo(64 + w, cy + 14); x.lineTo(64 + w * 0.35, cy + 14); x.closePath(); x.fill(); }
      x.globalAlpha = 1;
    } else {
      // big bushy round canopy — many overlapping blobs for a full silhouette
      for (const [bx, by, r] of [[64, 52, 43], [40, 66, 31], [88, 66, 31], [56, 40, 27], [78, 42, 25],
        [64, 84, 41], [44, 98, 29], [84, 98, 29], [64, 112, 30], [50, 76, 27], [80, 76, 27]]) blob(bx, by, r, '#20492a');
      for (const [bx, by, r] of [[58, 58, 30], [74, 62, 28], [64, 90, 30], [48, 86, 23], [82, 86, 23]]) blob(bx, by, r, '#2c5c34');
      for (const [bx, by, r] of [[52, 44, 21], [64, 62, 22], [46, 74, 16]]) blob(bx, by, r, '#3d7444');   // highlights
    }
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
  };
  const crossGeo = (w, h) => {
    const hw = w / 2, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [-hw, 0, 0, hw, 0, 0, hw, h, 0, -hw, h, 0, 0, 0, -hw, 0, 0, hw, 0, h, hw, 0, h, -hw], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(
      [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    return g;
  };
  const PER = 6000;
  const forest = [
    { m: new THREE.InstancedMesh(crossGeo(9, 15), new THREE.MeshLambertMaterial({ map: treeTex('pine'), alphaTest: 0.5, side: THREE.DoubleSide }), PER), n: 0 },
    { m: new THREE.InstancedMesh(crossGeo(11, 12), new THREE.MeshLambertMaterial({ map: treeTex('leaf'), alphaTest: 0.5, side: THREE.DoubleSide }), PER), n: 0 },
  ];
  const dummy = new THREE.Object3D();
  let placed = 0, tries = 0, seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  // keep the forest out of the pit complex (apron / garages on the pit side)
  const pitKeepOut = [];
  for (let k = 2; k < PIT_NN - 2; k += 2) {
    const nd = pitPath[k], n = normals[nd.i], p = P(nd.i);
    pitKeepOut.push([p[0] + n[0] * 19, p[2] + n[1] * 19]);
  }
  const inPitZone = (x, z) => {
    for (const q of pitKeepOut) if ((q[0] - x) ** 2 + (q[1] - z) ** 2 < 24 * 24) return true;
    return false;
  };
  // clear the forest where grandstands stand, so they aren't buried behind trees
  const standZones = (trackData.stands || []).map(st => [st.x, st.z, (Math.max(st.len, st.wid || 30) * 0.6 + 26) ** 2]);
  const inStandZone = (x, z) => { for (const q of standZones) if ((q[0] - x) ** 2 + (q[1] - z) ** 2 < q[2]) return true; return false; };
  // walk the track dropping several trees per point on each side, biased to pack
  // a dense wall just behind the barriers and thin into the distance
  for (let i = 0; i < N && placed < PER * 2; i++) {
    const p = P(i), n = normals[i], tg = tangents[i];
    for (let rep = 0; rep < 14; rep++) {
      const side = rand() < 0.5 ? 1 : -1;
      const off = side * (17 + rand() * rand() * 145);   // packed just behind the barrier, thinning out
      const along = (rand() - 0.5) * STEP * 3;
      const x = p[0] + n[0] * off + tg[0] * along;
      const z = p[2] + n[1] * off + tg[1] * along;
      if (!isForest(x, z)) continue;                     // only where the real OSM forest is
      if (inPitZone(x, z) || inStandZone(x, z)) continue;
      let dmin = 1e18;
      for (const smp of samples) { const dd = (smp[0] - x) ** 2 + (smp[2] - z) ** 2; if (dd < dmin) dmin = dd; }
      if (dmin < 289) continue;          // 17 m — never drop a tree on any stretch of track
      const ft = forest[rand() < 0.5 ? 0 : 1];
      if (ft.n >= PER) continue;
      const y = terrainHeight(x, z), s = 0.85 + rand() * 0.8;
      dummy.position.set(x, y, z); dummy.scale.set(s, s, s); dummy.rotation.y = rand() * 6.28;
      dummy.updateMatrix(); ft.m.setMatrixAt(ft.n++, dummy.matrix);
      placed++;
    }
  }
  forest.forEach(ft => { ft.m.count = ft.n; ft.m.castShadow = false; scene.add(ft.m); });
}

// ---------------------------------------------------------------------------
// Trackside furniture: marshal posts at every corner + stacked-tyre barriers
// in front of the armco at the tighter corners
// ---------------------------------------------------------------------------
{
  const orange = new THREE.MeshStandardMaterial({ color: 0xff7a00, roughness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.85 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xcf9b6f, roughness: 0.75 });
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.6, metalness: 0.3 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf4c60b, roughness: 0.6 });
  const headG = new THREE.SphereGeometry(0.16, 8, 6), tyreG = new THREE.CylinderGeometry(0.45, 0.45, 0.3, 12);
  const add = (geo, mat, x, y, z, ry) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); if (ry) m.rotation.y = ry; m.castShadow = true; scene.add(m); return m; };
  for (const c of CORNERS) {
    const i = c.i, p = P(i), n = normals[i];
    const side = Math.abs(CURV[i]) > 1e-4 ? -Math.sign(CURV[i]) : 1;   // corner outside
    // marshal post: a raised platform + orange marshal + a flag pole, set back behind the barrier
    const off = HWp[i] + 12, bx = p[0] + n[0] * side * off, bz = p[2] + n[1] * side * off, by = Math.max(terrainHeight(bx, bz), p[1] - 1);
    const face = Math.atan2(-n[0] * side, -n[1] * side);   // look toward the track
    add(new THREE.BoxGeometry(1.8, 0.3, 1.8), dark, bx, by + 0.15, bz);
    add(new THREE.BoxGeometry(0.5, 0.9, 0.4), orange, bx, by + 0.75, bz, face);
    add(headG, skin, bx, by + 1.34, bz);
    add(new THREE.CylinderGeometry(0.05, 0.05, 3, 6), poleMat, bx + n[1] * 0.9, by + 1.5, bz - n[0] * 0.9);
    add(new THREE.BoxGeometry(0.02, 0.5, 0.7), yellow, bx + n[1] * 0.9, by + 2.5, bz - n[0] * 0.9, face);
    // tyre-stack barrier in front of the armco at tight corners
    if (Math.abs(CURV[i]) < 0.012) continue;
    for (let d = -5; d <= 5; d++) {
      const j = ((i + d * 3) % N + N) % N, q = P(j), m = normals[j];
      const to = HWp[j] + 8, tx = q[0] + m[0] * side * to, tz = q[2] + m[1] * side * to;
      for (let s = 0; s < 2; s++) add(tyreG, tyreMat, tx, q[1] + 0.15 + s * 0.32, tz);
    }
  }
}

// barriers
// F1-style trackside barrier texture: sponsor hoarding band + catch fence above,
// mapped so the visible (above-ground) part reads hoarding-then-fence
const armcoTex = (() => {
  const cnv = document.createElement('canvas'); cnv.width = 256; cnv.height = 128;
  const ctx = cnv.getContext('2d');
  // buried base (below ground): y 96..128
  ctx.fillStyle = '#2b2f36'; ctx.fillRect(0, 96, 256, 32);
  // sponsor hoarding: y 64..96
  const panels = [['#d4001a', 'PIRELLI'], ['#0a1622', 'F1'], ['#00843d', 'ARAMCO'],
    ['#ffcc00', 'DHL'], ['#004a8f', 'AWS'], ['#12161d', 'EMIRATES']];
  const pw = 256 / panels.length;
  panels.forEach(([col, txt], i) => {
    ctx.fillStyle = col; ctx.fillRect(i * pw, 64, pw, 32);
    ctx.fillStyle = /^#ffc|^#fff|^#ffe/i.test(col) ? '#111' : '#fff';
    ctx.font = 'bold 13px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, i * pw + pw / 2, 81);
  });
  ctx.fillStyle = '#eef2f6'; ctx.fillRect(0, 61, 256, 3);   // white trim
  // catch fence: y 0..61 (grey mesh + posts)
  ctx.fillStyle = '#6a7178'; ctx.fillRect(0, 0, 256, 61);
  ctx.strokeStyle = 'rgba(40,46,54,0.55)'; ctx.lineWidth = 1;
  for (let k = -4; k < 20; k++) {
    ctx.beginPath(); ctx.moveTo(k * 18, 0); ctx.lineTo(k * 18 + 61, 61); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(k * 18, 61); ctx.lineTo(k * 18 + 61, 0); ctx.stroke();
  }
  ctx.strokeStyle = '#484e56'; ctx.lineWidth = 3;
  for (let x = 0; x <= 256; x += 42) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 61); ctx.stroke(); }
  const t = new THREE.CanvasTexture(cnv);
  t.wrapS = THREE.RepeatWrapping;
  return t;
})();
for (const side of [1, -1]) {
  const pos = [], idx = [], uv = [];
  for (let i = 0; i <= N; i++) {
    const ii = i % N;
    const p = P(i), n = normals[ii];
    const baseOff = side * ((side > 0 ? HWp[ii] : HWm[ii]) + 9);
    // on the pit side (+normal), the default barrier would run straight down the
    // pit lane — push it out behind the garages there, tapering at the pit
    // entry/exit so the loop stays continuous
    let off = baseOff;
    if (side === 1 && pitKofTrack[ii] >= 0) {
      const pk = pitKofTrack[ii];
      const blend = pitSmooth(Math.min(pk, PIT_NN - 1 - pk) / PIT_TAPER);
      off = baseOff + blend * (33 - (HALF_W + 9));
    } else {
      // clamp the inside barrier at tight corners so it can't fold across the
      // track (a hairpin whose radius < the 15.5 m offset would cross the centre)
      const c = C(ii);
      if (side * c > 0.0008) { const mx = 0.72 / Math.abs(c); if (Math.abs(off) > mx) off = Math.sign(off) * mx; }
    }
    const x = p[0] + n[0] * off, z = p[2] + n[1] * off;
    const y = p[1] - 1.2; // dip below the shoulder so no gap shows at the base
    pos.push(x, y, z, x, y + 4.8, z); // ~3.6 m stands proud: hoarding + catch fence
    uv.push(i * STEP / 16, 0, i * STEP / 16, 1);
    if (i < N) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const wall = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: armcoTex, roughness: 0.6, metalness: 0.25, side: THREE.DoubleSide }));
  scene.add(wall);
}

// ---------------------------------------------------------------------------
// Trackside furniture: gantries, grandstand, pit building, brake markers
// ---------------------------------------------------------------------------
function bannerTexture(text, bg = '#0b3d1e', fg = '#ffffff') {
  const cnv = document.createElement('canvas'); cnv.width = 512; cnv.height = 64;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 512, 64);
  ctx.fillStyle = fg; ctx.font = 'bold 40px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 34);
  return new THREE.CanvasTexture(cnv);
}
function addGantry(i, text) {
  const p = P(i), t = tangents[i % N], n = normals[i % N];
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.6 });
  for (const s of [-1, 1]) {
    const pil = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7, 0.5), mat);
    pil.position.set(p[0] + n[0] * s * (HALF_W + 2.5), p[1] + 3.5, p[2] + n[1] * s * (HALF_W + 2.5));
    pil.castShadow = true; scene.add(pil);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 + 5.5, 1.3, 0.3),
    new THREE.MeshStandardMaterial({ map: bannerTexture(text), roughness: 0.7 }));
  beam.rotation.y = -Math.atan2(t[1], t[0]) + Math.PI / 2;
  beam.position.set(p[0], p[1] + 6.6, p[2]);
  beam.castShadow = true; scene.add(beam);
}
addGantry(370, 'KEMMEL');
addGantry(1600, 'ARDENNES GP');
addGantry(900, 'ARDENNES GP');

// crowd texture shared by all grandstands
const crowdTex = (() => {
  const cnv = document.createElement('canvas'); cnv.width = 256; cnv.height = 64;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#5a626b'; ctx.fillRect(0, 0, 256, 64);   // light concrete seating
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const cols = ['#e8483a', '#3a9bdc', '#f5d033', '#ffffff', '#33c46a', '#f0842e', '#a457c9', '#ffffff', '#eef2f6'];
  for (let k = 0; k < 2600; k++) {
    ctx.fillStyle = cols[Math.floor(rand() * cols.length)];
    ctx.fillRect(Math.floor(rand() * 256), Math.floor(rand() * 64), 3, 2);
  }
  const t = new THREE.CanvasTexture(cnv);
  t.magFilter = THREE.NearestFilter;
  return t;
})();
const crowdM = new THREE.MeshStandardMaterial({ map: crowdTex, roughness: 1 });
// grandstands at their real mapped positions (OSM building=grandstand
// polygons around the circuit: Tribune F1, Raidillon, Endurance, Silver, …)
const standNear = (x, z) => {
  let b = 1e18;
  for (let i = 0; i < N; i += 4) { const q = P(i); b = Math.min(b, (q[0] - x) ** 2 + (q[2] - z) ** 2); }
  return b;
};
const standStruct = new THREE.MeshStandardMaterial({ color: 0x363c44, roughness: 0.9 });
const standRoof = new THREE.MeshStandardMaterial({ color: 0x565d67, roughness: 0.85 });
const standFascia = new THREE.MeshStandardMaterial({ color: 0xd4001a, roughness: 0.55 });
for (const st of trackData.stands) {
  const len = Math.max(28, Math.min(st.len, 175));
  // perpendicular pointing AWAY from the track — the seating rakes up that way
  let px = -Math.sin(st.ang), pz = Math.cos(st.ang);
  if (standNear(st.x + px * 20, st.z + pz * 20) < standNear(st.x - px * 20, st.z - pz * 20)) { px = -px; pz = -pz; }
  const gY = terrainHeight(st.x, st.z);
  const grp = new THREE.Group();
  grp.position.set(st.x, gY, st.z);
  grp.rotation.y = Math.atan2(px, pz);            // local +Z = away from track
  const tiers = 7, stepBack = 1.8, stepUp = 1.4, D = tiers * stepBack, topY = tiers * stepUp;
  // raked crowd seating (front/low toward the track at -Z, back/high at +Z)
  for (let t = 0; t < tiers; t++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, 1.3, stepBack + 0.3), crowdM);
    m.position.set(0, 0.6 + t * stepUp, -D / 2 + 0.4 + t * stepBack);
    m.castShadow = true; grp.add(m);
  }
  // back wall + side walls
  const back = new THREE.Mesh(new THREE.BoxGeometry(len + 3, topY + 5, 1.2), standStruct);
  back.position.set(0, (topY + 5) / 2, D / 2 + 0.6); back.castShadow = true; grp.add(back);
  for (const sx of [-1, 1]) {
    const sw = new THREE.Mesh(new THREE.BoxGeometry(1, topY + 5, D + 1.2), standStruct);
    sw.position.set(sx * (len / 2 + 0.5), (topY + 5) / 2, 0.3); grp.add(sw);
  }
  // roof canopy cantilevered forward over the seating + red sponsor fascia
  const roofDepth = D * 0.85;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 3, 0.5, roofDepth), standRoof);
  roof.position.set(0, topY + 4.5, D / 2 - roofDepth / 2 + 0.6); roof.castShadow = true; grp.add(roof);
  const fascia = new THREE.Mesh(new THREE.BoxGeometry(len + 3, 1.3, 0.4), standFascia);
  fascia.position.set(0, topY + 4.2, D / 2 - roofDepth + 0.6); grp.add(fascia);
  scene.add(grp);
}
// ---------------------------------------------------------------------------
// Pit complex: fast lane, wall, apron, garages, boxes & lines — all built from
// the pit spline defined near the top. pitBoxes are shared with the pit-stop
// logic below (one box per grid slot; PLAYER_BOX is yours).
// ---------------------------------------------------------------------------
const N_BOX = 9, PLAYER_BOX = 4;
const pitBoxes = [];
{
  const k0 = 46, k1 = 82;   // tight ~18 m box row, centred on the pit straight
  for (let b = 0; b < N_BOX; b++) {
    const k = Math.round(k0 + (k1 - k0) * b / (N_BOX - 1));
    const nd = pitPath[k];
    pitBoxes.push({ b, k, i: nd.i, x: nd.x, y: nd.y, z: nd.z });
  }

  const midA = PIT_TAPER, midB = PIT_NN - PIT_TAPER;   // constant-offset middle
  const pitHead = k => { const t = tangents[pitPath[k].i]; return Math.atan2(t[0], t[1]); };

  // flat paved apron under the whole pit area so nothing floats over the grass
  {
    const pos = [], idx = []; let vi = 0;
    for (let k = midA - 3; k <= midB + 3; k++) {
      const nd = pitPath[k], n = normals[nd.i], p = P(nd.i), y = nd.y + 0.01;
      pos.push(p[0] + n[0] * 8.4, y, p[2] + n[1] * 8.4);
      pos.push(p[0] + n[0] * 31, y, p[2] + n[1] * 31);
      if (k < midB + 3) idx.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3);
      vi += 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const apron = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x878d94, roughness: 0.96 }));
    apron.receiveShadow = true; scene.add(apron);
  }

  // pit-lane surface built off the smooth track normal (consistent width, no
  // taper jitter): dark tarmac, thin clean white edge lines, blue fast lane.
  // oa/ob are offsets added to the lane-centre lateral (nd.lat).
  function pitRibbon(oa, ob, yLift, mat) {
    const pos = [], idx = [];
    for (let k = 0; k < PIT_NN; k++) {
      const nd = pitPath[k], n = normals[nd.i], p = P(nd.i);
      const a = nd.lat + oa, b = nd.lat + ob;
      pos.push(p[0] + n[0] * a, nd.y + yLift, p[2] + n[1] * a);
      pos.push(p[0] + n[0] * b, nd.y + yLift, p[2] + n[1] * b);
      if (k < PIT_NN - 1) { const j = k * 2; idx.push(j, j + 2, j + 1, j + 1, j + 2, j + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true; scene.add(m); return m;
  }
  pitRibbon(PIT_HW, -PIT_HW, 0.04, new THREE.MeshStandardMaterial({ color: 0x2c2f34, roughness: 0.96 }));   // tarmac
  pitRibbon(PIT_HW, PIT_HW - 0.16, 0.055, new THREE.MeshBasicMaterial({ color: 0xeef2f6 }));                // white edge, track side
  pitRibbon(-PIT_HW + 0.16, -PIT_HW, 0.055, new THREE.MeshBasicMaterial({ color: 0xeef2f6 }));              // white edge, garage side
  pitRibbon(0.13, -0.13, 0.05, new THREE.MeshBasicMaterial({ color: 0x2f74d8 }));                           // blue fast-lane line

  // pit wall separating the racing surface from the fast lane
  {
    const wallOff = 9.3, h = 1.0, pos = [], idx = []; let vi = 0;
    for (let k = midA; k <= midB; k++) {
      const nd = pitPath[k], n = normals[nd.i], p = P(nd.i);
      const wx = p[0] + n[0] * wallOff, wz = p[2] + n[1] * wallOff;
      pos.push(wx, nd.y, wz, wx, nd.y + h, wz);
      if (k < midB) idx.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3);
      vi += 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const wall = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide }));
    wall.castShadow = true; scene.add(wall);
  }

  // pit building spanning the box row: front facade + roof overhang
  {
    const kA = pitBoxes[0].k - 3, kB = pitBoxes[N_BOX - 1].k + 3, front = 23.5, back = 30.5, h = 6.5;
    const faceMat = new THREE.MeshStandardMaterial({ color: 0x565d66, roughness: 0.85, side: THREE.DoubleSide });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x353b42, roughness: 0.9, side: THREE.DoubleSide });
    const strip = (offFn, yFn, mat) => {
      const pos = [], idx = []; let vi = 0;
      for (let k = kA; k <= kB; k++) {
        const nd = pitPath[k], n = normals[nd.i], p = P(nd.i);
        const [oa, ob] = offFn(); const [ya, yb] = yFn(nd);
        pos.push(p[0] + n[0] * oa, ya, p[2] + n[1] * oa, p[0] + n[0] * ob, yb, p[2] + n[1] * ob);
        if (k < kB) idx.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3);
        vi += 2;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat); m.castShadow = true; scene.add(m); return m;
    };
    strip(() => [front, front], nd => [nd.y, nd.y + h], faceMat);        // front facade
    strip(() => [front, back], nd => [nd.y + h, nd.y + h], roofMat);     // flat roof
  }

  // per-box door bays on the facade + painted stop boxes (green = your box)
  const boxMarkTex = (() => {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128;
    const c = cv.getContext('2d'); c.strokeStyle = 'rgba(255,255,255,0.92)'; c.lineWidth = 7; c.strokeRect(6, 6, 52, 116);
    return new THREE.CanvasTexture(cv);
  })();
  const bayTex = (b, isP) => {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 96;
    const c = cv.getContext('2d'); c.fillStyle = isP ? '#159648' : '#14171b'; c.fillRect(0, 0, 128, 96);
    c.strokeStyle = 'rgba(255,255,255,.25)'; c.lineWidth = 4; c.strokeRect(3, 3, 122, 90);
    c.fillStyle = '#eef3f8'; c.font = 'bold 62px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(String(b + 1), 64, 52);
    return new THREE.CanvasTexture(cv);
  };
  for (const box of pitBoxes) {
    const nd = pitPath[box.k], n = normals[nd.i], p = P(nd.i), heading = pitHead(box.k);
    const isP = box.b === PLAYER_BOX;
    // door bay panel on the building face, opening onto the lane
    const bay = new THREE.Mesh(new THREE.PlaneGeometry(7, 4.4),
      new THREE.MeshStandardMaterial({ map: bayTex(box.b, isP), roughness: 0.7, side: THREE.DoubleSide }));
    bay.position.set(p[0] + n[0] * 23.3, nd.y + 2.3, p[2] + n[1] * 23.3);
    bay.rotation.y = heading + Math.PI / 2;
    scene.add(bay);
    // painted stop box on the lane
    const mk = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 5.2),
      new THREE.MeshBasicMaterial({ map: boxMarkTex, transparent: true, depthWrite: false, color: isP ? 0x8dffb2 : 0xffffff }));
    mk.rotation.x = -Math.PI / 2; mk.rotation.z = -heading;
    mk.position.set(nd.x, nd.y + 0.07, nd.z);
    scene.add(mk);
  }

  // entry & exit lines painted across the fast lane
  for (const k of [midA + 1, midB - 1]) {
    const nd = pitPath[k], heading = pitHead(k);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(PIT_HW * 2, 0.5), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    line.rotation.x = -Math.PI / 2; line.rotation.z = -heading;
    line.position.set(nd.x, nd.y + 0.08, nd.z);
    scene.add(line);
  }
}

{ // brake marker boards before the big stops
  const boardTex = {};
  for (const m of [100, 200]) boardTex[m] = bannerTexture(String(m), '#ffffff', '#d81920');
  for (const corner of [60, 565, 1647]) {
    for (const [m, back] of [[100, 25], [200, 50]]) {
      const i = ((corner - back) % N + N) % N;
      const p = P(i), n = normals[i];
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 5),
        new THREE.MeshStandardMaterial({ color: 0x888888 }));
      pole.position.set(p[0] + n[0] * (HALF_W + 3), p[1] + 1.1, p[2] + n[1] * (HALF_W + 3));
      scene.add(pole);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9),
        new THREE.MeshStandardMaterial({ map: boardTex[m], side: THREE.DoubleSide, roughness: 0.8 }));
      const tt = tangents[i];
      board.rotation.y = -Math.atan2(tt[1], tt[0]);
      board.position.set(p[0] + n[0] * (HALF_W + 3), p[1] + 2.0, p[2] + n[1] * (HALF_W + 3));
      scene.add(board);
    }
  }
}

// ---------------------------------------------------------------------------
// Car (original low-poly open-wheeler)
// ---------------------------------------------------------------------------
const car = new THREE.Group();
{
  const body = new THREE.MeshStandardMaterial({ color: 0x0fa3a3, roughness: 0.35, metalness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.6 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.4 });

  const tub = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.5, 3.4), body);
  tub.position.set(0, 0.42, -0.1); car.add(tub);
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.42, 1.6, 18), body);
  nose.rotation.x = Math.PI / 2; nose.position.set(0, 0.42, 2.4); car.add(nose);
  // open cockpit: dash cowl ahead of the wheel, padded sides, headrest behind
  const dash = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.20, 0.4), dark);
  dash.position.set(0, 0.88, 0.85); car.add(dash);
  for (const s of [-1, 1]) {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.18, 0.95), dark);
    pad.position.set(s * 0.35, 0.86, 0.18); car.add(pad);
  }
  const headrest = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.24, 0.30), dark);
  headrest.position.set(0, 0.90, -0.36); car.add(headrest);

  // halo: swooping arch only — no center pillar — toggled with H
  const haloM = new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.45, metalness: 0.3 });
  const haloArch = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.030, 14, 56, Math.PI), haloM);
  haloArch.rotation.x = -0.10;
  haloArch.scale.set(1.08, 0.60, 1);
  haloArch.position.set(0, 1.01, 0.33);
  car.add(haloArch);
  car.userData.halo = haloArch;

  // F1-style steering wheel: plate, grips, live LCD, buttons, dials, LED row
  const wheel = new THREE.Group();
  wheel.position.set(0, 0.86, 0.55);
  const wheelPrimitives = [];
  car.userData.wheelPrimitives = wheelPrimitives;
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.20, 0.035), dark);
  wheel.add(plate); wheelPrimitives.push(plate);
  for (const s of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.20, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.95 }));
    grip.position.set(s * 0.195, -0.01, -0.008); wheel.add(grip); wheelPrimitives.push(grip);
  }
  // live LCD (canvas texture redrawn while driving)
  const lcdCnv = document.createElement('canvas'); lcdCnv.width = 256; lcdCnv.height = 160;
  const lcdTex = new THREE.CanvasTexture(lcdCnv);
  const lcd = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.105),
    new THREE.MeshBasicMaterial({ map: lcdTex }));
  lcd.rotation.y = Math.PI;
  lcd.position.set(0, 0.015, -0.020); wheel.add(lcd);
  car.userData.lcd = { ctx: lcdCnv.getContext('2d'), tex: lcdTex };
  car.userData.lcdMesh = lcd;
  // buttons (colored, driver side)
  const BTN = [
    [-0.135, 0.06, 0x1fae4b], [-0.155, 0.0, 0x2255dd], [-0.13, -0.055, 0xe8c020],
    [0.135, 0.06, 0xd82020], [0.155, 0.0, 0x2255dd], [0.13, -0.055, 0x8833bb],
  ];
  for (const [bx, by, c] of BTN) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.012, 8),
      new THREE.MeshBasicMaterial({ color: c }));
    b.rotation.x = Math.PI / 2;
    b.position.set(bx, by, -0.022); wheel.add(b); wheelPrimitives.push(b);
  }
  // rotary dials along the bottom
  for (const [bx, c] of [[-0.07, 0xe8b019], [0, 0xd557c0], [0.07, 0x3fc3d8]]) {
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.020, 0.016, 10),
      new THREE.MeshBasicMaterial({ color: c }));
    dial.rotation.x = Math.PI / 2;
    dial.position.set(bx, -0.078, -0.022); wheel.add(dial); wheelPrimitives.push(dial);
  }
  // LED rev strip across the top of the wheel
  const leds = [];
  for (let k = 0; k < 12; k++) {
    const c = k < 6 ? 0x1fbf3a : k < 9 ? 0xd82020 : 0x2040ff;
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.013, 0.013, 0.012),
      new THREE.MeshBasicMaterial({ color: c }));
    led.position.set(-0.11 + k * 0.02, 0.088, -0.022);
    led.visible = false;
    wheel.add(led); leds.push(led);
  }
  // small fascia behind the rotary dials so they don't float
  const fascia = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.075, 0.028), dark);
  fascia.position.set(0, -0.09, -0.004); wheel.add(fascia); wheelPrimitives.push(fascia);
  car.add(wheel);
  car.userData.steeringWheel = wheel;
  car.userData.leds = leds;

  // wing mirrors with a glass inset
  for (const s of [-1, 1]) {
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.05), dark);
    mirror.position.set(s * 0.64, 0.94, 0.62); car.add(mirror);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.085),
      new THREE.MeshBasicMaterial({ color: 0x4a5666 }));
    glass.rotation.y = Math.PI;
    glass.position.set(s * 0.64, 0.94, 0.594); car.add(glass);
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.24, 5), dark);
    stalk.rotation.z = s * 1.2;
    stalk.position.set(s * 0.53, 0.87, 0.62); car.add(stalk);
  }
  const engineCover = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.55, 1.6), body);
  engineCover.position.set(0, 0.75, -1.15); car.add(engineCover);
  const sidepodL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 1.8), accent);
  sidepodL.position.set(0.72, 0.45, -0.5); car.add(sidepodL);
  const sidepodR = sidepodL.clone(); sidepodR.position.x = -0.72; car.add(sidepodR);
  // front wing: main plane + raised flap + endplates
  const fwMain = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.045, 0.5), accent);
  fwMain.position.set(0, 0.14, 3.05); car.add(fwMain);
  const fwFlap = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.04, 0.28), accent);
  fwFlap.rotation.x = -0.28;
  fwFlap.position.set(0, 0.24, 2.90); car.add(fwFlap);
  for (const s of [-1, 1]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.55), dark);
    ep.position.set(s * 1.0, 0.19, 3.02); car.add(ep);
  }
  // rear wing: main plane + DRS flap + endplates
  const rwing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.07, 0.42), accent);
  rwing.position.set(0, 1.02, -2.05); car.add(rwing);
  const drs = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.05, 0.24), accent);
  drs.rotation.x = -0.5;
  drs.position.set(0, 1.14, -2.16); car.add(drs);
  car.userData.drsFlap = drs;   // laid flat when DRS opens
  for (const s of [-1, 1]) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.55), dark);
    plate.position.set(s * 0.74, 1.0, -2.05); car.add(plate);
  }
  // shark fin + T-cam pod
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.26, 1.05), body);
  fin.position.set(0, 1.02, -1.35); car.add(fin);
  const tcam = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.20), dark);
  tcam.position.set(0, 1.16, -0.15); car.add(tcam);
  // suspension wishbones (visible from the cockpit)
  const armM = new THREE.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.7 });
  const addArm = (ax, ay, az, bx, by, bz) => {
    const from = new THREE.Vector3(ax, ay, az), to = new THREE.Vector3(bx, by, bz);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, from.distanceTo(to), 5), armM);
    arm.position.copy(from).lerp(to, 0.5);
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    car.add(arm);
  };
  for (const s of [-1, 1]) {
    addArm(s * 0.34, 0.56, 1.35, s * 0.80, 0.50, 1.72);   // front upper wishbone
    addArm(s * 0.34, 0.34, 1.50, s * 0.80, 0.40, 1.74);   // front lower wishbone
    addArm(s * 0.30, 0.48, 1.95, s * 0.80, 0.46, 1.78);   // front track rod
    addArm(s * 0.32, 0.52, -1.18, s * 0.84, 0.46, -1.52); // rear upper
    addArm(s * 0.32, 0.32, -1.32, s * 0.84, 0.40, -1.55); // rear lower
  }
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 3.6), dark);
  floor.position.set(0, 0.18, 0); car.add(floor);

  const wheelG = new THREE.CylinderGeometry(0.44, 0.44, 0.42, 24);
  wheelG.rotateZ(Math.PI / 2);
  const rimG = new THREE.CylinderGeometry(0.27, 0.27, 0.43, 18);
  rimG.rotateZ(Math.PI / 2);
  const wheelM = new THREE.MeshStandardMaterial({ color: 0x181818, roughness: 0.85 });
  const rimM = new THREE.MeshStandardMaterial({ color: 0xaab0b8, roughness: 0.35, metalness: 0.7 });
  // hub steers (yaw), wheel inside it spins on its axle — keeping the two
  // rotations on separate objects is what stops the tires wobbling
  car.userData.wheels = [];
  car.userData.hubs = [];
  for (const [x, z, front] of [[0.88, 1.75, 1], [-0.88, 1.75, 1], [0.92, -1.55, 0], [-0.92, -1.55, 0]]) {
    const hub = new THREE.Group();
    hub.position.set(x, 0.44, z);
    hub.userData.front = front;
    const w = new THREE.Mesh(wheelG, wheelM);
    w.castShadow = true;
    w.add(new THREE.Mesh(rimG, rimM)); // silver rim spins with the tire
    hub.add(w);
    car.add(hub);
    car.userData.wheels.push(w);
    car.userData.hubs.push(hub);
  }
  car.traverse(o => { if (o.isMesh) o.castShadow = true; });
  car.userData.shellMats = [body, accent, armM];
}
car.userData.placeholderParts = [...car.children];
scene.add(car);

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------
const input = { throttle: 0, brake: 0, steer: 0, left: false, right: false, up: false, down: false, overtake: false, drsWant: false };
const state = {
  x: P(0)[0] - tangents[0][0] * 12, z: P(0)[2] - tangents[0][1] * 12,
  heading: Math.atan2(tangents[0][0], tangents[0][1]), // yaw, forward = (sin,cos)
  vx: 0, vz: 0, idx: 0, steer: 0,
  lapStart: 0, running: false, lap: 0, best: null, last: null, prog: 0,
  // bicycle-model state: yaw rate, pedal ramps, longitudinal accel (raw + suspension-filtered)
  r: 0, thr: 0, brk: 0, ax: 0, axSm: 0,
  // per-checkpoint times (one slot per track point) for live delta-to-best
  curT: new Float32Array(N).fill(-1), bestT: null,
  // tyres + pit state
  tire: { compound: 'M', wear: 0 }, nextCompound: 'M',
  pitK: 0, onPitLane: false, pitRun: false, pitLimiter: false,
  pitService: 0, pitServiced: false, pitFrozen: false,
  // live sector timing (0/1/2), personal-best per sector, colour code p/g/y
  sec: 0, secStart: 0, secLap: [null, null, null], secBest: [null, null, null], secCol: ['', '', ''],
  // ERS (battery 0..1) + deploy state, DRS availability/open state
  ers: 0.7, ersMode: 1, ersDeploy: false, ersOT: false, drsAvail: false, drsOpen: false, drsAnn: false,
  // tyre temps (FL,FR,RL,RR °C), fuel (kg), engine mix (0 lean/1 std/2 rich),
  // brake bias (front fraction), and flag / penalty state
  tireTemp: [90, 90, 88, 88], fuel: 100, fuelMix: 1, brakeBias: 0.62,
  lapInvalid: false, trackStrikes: 0, penalty: 0, blueFlag: false, offTimer: 0,
};

const MASS = 800, POWER = 690000, MU = 1.75, DFK = 0.0062, CDA = 1.45;
const COLL_R = 2.6; // car-to-car contact radius (m)
// bicycle-model parameters: yaw inertia, CG position/height, axle cornering stiffness
const IZ = 1050, CG_A = 1.8, CG_B = 1.6, WHEELBASE = 3.4, CG_H = 0.32;
const CA_F = 2.1e5, CA_R = 2.5e5; // N/rad before saturation

// tyre compounds: grip multiplier vs wear rate. wear (0..1) bleeds grip away,
// so a worn set slides and lap times fall off — that's the reason to pit.
const TCOMP = {
  S: { name: 'SOFT',   short: 'S', col: '#e5342b', grip: 1.05, wear: 1.7 },
  M: { name: 'MEDIUM', short: 'M', col: '#e8c43a', grip: 1.00, wear: 1.0 },
  H: { name: 'HARD',   short: 'H', col: '#e9edf2', grip: 0.96, wear: 0.6 },
};
const PIT_STOP_TIME = 2.6;   // seconds stationary in the box for a tyre change

// three timing sectors, split by fraction of the lap (~Spa's real split points)
const SEC_BOUND = [TRACK_LEN * 0.32, TRACK_LEN * 0.68];
const secOf = prog => prog < SEC_BOUND[0] ? 0 : prog < SEC_BOUND[1] ? 1 : 2;

// ERS: harvest under braking / off-throttle, deploy on power (overtake = burst)
const ERS_HARVEST_BRAKE = 0.15, ERS_HARVEST_COAST = 0.05;
const ERS_DEPLOY_OT = 0.11, ERS_DEPLOY_BAL = 0.045;
const ERS_BOOST_OT = 0.22, ERS_BOOST_BAL = 0.10;   // extra drive force when deploying
// DRS: drag multiplier when open, and the two Spa activation zones (progress m).
// A zone [a,b] with a>b wraps the start/finish line.
const DRS_DRAG = 0.72;
const DRS_ZONES = [[1150, 2150], [6650, 200]];   // Kemmel straight; pit straight
const inDrsZone = prog => DRS_ZONES.some(z => z[0] <= z[1] ? (prog >= z[0] && prog <= z[1]) : (prog >= z[0] || prog <= z[1]));

function trackInfo(x, z, hint) {
  let bi = hint, bd = 1e18;
  for (let k = -45; k <= 45; k++) {
    const i = ((hint + k) % N + N) % N;
    const p = PTS[i];
    const d = (p[0] - x) ** 2 + (p[2] - z) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  const p = PTS[bi], t = tangents[bi], n = normals[bi];
  const dx = x - p[0], dz = z - p[2];
  const along = dx * t[0] + dz * t[1];
  const lateral = dx * n[0] + dz * n[1];
  // Catmull-Rom height interpolation: C1-continuous across sample points, so
  // there is no kink to feel when crossing each 4 m segment at speed
  let i0 = bi, u = along / STEP;
  if (u < 0) { i0 = bi - 1; u += 1; }
  u = Math.max(0, Math.min(1, u));
  const y0 = P(i0 - 1)[1], y1 = P(i0)[1], y2 = P(i0 + 1)[1], y3 = P(i0 + 2)[1];
  const y = 0.5 * ((2 * y1) + (-y0 + y2) * u + (2 * y0 - 5 * y1 + 4 * y2 - y3) * u * u + (-y0 + 3 * y1 - 3 * y2 + y3) * u * u * u);
  return { idx: bi, lateral, y, t, s: bi * STEP + along };
}

let onTrackState = true;

// pit-lane locator + limiter/commit state machine, run once per physics step
function updatePitState() {
  const s = state;
  const seed = pitKofTrack[s.idx] >= 0 ? pitKofTrack[s.idx] : (s.pitK | 0);
  const pi = pitInfo(s.x, s.z, seed);
  s.pitK = pi.k;
  const onCorridor = pi.dist < PIT_HW + 1.2;
  s.onPitLane = onCorridor && pi.laneLat > 2.5;
  if (!s.pitRun) {
    // commit to a pit run once you're clearly on the offset lane
    if (onCorridor && pi.laneLat > 4 && pi.k < PIT_NN - PIT_TAPER) {
      s.pitRun = true; s.pitServiced = false; s.pitService = 0;
    }
  } else if ((pi.k >= PIT_NN - PIT_TAPER && pi.laneLat < 3) || pi.dist > PIT_HW + 5) {
    s.pitRun = false;   // merged back out, or spun off the lane
  }
  s.pitLimiter = s.pitRun;
}

// pit-box service: hold the car in your box, swap tyres, then release (per frame)
function updatePitStop(dt) {
  const s = state;
  if (!s.pitRun) { s.pitService = 0; s.pitServiced = false; s.pitFrozen = false; return; }
  const pb = pitBoxes[PLAYER_BOX];
  let dk = Math.abs(s.pitK - pb.k); dk = Math.min(dk, PIT_NN - dk);
  const speed = Math.hypot(s.vx, s.vz);
  if (!s.pitServiced && dk <= 3 && speed < 2.2) {
    s.pitFrozen = true;
    s.pitService += dt;
    if (s.pitService >= PIT_STOP_TIME) {
      s.tire = { compound: s.nextCompound, wear: 0 };
      s.pitServiced = true; s.pitFrozen = false;
      flashLap('TYRES FITTED — GO GO GO');
    }
  } else {
    s.pitFrozen = false;
  }
}

// the slip-angle dynamics need a finer timestep than 120 Hz to stay stable
// at low speed, so each fixed step is integrated in three substeps
// ERS + DRS state machine, run once per physics step so the deploy/DRS flags
// stay constant across the substeps that read them
function updateCarSystems(dt) {
  const s = state, speed = Math.hypot(s.vx, s.vz);
  const braking = s.brk > 0.05, onThrottle = s.thr > 0.1;
  // ERS harvest: mostly under braking (MGU-K regen), a trickle off-throttle
  if (braking && speed > 8) s.ers = Math.min(1, s.ers + ERS_HARVEST_BRAKE * dt);
  else if (!onThrottle && speed > 8) s.ers = Math.min(1, s.ers + ERS_HARVEST_COAST * dt);
  // ERS deploy: overtake button = max burst, balanced mode = gentle auto-deploy
  const wantOT = input.overtake;
  const auto = s.ersMode === 1 && onThrottle && speed > 15;
  const deploy = (wantOT || auto) && s.ers > 0.01 && onThrottle && speed > 8 && !s.pitLimiter;
  if (deploy) s.ers = Math.max(0, s.ers - (wantOT ? ERS_DEPLOY_OT : ERS_DEPLOY_BAL) * dt);
  s.ersDeploy = deploy; s.ersOT = deploy && wantOT;
  // DRS: available in a zone; in a race only from lap 2 and within ~1s of a car ahead
  const inZone = inDrsZone(s.prog);
  let allowed = inZone;
  if (sess.mode === 'race') {
    if (s.lap < 1) allowed = false;
    else {
      if (!s.drsAnn) { s.drsAnn = true; flashLap('DRS ENABLED'); }
      const pd = playerDist(), pv = Math.max(speed, 20);
      let within = false;
      for (const r of rivals) { const gap = rivalDist(r) - pd; if (gap > 0 && gap / pv < 1.0) { within = true; break; } }
      allowed = inZone && within;
    }
  }
  s.drsAvail = allowed;
  if (input.drsWant && allowed && onThrottle && !braking && speed > 20) s.drsOpen = true;
  if (braking || !inZone || speed < 18) { s.drsOpen = false; if (braking || !inZone) input.drsWant = false; }

  // --- tyre temperatures (FL, FR, RL, RR): a target temp from the workload,
  //     eased toward. Fronts take braking heat, rears traction; the outer tyre
  //     in a corner loads up hottest. Warm tyres → optimal grip (state.tempGrip)
  const tt = s.tireTemp, corner = Math.abs(s.r) * speed;
  for (let i = 0; i < 4; i++) {
    const front = i < 2, left = i % 2 === 0;
    const outer = (s.steer > 0.05 && !left) || (s.steer < -0.05 && left) ? 1 : 0.45;
    const target = 55 + speed * 0.35 + Math.min(45, corner * 22) * outer
      + (front ? s.brk * 22 : s.thr * 14) + (onTrackState ? 0 : 18);
    tt[i] += (Math.min(150, target) - tt[i]) * Math.min(1, dt * (0.35 + speed * 0.01));
  }
  const avgT = (tt[0] + tt[1] + tt[2] + tt[3]) / 4;
  s.tempGrip = Math.max(0.93, 1 - 1e-4 * (avgT - 100) ** 2);   // cold/hot tyres lose a little grip

  // --- fuel burn (telemetry): more on throttle / when deploying ---
  if (speed > 1) s.fuel = Math.max(0, s.fuel - (0.006 + s.thr * 0.02 + (s.ersDeploy ? 0.004 : 0)) * dt);

  // --- flags: blue when a car a lap (or more) ahead overall is right behind
  //     you on the circuit, about to come past ---
  s.blueFlag = false;
  if (sess.mode === 'race' && sess.phase === 'racing') {
    for (const r of rivals) {
      if (rivalDist(r) - playerDist() > TRACK_LEN * 0.5) {
        const rprog = (((r.u % 1) + 1) % 1) * TRACK_LEN;
        let behind = s.prog - rprog; if (behind < 0) behind += TRACK_LEN;
        if (behind < 45) { s.blueFlag = true; break; }
      }
    }
  }
  // --- track limits: fully off the tarmac+kerb at speed during a timed lap ---
  const off = !onTrackState && speed > 15;
  if (off && !s.wasOff && s.running) {
    s.trackStrikes++; s.lapInvalid = true;
    if (sess.mode === 'race' && s.trackStrikes % 3 === 0) { s.penalty += 5; flashLap('TRACK LIMITS — +5s PENALTY'); }
    else flashLap('TRACK LIMITS — lap time deleted');
  }
  s.wasOff = off;
}
function physStep(dt) {
  updatePitState();
  updateCarSystems(dt);
  const n = 3, h = dt / n;
  for (let k = 0; k < n; k++) physCore(h);
}
function physCore(dt) {
  const s = state;
  const fwdX = Math.sin(s.heading), fwdZ = Math.cos(s.heading);
  const speed = Math.hypot(s.vx, s.vz);
  const vAlong = s.vx * fwdX + s.vz * fwdZ;

  const info = trackInfo(s.x, s.z, s.idx);
  s.idx = info.idx;
  // the pit lane counts as tarmac even though it sits off the main track
  const onTrack = (info.lateral < HWp[s.idx] + KERB_W && info.lateral > -(HWm[s.idx] + KERB_W)) || s.onPitLane;
  onTrackState = onTrack;
  // tyre grip: compound grip × wear fall-off (steeper past the ~85% cliff),
  // folded into the surface mu so worn tyres slide on tarmac and grass alike
  const tc = TCOMP[s.tire.compound] || TCOMP.M;
  const tireGrip = tc.grip * (1 - 0.16 * s.tire.wear) * (s.tire.wear > 0.85 ? 1 - (s.tire.wear - 0.85) * 0.8 : 1) * (s.tempGrip || 1);
  // grass grip: reduced but not a cliff — brushing a wheel over the edge
  // shouldn't instantly snap the car around
  const mu = (onTrack ? MU : 0.85) * tireGrip;

  // --- driver input shaping: keyboard keys ramp like a foot on a pedal ---
  let thrIn = input.throttle, brkIn = input.brake;
  if (assistsOn) {
    // brake assist: if you're carrying too much speed for the corner ahead,
    // the car brakes for you (and lifts) until you're back under the limit
    const over = vAlong - V_ALLOW[s.idx];
    if (over > 2) {
      brkIn = Math.max(brkIn, Math.min(1, over / 5));
      thrIn = 0;
    }
  }
  s.thr += Math.max(-8 * dt, Math.min(4 * dt, thrIn - s.thr));
  s.brk += Math.max(-10 * dt, Math.min(6 * dt, brkIn - s.brk));
  const steerTarget = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  const steerRate = 8;
  s.steer += Math.max(-steerRate * dt, Math.min(steerRate * dt, steerTarget - s.steer));
  const maxSteer = 0.62 / (1 + speed * 0.046); // generous lock at hairpin speeds
  // keyboard steering assist: full lock at speed would just spin the car, so
  // cap the wheel angle near the grip-limited angle (with margin for slides)
  const aLatCap = mu * (9.81 + DFK * speed * speed * (onTrack ? 1 : 0.25));
  const dGrip = aLatCap * (WHEELBASE / Math.max(speed * speed, 25) + 1e-4);
  const dCap = Math.min(maxSteer, dGrip * 1.05);
  const delta = Math.max(-dCap, Math.min(dCap, s.steer * maxSteer));

  // --- body-frame velocities ---
  let vLong = vAlong;
  const vLat = s.vx * -fwdZ + s.vz * fwdX;
  const r = s.r;

  // --- vertical loads: static + downforce + longitudinal weight transfer ---
  // weight transfer uses a suspension-filtered accel so a stabbed brake pedal
  // doesn't instantly strip the rear axle and snap the car sideways
  s.axSm += (s.ax - s.axSm) * Math.min(1, dt / 0.18);
  const df = MASS * DFK * speed * speed * (onTrack ? 1 : 0.25);
  const FzT = MASS * 9.81 + df;
  let Fzf = FzT * CG_B / WHEELBASE - MASS * s.axSm * CG_H / WHEELBASE;
  let Fzr = FzT * CG_A / WHEELBASE + MASS * s.axSm * CG_H / WHEELBASE;
  Fzf = Math.max(FzT * 0.1, Fzf); Fzr = Math.max(FzT * 0.1, Fzr);

  // --- longitudinal tire forces ---
  // throttle always pulls forward — including out of reverse
  let FxDrive = 0, FxBrakeF = 0, FxBrakeR = 0;
  if (s.thr > 0.01) {
    // ERS deployment adds drive force (biggest effect at high speed, where the
    // engine is power- not traction-limited)
    const ersMul = 1 + (s.ersDeploy ? (s.ersOT ? ERS_BOOST_OT : ERS_BOOST_BAL) : 0);
    const pMul = ersMul * (s.fuelMix === 0 ? 0.97 : s.fuelMix === 2 ? 1.04 : 1);  // engine mode: lean/std/rich
    FxDrive = s.thr * Math.min(14000 * pMul, POWER * pMul / Math.max(vLong, 8));
    // traction control: while steering, leave the rear tires lateral headroom
    // so power-on corner exits can't pitch the car into a slide
    const tcCap = assistsOn ? (0.78 - 0.25 * Math.min(1, Math.abs(s.steer))) : 0.95;
    FxDrive = Math.min(FxDrive, tcCap * mu * Fzr);
  }
  if (s.brk > 0.01) {
    if (vLong > 0.5) {
      // ABS: while steering, hold back some brake force so the front tires
      // keep enough grip to actually turn (no more brake-and-plow-straight)
      const absScale = assistsOn ? 1 - 0.45 * Math.min(1, Math.abs(s.steer)) : 1;
      const Fb = s.brk * mu * FzT * 1.02 * absScale;
      FxBrakeF = Math.min(s.brakeBias * Fb, mu * Fzf); // adjustable brake bias, capped per axle
      FxBrakeR = Math.min((1 - s.brakeBias) * Fb, mu * Fzr);
    } else {
      vLong = Math.max(vLong - 4 * s.brk * dt, -8); // gentle reverse
    }
  }
  const dirL = vLong >= 0 ? 1 : -1;
  const FxF = -FxBrakeF * dirL;
  const FxR = FxDrive - FxBrakeR * dirL;
  const cda = s.drsOpen ? CDA * DRS_DRAG : CDA;   // DRS drops drag → higher top speed
  const Fdrag = (0.5 * 1.22 * cda * speed * speed + 320 + (onTrack ? 0 : 1800)) * dirL;

  // --- lateral tire forces: slip angles, saturation, traction circle ---
  const vRef = Math.max(Math.abs(vLong), 1);
  const alphaF = Math.atan2(vLat + CG_A * r, vRef) - delta * dirL;
  const alphaR = Math.atan2(vLat - CG_B * r, vRef);
  // slight rear grip bias = terminal understeer: at the limit the front washes
  // out first instead of the car spinning (how stable race setups behave)
  const capF = Math.sqrt(Math.max(1e4, (mu * 0.97 * Fzf) ** 2 - FxF ** 2));
  const capR = Math.sqrt(Math.max(1e4, (mu * 1.06 * Fzr) ** 2 - FxR ** 2));
  const caScale = onTrack ? 1 : 0.55;
  const FyF = -capF * Math.tanh(CA_F * caScale * alphaF / capF);
  const FyR = -capR * Math.tanh(CA_R * caScale * alphaR / capR);

  // --- rigid-body dynamics, blended to kinematic steering at parking speeds ---
  const axNet = (FxR + FxF * Math.cos(delta) - Fdrag) / MASS;
  const vLatDot = (FyF * Math.cos(delta) + FyR) / MASS - vLong * r;
  // yaw damper (tire relaxation / self-aligning effects): keeps transients
  // from ringing into a spin when an axle saturates
  const yawDamp = (2500 + speed * 30) * r;
  const rDot = (CG_A * FyF * Math.cos(delta) - CG_B * FyR - yawDamp) / IZ;
  const w = Math.max(0, Math.min(1, (Math.abs(vLong) - 3) / 4));
  const rKin = vLong * Math.tan(delta) / WHEELBASE;
  let rNew = w * (r + rDot * dt) + (1 - w) * rKin;
  let vLatNew = w * (vLat + vLatDot * dt) + (1 - w) * vLat * Math.exp(-8 * dt);
  if (!isFinite(rNew)) rNew = 0;
  if (!isFinite(vLatNew)) vLatNew = 0;
  vLong += (axNet + vLatNew * rNew) * dt;
  // pit-lane speed limiter: hard cap on forward speed
  if (s.pitLimiter && vLong > PIT_LIMIT) vLong = PIT_LIMIT;
  // tyre wear: accrues with distance, faster under slip (sliding / lockups)
  if (speed > 1) {
    const slipFrac = Math.min(1, Math.abs(vLatNew) * 0.12 + Math.abs(alphaF) * 2.2 + Math.abs(alphaR) * 2.2);
    s.tire.wear = Math.min(1, s.tire.wear + tc.wear * (0.00035 + 0.0016 * slipFrac) * dt);
  }

  s.heading += rNew * dt;
  s.r = rNew;
  s.ax = axNet;
  const f2X = Math.sin(s.heading), f2Z = Math.cos(s.heading);
  s.vx = f2X * vLong + -f2Z * vLatNew;
  s.vz = f2Z * vLong + f2X * vLatNew;
  const vF = vLong; // forward speed, read by the lap-timing gate below

  s.x += s.vx * dt;
  s.z += s.vz * dt;

  // soft barrier at ±(HALF_W+9) — suspended on the pit lane, which lives beyond it
  const info2 = trackInfo(s.x, s.z, s.idx);
  const limP = HWp[info2.idx] + 8.4, limM = HWm[info2.idx] + 8.4;
  if (!s.onPitLane && (info2.lateral > limP || info2.lateral < -limM)) {
    const n = normals[info2.idx];
    const over = info2.lateral > limP ? info2.lateral - limP : -limM - info2.lateral;
    const sgn = Math.sign(info2.lateral);
    s.x -= n[0] * sgn * over; s.z -= n[1] * sgn * over;
    const vn = s.vx * n[0] + s.vz * n[1];
    s.vx -= n[0] * vn * 1.4; s.vz -= n[1] * vn * 1.4;
    // scrape speed off instead of dead-stopping, so you can drive away from a wall
    s.vx *= 0.96; s.vz *= 0.96;
  }

  // (car-to-car contact now handled 2-way in updateRivals, once per frame)

  // lap timing via progress
  const prog = info2.s;
  const now = performance.now();
  // sector splits: close a sector the instant progress crosses its boundary
  if (s.running) {
    const ns = secOf(prog);
    if (ns === s.sec + 1) {
      const t = now - s.secStart;
      s.secLap[s.sec] = t;
      if (s.secBest[s.sec] == null || t < s.secBest[s.sec]) { s.secBest[s.sec] = t; s.secCol[s.sec] = 'p'; }
      else s.secCol[s.sec] = 'y';
      s.sec = ns; s.secStart = now;
    }
  }
  if (s.prog > TRACK_LEN - 60 && prog < 60 && vF > 3) {
    if (s.running) {
      s.last = now - s.lapStart;
      const t3 = now - s.secStart;                 // close the final sector (S3) at the line
      s.secLap[2] = t3;
      if (s.secBest[2] == null || t3 < s.secBest[2]) { s.secBest[2] = t3; s.secCol[2] = 'p'; }
      else s.secCol[2] = 'y';
      if (!s.lapInvalid && (!s.best || s.last < s.best)) {
        s.best = s.last;
        s.bestT = s.curT.slice(); // checkpoint times of the new best lap
        flashLap(`LAP ${s.lap}  —  ${fmt(s.last)}  ★ BEST`);
      } else flashLap(`LAP ${s.lap}  —  ${fmt(s.last)}${s.lapInvalid ? '  ⚠ LAP INVALID' : ''}`);
    }
    s.lap++; s.lapStart = now; s.running = true;
    s.curT.fill(-1);
    s.lapInvalid = false;                                          // fresh lap
    s.sec = 0; s.secStart = now; s.secLap = [null, null, null];   // new lap, keep bests
  }
  s.prog = prog;
  // record checkpoint time the first time each track point is reached this lap
  if (s.running && s.curT[info2.idx] < 0) s.curT[info2.idx] = performance.now() - s.lapStart;
}

function resetCar() {
  const i = state.idx;
  const p = P(i), t = tangents[i];
  state.x = p[0]; state.z = p[2];
  state.heading = Math.atan2(t[0], t[1]);
  state.vx = state.vz = 0; state.steer = 0;
  state.r = 0; state.thr = 0; state.brk = 0; state.ax = 0; state.axSm = 0;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
let started = false, muted = false, camMode = 0, assistsOn = true, tvMode = false;
addEventListener('keydown', e => {
  // while the start menu is up, only Enter launches the selected mode
  if (!started || sess.mode === 'menu') {
    if (e.code === 'Enter') startGame(menu.mode);
    return;
  }
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': input.throttle = 1; break;
    case 'KeyS': case 'ArrowDown': input.brake = 1; break;
    case 'KeyA': case 'ArrowLeft': input.left = true; break;
    case 'KeyD': case 'ArrowRight': input.right = true; break;
    case 'KeyR': resetCar(); break;
    case 'KeyC':
      if (prevCamMode !== null) { prevCamMode = (prevCamMode + 1) % 3; break; }  // adjust the view to return to
      camMode = (camMode + 1) % 3; // chase -> cockpit -> nose pod
      document.body.classList.toggle('cockpit', camMode >= 1);
      break;
    case 'KeyV':
      tvMode = !tvMode;
      flashLap(tvMode ? 'BROADCAST CAMERAS' : 'DRIVER CAMERA');
      break;
    case 'KeyF':
      rearOn = !rearOn;
      flashLap(rearOn ? 'REAR VIEW ON' : 'REAR VIEW OFF');
      break;
    case 'KeyO':
      toggleSettings();
      break;
    case 'Escape':
      backToMenu();
      break;
    case 'KeyL': raceLine.visible = !raceLine.visible; break;
    case 'KeyH': car.userData.halo.visible = !car.userData.halo.visible; break;
    case 'KeyX':
      assistsOn = !assistsOn;
      flashLap(assistsOn ? 'ASSISTS ON — brake assist / ABS / traction control' : 'ASSISTS OFF — you are on your own');
      break;
    case 'KeyB': if (car.userData.imported) car.userData.imported.rotation.y += Math.PI / 2; break;
    case 'KeyM': muted = !muted; break;
    case 'ShiftLeft': case 'ShiftRight': input.overtake = true; break;
    case 'Space': input.drsWant = true; e.preventDefault(); break;
    case 'KeyE':
      state.ersMode = state.ersMode === 1 ? 0 : 1;
      flashLap(state.ersMode === 1 ? 'ERS: BALANCED — auto-deploy' : 'ERS: HARVEST — saving battery');
      break;
    case 'KeyQ':
      state.fuelMix = (state.fuelMix + 1) % 3;
      flashLap('ENGINE: ' + ['LEAN — saving fuel', 'STANDARD', 'RICH — max power'][state.fuelMix]);
      break;
    case 'BracketLeft': state.brakeBias = Math.max(0.54, state.brakeBias - 0.01); flashLap('BRAKE BIAS ' + Math.round(state.brakeBias * 100) + '% FRONT'); break;
    case 'BracketRight': state.brakeBias = Math.min(0.70, state.brakeBias + 0.01); flashLap('BRAKE BIAS ' + Math.round(state.brakeBias * 100) + '% FRONT'); break;
    case 'Digit1': state.nextCompound = 'S'; flashLap('NEXT STOP: SOFT'); break;
    case 'Digit2': state.nextCompound = 'M'; flashLap('NEXT STOP: MEDIUM'); break;
    case 'Digit3': state.nextCompound = 'H'; flashLap('NEXT STOP: HARD'); break;
  }
});
addEventListener('keyup', e => {
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': input.throttle = 0; break;
    case 'KeyS': case 'ArrowDown': input.brake = 0; break;
    case 'KeyA': case 'ArrowLeft': input.left = false; break;
    case 'KeyD': case 'ArrowRight': input.right = false; break;
    case 'ShiftLeft': case 'ShiftRight': input.overtake = false; break;
  }
});

// ---------------------------------------------------------------------------
// Audio (synthesized engine)
// ---------------------------------------------------------------------------
// Engine audio. If /public/engine.wav exists (any legally obtained engine
// loop), it is pitch-shifted with the revs; otherwise a procedural V6 hybrid
// synth runs: dominant tone = firing frequency (rpm/60 x 3 for a V6) plus
// harmonics, exhaust rasp, and speed wind.
let audio = null, audioSample = null;
function initAudio() {
  const ctx = new AudioContext();
  const master = ctx.createGain(); master.gain.value = 0;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp); comp.connect(ctx.destination);
  fetch(ASSET + 'engine.wav')
    .then(r => (r.ok && (r.headers.get('content-type') || '').includes('audio')) ? r.arrayBuffer() : Promise.reject())
    .then(b => ctx.decodeAudioData(b))
    .then(buf => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const sg = ctx.createGain(); sg.gain.value = 1.2;
      src.connect(sg); sg.connect(master);
      src.start();
      audioSample = { src };
      for (const o of [audio.osc1, audio.osc2, audio.osc3]) o.disconnect();
    }).catch(() => {});
  const osc1 = ctx.createOscillator(); osc1.type = 'sawtooth';
  const osc2 = ctx.createOscillator(); osc2.type = 'sawtooth'; osc2.detune.value = 9;
  const osc3 = ctx.createOscillator(); osc3.type = 'square';
  const g1 = ctx.createGain(); g1.gain.value = 0.50;
  const g2 = ctx.createGain(); g2.gain.value = 0.26;
  const g3 = ctx.createGain(); g3.gain.value = 0.20;
  const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 1400;
  osc1.connect(g1); osc2.connect(g2); osc3.connect(g3);
  g1.connect(filt); g2.connect(filt); g3.connect(filt); filt.connect(master);
  // exhaust rasp + wind share one noise buffer
  const nbuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const nd = nbuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource(); noise.buffer = nbuf; noise.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.7;
  const ng = ctx.createGain(); ng.gain.value = 0.06;
  noise.connect(bp); bp.connect(ng); ng.connect(master);
  const wind = ctx.createBufferSource(); wind.buffer = nbuf; wind.loop = true; wind.playbackRate.value = 0.73;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1600;
  const wg = ctx.createGain(); wg.gain.value = 0;
  wind.connect(hp); hp.connect(wg); wg.connect(master);
  osc1.start(); osc2.start(); osc3.start(); noise.start(); wind.start();
  audio = { ctx, master, osc1, osc2, osc3, filt, bp, ng, wg };
}
function updateAudio(rpmFrac, throttle, speed) {
  if (!audio) return;
  const t = audio.ctx.currentTime;
  const rpm = 4000 + rpmFrac * 8500;
  const f = rpm / 60 * 3; // V6 firing frequency: 200 Hz idle -> ~600 Hz at the limiter
  if (audioSample) {
    audioSample.src.playbackRate.setTargetAtTime(0.55 + rpmFrac * 1.55, t, 0.03);
  } else {
    audio.osc1.frequency.setTargetAtTime(f, t, 0.02);
    audio.osc2.frequency.setTargetAtTime(f * 2, t, 0.02);
    audio.osc3.frequency.setTargetAtTime(f / 2, t, 0.02);
    audio.filt.frequency.setTargetAtTime(650 + rpmFrac * 5200, t, 0.04);
    audio.bp.frequency.setTargetAtTime(f * 3, t, 0.05);
    audio.ng.gain.setTargetAtTime(0.03 + throttle * 0.09, t, 0.05);
  }
  audio.wg.gain.setTargetAtTime(muted ? 0 : Math.min(speed * 0.0011, 0.085), t, 0.1);
  const g = 0.09 + rpmFrac * 0.09 + throttle * 0.05;
  audio.master.gain.setTargetAtTime(muted ? 0 : g, t, 0.06);
}
// gear-change effects: ignition-cut dip on upshift, rev blip on downshift
function shiftCut(down) {
  if (!audio || muted) return;
  const t = audio.ctx.currentTime;
  const back = audio.master.gain.value || 0.15;
  audio.master.gain.cancelScheduledValues(t);
  audio.master.gain.setValueAtTime(back, t);
  audio.master.gain.linearRampToValueAtTime(0.015, t + 0.035);
  audio.master.gain.linearRampToValueAtTime(back, t + (down ? 0.14 : 0.09));
  if (down && !audioSample) {
    const f = audio.osc1.frequency.value;
    audio.osc1.frequency.setValueAtTime(f * 1.22, t + 0.05);
    audio.osc1.frequency.setTargetAtTime(f, t + 0.05, 0.06);
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const fmt = ms => {
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, t = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(t).padStart(3, '0')}`;
};
let flashTimer = null;
function flashLap(text) {
  const el = $('lapflash');
  el.textContent = text; el.style.opacity = 1;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.style.opacity = 0, 3500);
}

// gears: speeds (km/h) at which each gear tops out
const GEARS = [95, 130, 165, 200, 235, 268, 300, 345];
function gearAt(kmh) {
  for (let i = 0; i < GEARS.length; i++) if (kmh < GEARS[i]) return i;
  return GEARS.length - 1;
}

let cornerShown = '';
function updateHUD(speedKmh) {
  $('speed').textContent = Math.round(speedKmh);
  const g = gearAt(speedKmh);
  $('gear').textContent = speedKmh < 3 ? 'N' : (g + 1);
  if (speedKmh > 20 && state.lastGearNum !== undefined && g !== state.lastGearNum) {
    shiftCut(g < state.lastGearNum);
  }
  state.lastGearNum = g;
  const lo = g === 0 ? 0 : GEARS[g - 1];
  const rpmFrac = Math.max(0.12, Math.min(1, (speedKmh - lo) / (GEARS[g] - lo)));
  $('rpmfill').style.width = `${rpmFrac * 100}%`;
  $('rpm').textContent = `${Math.round((4000 + rpmFrac * 8500) / 50) * 50} RPM`;

  $('lapTime').textContent = state.running ? fmt(performance.now() - state.lapStart) : '0:00.000';
  // live delta vs best lap at the current checkpoint
  const dEl = $('delta');
  if (state.running && state.bestT && state.bestT[state.idx] >= 0 && state.curT[state.idx] >= 0) {
    const d = (state.curT[state.idx] - state.bestT[state.idx]) / 1000;
    dEl.textContent = (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2);
    dEl.style.color = d >= 0 ? '#ff7070' : '#7dffa0';
    state.deltaStr = dEl.textContent;
    state.deltaAhead = d < 0;
  } else { dEl.textContent = ''; state.deltaStr = ''; }
  $('lastLap').textContent = state.last ? fmt(state.last) : '—';
  $('bestLap').textContent = state.best ? fmt(state.best) : '—';
  $('lapCount').textContent = state.lap;
  $('offtrack').style.opacity = onTrackState ? 0 : 1;

  // sector timing strip (purple = personal best sector, yellow = slower)
  for (let k = 0; k < 3; k++) {
    const box = $('sec' + k);
    let cls = 's', txt = '—';
    if (state.running && state.sec === k) { cls = 's cur'; txt = ((performance.now() - state.secStart) / 1000).toFixed(1); }
    else if (state.secLap[k] != null) { cls = 's ' + (state.secCol[k] || ''); txt = (state.secLap[k] / 1000).toFixed(1); }
    box.className = cls; $('sec' + k + 'v').textContent = txt;
  }

  // corner name banner
  let name = '';
  for (const c of CORNERS) {
    const d = Math.abs(((state.idx - c.i) % N + N) % N);
    const dd = Math.min(d, N - d);
    if (dd < 30) { name = c.name; break; }
  }
  if (name !== cornerShown) {
    cornerShown = name;
    const el = $('cornerName');
    if (name) { el.textContent = name; el.style.opacity = 1; }
    else el.style.opacity = 0;
  }

  // tyres + pit status
  const tc = TCOMP[state.tire.compound] || TCOMP.M;
  const wearPct = Math.round(state.tire.wear * 100);
  $('tireComp').textContent = tc.short; $('tireComp').style.color = tc.col;
  const tf = $('tireWearFill');
  tf.style.width = Math.max(0, 100 - wearPct) + '%';
  tf.style.background = wearPct > 80 ? '#e5342b' : wearPct > 55 ? '#e8c43a' : '#2ec26a';
  $('tireWearPct').textContent = wearPct + '%';
  $('tireNext').textContent = TCOMP[state.nextCompound].short;
  const pm = $('pitmsg');
  if (state.pitFrozen) {
    pm.textContent = 'PIT STOP — ' + Math.max(0, PIT_STOP_TIME - state.pitService).toFixed(1) + 's';
    pm.className = 'hud show stop';
  } else if (state.pitLimiter) {
    pm.textContent = '● PIT LIMITER ' + Math.round(PIT_LIMIT * 3.6);
    pm.className = 'hud show lim';
  } else pm.className = 'hud';

  // ERS battery + mode
  $('ersfill').style.width = Math.round(state.ers * 100) + '%';
  $('erspct').textContent = Math.round(state.ers * 100) + '%';
  const em = $('ersmode');
  if (state.ersOT) { em.textContent = 'OVERTAKE'; em.className = 'ot'; }
  else if (state.ersDeploy) { em.textContent = 'DEPLOY'; em.className = 'deploy'; }
  else { em.textContent = state.brk > 0.05 ? 'HARVESTING' : (state.ersMode === 1 ? 'ERS BALANCED' : 'ERS HARVEST'); em.className = ''; }
  // DRS indicator
  $('drs').className = state.drsOpen ? 'hud open' : state.drsAvail ? 'hud avail' : 'hud';

  // MFD: tyre temps (colour by heat) + fuel / engine mode / brake bias
  $('mfd').classList.toggle('show', sess.mode !== 'menu');
  const tempCol = t => t < 75 ? '#3a7bd6' : t < 88 ? '#2a9d8f' : t < 110 ? '#2ec26a' : t < 125 ? '#e8993a' : '#e5342b';
  const tids = ['ttFL', 'ttFR', 'ttRL', 'ttRR'];
  for (let i = 0; i < 4; i++) { const el = $(tids[i]); el.style.background = tempCol(state.tireTemp[i]); el.textContent = Math.round(state.tireTemp[i]); }
  $('mFuel').textContent = Math.max(0, state.fuel).toFixed(0);
  $('mMix').textContent = ['LEAN', 'STD', 'RICH'][state.fuelMix];
  $('mBB').textContent = Math.round(state.brakeBias * 100) + '%';

  // flags + penalty
  const fl = $('flag');
  fl.className = state.blueFlag ? 'hud blue' : 'hud';
  fl.textContent = state.blueFlag ? 'BLUE FLAG' : '';
  const pen = $('penalty');
  if (state.penalty > 0) { pen.className = 'hud show'; pen.textContent = '+' + state.penalty + 's PENALTY'; }
  else pen.className = 'hud';

  return rpmFrac;
}

// minimap
const mm = $('minimap').getContext('2d');
let mmScale, mmOX, mmOZ;
{
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of PTS) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]); }
  const w = 170;
  mmScale = w / Math.max(maxX - minX, maxZ - minZ);
  mmOX = (minX + maxX) / 2; mmOZ = (minZ + maxZ) / 2;
}
const mmX = x => 95 + (x - mmOX) * mmScale;
const mmZ = z => 95 + (z - mmOZ) * mmScale;
function drawMinimap() {
  mm.clearRect(0, 0, 190, 190);
  mm.beginPath();
  for (let i = 0; i <= N; i += 4) {
    const p = P(i);
    i === 0 ? mm.moveTo(mmX(p[0]), mmZ(p[2])) : mm.lineTo(mmX(p[0]), mmZ(p[2]));
  }
  mm.closePath();
  mm.strokeStyle = 'rgba(255,255,255,.85)'; mm.lineWidth = 2.5; mm.stroke();
  const p0 = P(0);
  mm.fillStyle = '#ffd34d';
  mm.fillRect(mmX(p0[0]) - 2.5, mmZ(p0[2]) - 2.5, 5, 5);
  // rival cars as team-coloured dots (race / quali only)
  if (sess.mode === 'race' || sess.mode === 'quali') {
    for (const r of rivals) {
      const rp = r.mesh.position;
      mm.beginPath();
      mm.arc(mmX(rp.x), mmZ(rp.z), 3.2, 0, 7);
      mm.fillStyle = '#' + r.def.color.toString(16).padStart(6, '0');
      mm.fill();
      mm.lineWidth = 1; mm.strokeStyle = 'rgba(0,0,0,.55)'; mm.stroke();
    }
  }
  // player on top: heading tick + red dot
  const px = mmX(state.x), pz = mmZ(state.z);
  mm.beginPath(); mm.moveTo(px, pz);
  mm.lineTo(px + Math.sin(state.heading) * 9, pz + Math.cos(state.heading) * 9);
  mm.strokeStyle = '#fff'; mm.lineWidth = 2; mm.stroke();
  mm.beginPath();
  mm.arc(px, pz, 4.2, 0, 7);
  mm.fillStyle = '#e10600'; mm.fill();
  mm.strokeStyle = '#fff'; mm.lineWidth = 1.4; mm.stroke();
}

// ---------------------------------------------------------------------------
// Custom car model: auto-loads /car.glb; drag & drop an .stl/.glb to swap.
// Named wheel nodes (FL_Wheel, FR_Wheel, RL_Wheel, RR_Wheel) are re-parented
// onto steering hubs so the real wheels spin and steer with the physics.
// ---------------------------------------------------------------------------
function attachCarModel(model) {
  if (car.userData.imported) { car.remove(car.userData.imported); car.userData.imported = null; }
  const wrap = new THREE.Group();
  wrap.add(model);
  let box = new THREE.Box3().setFromObject(wrap);
  let size = box.getSize(new THREE.Vector3());
  // longest axis becomes the car's length (z)
  if (size.x >= size.y && size.x >= size.z) wrap.rotation.y = Math.PI / 2;
  else if (size.y >= size.x && size.y >= size.z) wrap.rotation.x = -Math.PI / 2;
  wrap.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(wrap);
  size = box.getSize(new THREE.Vector3());
  wrap.scale.setScalar(5.63 / Math.max(size.x, size.y, size.z));
  wrap.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(wrap);
  const center = box.getCenter(new THREE.Vector3());
  wrap.position.set(-center.x, -box.min.y + 0.02, -center.z);
  const outer = new THREE.Group();
  outer.add(wrap);
  outer.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m) continue;
      m.side = THREE.DoubleSide;
      if ('envMapIntensity' in m) { m.envMapIntensity = 1.5; m.needsUpdate = true; }   // glossy F1 bodywork catches the sky
    }
  });
  car.add(outer);
  outer.updateMatrixWorld(true);
  car.userData.imported = outer;
  // snapshot the whole car (wheels still attached) to clone for the rivals
  const rivalSource = outer.clone(true);

  // hide the placeholder car (the animated steering wheel + LCD stay)
  for (const part of car.userData.placeholderParts) {
    if (part !== car.userData.steeringWheel) part.visible = false;
  }

  // hook up named wheels; aero covers steer with the hub but never spin
  const spinners = [], hubs = [];
  for (const [name, front, coverName] of [['FL_Wheel', 1, 'FL_Cover'], ['FR_Wheel', 1, 'FR_Cover'], ['RL_Wheel', 0, null], ['RR_Wheel', 0, null]]) {
    const node = outer.getObjectByName(name);
    if (!node) continue;
    const wbox = new THREE.Box3().setFromObject(node);
    const c = wbox.getCenter(new THREE.Vector3());
    const radius = wbox.getSize(new THREE.Vector3()).y / 2;
    const hub = new THREE.Group();
    hub.position.copy(car.worldToLocal(c.clone()));
    hub.userData.front = !!front;
    car.add(hub);
    hub.updateMatrixWorld(true);
    const spinner = new THREE.Group();
    hub.add(spinner);
    spinner.updateMatrixWorld(true);
    spinner.attach(node); // keeps world transform; spinner origin = wheel center
    spinner.userData.radius = Math.max(0.2, radius);
    spinners.push(spinner); hubs.push(hub);
    if (coverName) {
      const cover = outer.getObjectByName(coverName);
      if (cover) hub.attach(cover); // steers with the wheel, does not rotate with it
    }
  }
  if (spinners.length === 4) {
    car.userData.wheels = spinners;
    car.userData.hubs = hubs;
    // auto-level: source models are often exported slightly rolled/pitched;
    // measure the tilt from the four wheel centers and cancel it so all
    // contact patches land on one plane at y = 0
    const [fl, fr, rl, rr] = hubs.map(h => h.position);
    const roll = Math.atan2(((fr.y + rr.y) - (fl.y + rl.y)) / 2, ((fr.x + rr.x) - (fl.x + rl.x)) / 2);
    const pitch = Math.atan2(((fl.y + fr.y) - (rl.y + rr.y)) / 2, ((fl.z + fr.z) - (rl.z + rr.z)) / 2);
    const fix = new THREE.Euler(pitch, 0, -roll);
    const level = new THREE.Group();
    level.rotation.copy(fix);
    car.add(level);
    level.add(outer); // body inherits the correction (add keeps local pose)
    for (const hub of hubs) {
      hub.position.applyEuler(fix);
      hub.rotation.set(pitch, hub.rotation.y, -roll); // wheels stand upright too
    }
    // ride height: put the mean contact patch exactly at the car origin
    const contactY = hubs.reduce((a, h, i) => a + h.position.y - spinners[i].userData.radius, 0) / 4;
    level.position.y -= contactY;
    for (const hub of hubs) hub.position.y -= contactY;
    // the rival field is this same model, recoloured per team
    buildRivalModels(rivalSource, fix, contactY);
  }
  flashLap('CUSTOM CAR LOADED' + (spinners.length === 4 ? ' — wheels linked' : '') + ' — B rotates 90°');
}

const draco = new DRACOLoader();
draco.setDecoderPath(ASSET + 'draco/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(draco);
gltfLoader.load(ASSET + 'car.glb', g => attachCarModel(g.scene), undefined,
  () => {}); // no file — placeholder car stays

// steering wheel model: replaces the primitive wheel in the cockpit; the live
// LCD and LED strip stay, floating on the model's screen area
gltfLoader.load(ASSET + 'wheel.glb', g => {
  const model = g.scene;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = 0.37 / Math.max(size.x, size.y, size.z);
  model.scale.setScalar(scale);
  box.setFromObject(model);
  const c = box.getCenter(new THREE.Vector3());
  model.position.sub(c);
  // stand the wheel upright (model lies flat on export), face the screen
  // toward the driver, and rake it back like a real column
  const flip = new THREE.Group();
  flip.add(model);
  flip.rotation.set(-Math.PI / 2 + 0.30, Math.PI, 0);
  const wheelGroup = car.userData.steeringWheel;
  for (const part of car.userData.wheelPrimitives) part.visible = false;
  wheelGroup.add(flip);
  // seat the wheel inside the cockpit close to the driver — clearly behind
  // the halo strut so the two never overlap in cockpit view (user-tunable
  // via the setup panel, key O)
  applyWheelCfg();
  // seat the live LCD into the model's screen bezel: match the column rake,
  // shrink to the screen cutout, and drop the redundant procedural LEDs
  // (the model has its own baked light strip)
  const lcd = car.userData.lcdMesh;
  lcd.position.set(0, 0.045, -0.058);
  lcd.rotation.x = -0.30;
  lcd.scale.set(0.62, 0.62, 1);
  for (const led of car.userData.leds) led.visible = false;
}, undefined, () => {});

// ---------- cockpit setup panel (key O): wheel XYZ + driver eye tuning ----------
const CFG_DEF = { wx: -0.005, wy: 0.66, wz: 0.58, camBack: 0.265, camUp: 0.855, pitch: 0.12, fov: 66 };
let cfg = { ...CFG_DEF };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('ardennes.cockpit') || '{}')); } catch { /* fresh defaults */ }
function saveCfg() { localStorage.setItem('ardennes.cockpit', JSON.stringify(cfg)); }
function applyWheelCfg() {
  if (car.userData.imported) car.userData.steeringWheel.position.set(cfg.wx, cfg.wy, cfg.wz);
}
const SETUP_SLIDERS = [
  ['paneWheel', 'wx', 'X — left / right', -0.15, 0.15, 0.005],
  ['paneWheel', 'wy', 'Y — down / up', 0.55, 1.00, 0.005],
  ['paneWheel', 'wz', 'Z — pull back / push in', 0.40, 0.95, 0.005],
  ['paneDriver', 'camBack', 'Seat — into halo / back', -0.30, 0.40, 0.005],
  ['paneDriver', 'camUp', 'Eye — lower / higher', 0.75, 1.15, 0.005],
  ['paneDriver', 'pitch', 'View — down / up', -0.6, 0.8, 0.01],
  ['paneDriver', 'fov', 'Field of view', 55, 85, 1],
];
{
  const rows = [];
  for (const [pane, key, label, min, max, step] of SETUP_SLIDERS) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label>${label}<span class="val"></span></label>`;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min, max, step, value: cfg[key] });
    const val = row.querySelector('.val');
    const show = () => { val.textContent = key === 'fov' ? `${cfg[key]}°` : (+cfg[key]).toFixed(3); };
    input.addEventListener('input', () => {
      cfg[key] = +input.value;
      saveCfg(); applyWheelCfg(); show();
    });
    input.addEventListener('pointerup', () => input.blur()); // keep arrows on the car
    row.appendChild(input);
    document.getElementById(pane).appendChild(row);
    rows.push({ key, input, show });
    show();
  }
  const setTab = wheel => {
    document.getElementById('tabWheel').classList.toggle('active', wheel);
    document.getElementById('tabDriver').classList.toggle('active', !wheel);
    document.getElementById('paneWheel').style.display = wheel ? '' : 'none';
    document.getElementById('paneDriver').style.display = wheel ? 'none' : '';
  };
  document.getElementById('tabWheel').addEventListener('click', () => setTab(true));
  document.getElementById('tabDriver').addEventListener('click', () => setTab(false));
  document.getElementById('setupReset').addEventListener('click', () => {
    cfg = { ...CFG_DEF };
    saveCfg(); applyWheelCfg();
    for (const r of rows) { r.input.value = cfg[r.key]; r.show(); }
  });
}
function toggleSettings() {
  document.getElementById('settings').classList.toggle('open');
}

addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  file.arrayBuffer().then(buf => {
    if (name.endsWith('.stl')) {
      const geo = new STLLoader().parse(buf);
      geo.computeVertexNormals();
      attachCarModel(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.5, metalness: 0.3 })));
    } else if (name.endsWith('.glb') || name.endsWith('.gltf')) {
      new GLTFLoader().parse(buf, '', g => attachCarModel(g.scene), () => flashLap('MODEL LOAD FAILED'));
    } else flashLap('DROP AN .STL OR .GLB FILE');
  });
});

// ---------------------------------------------------------------------------
// Field, modes & sessions — Practice / Qualifying / Race, driven by the start
// menu. Rivals circulate the racing line at fixed paces (visual pace-setters,
// no collision). Positions rank by distance covered.
// ---------------------------------------------------------------------------
const RIVALS_DEF = [
  { name: 'VER', full: 'VERSTAPPEN', color: 0x1f3a93, lap: 136.0 },
  { name: 'LEC', full: 'LECLERC',    color: 0xd42020, lap: 137.6 },
  { name: 'RUS', full: 'RUSSELL',    color: 0x00a19c, lap: 139.2 },
  { name: 'PIA', full: 'PIASTRI',    color: 0xff8000, lap: 140.8 },
  { name: 'SAI', full: 'SAINZ',      color: 0xd42020, lap: 142.4 },
  { name: 'ALO', full: 'ALONSO',     color: 0x0a7d68, lap: 144.2 },
  { name: 'HAM', full: 'HAMILTON',   color: 0x00a19c, lap: 146.0 },
  { name: 'GAS', full: 'GASLY',      color: 0x2f6fb0, lap: 148.0 },
];
function makeRivalCar(color) {
  const grp = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, envMapIntensity: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.7, envMapIntensity: 0.4 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; grp.add(m); return m; };
  add(new THREE.BoxGeometry(0.86, 0.40, 3.8), body, 0, 0.50, 0);      // tub
  add(new THREE.BoxGeometry(0.42, 0.26, 1.6), body, 0, 0.44, 2.4);    // nose
  add(new THREE.BoxGeometry(1.90, 0.07, 0.5), dark, 0, 0.26, 3.15);   // front wing
  add(new THREE.BoxGeometry(0.50, 0.42, 0.8), body, 0, 0.82, -0.5);   // airbox
  add(new THREE.BoxGeometry(1.40, 0.46, 0.1), body, 0, 1.02, -2.0);   // rear wing
  add(new THREE.BoxGeometry(0.08, 0.40, 0.4), dark, 0.47, 0.80, -2.0);
  add(new THREE.BoxGeometry(0.08, 0.40, 0.4), dark, -0.47, 0.80, -2.0);
  const wg = new THREE.CylinderGeometry(0.34, 0.34, 0.36, 14);
  for (const [x, z] of [[0.72, 1.75], [-0.72, 1.75], [0.80, -1.7], [-0.80, -1.7]]) {
    const w = add(wg, tyre, x, 0.34, z); w.rotation.z = Math.PI / 2;
  }
  return grp;
}
// clone the player's model and recolour its livery to a team colour, keeping
// carbon/tyres dark; geometry is shared so eight clones stay cheap in memory
function recolorClone(source, color) {
  const clone = source.clone(true);
  clone.traverse(o => {
    if (!o.isMesh || !o.material) return;
    o.castShadow = false; o.receiveShadow = false;
    const recolor = m => {
      const c = m.clone();
      if (c.color) {
        const lum = 0.299 * c.color.r + 0.587 * c.color.g + 0.114 * c.color.b;
        if (lum > 0.12) c.color.setHex(color); // paint the livery, leave dark parts
      }
      if (c.emissive) c.emissive.setHex(0x000000);
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(recolor) : recolor(o.material);
  });
  return clone;
}
// swap each rival's placeholder box for a recoloured clone of the real model
function buildRivalModels(source, fix, contactY) {
  for (const r of rivals) {
    while (r.mesh.children.length) r.mesh.remove(r.mesh.children[0]);
    const wrap = new THREE.Group();
    wrap.rotation.copy(fix); wrap.position.y = -contactY;
    wrap.add(recolorClone(source, r.def.color));
    r.mesh.add(wrap);
  }
}

const rivalsGroup = new THREE.Group();
rivalsGroup.visible = false;
scene.add(rivalsGroup);
// each rival tracks a monotonic progress u (in laps) so laps/positions work
const rivals = RIVALS_DEF.map((def) => {
  const mesh = makeRivalCar(def.color);
  rivalsGroup.add(mesh);
  // dynamic driving state: v = speed (m/s), lat = offset from centre (m).
  // skill scales corner speed (fastest driver = highest); aggression drives
  // defending/overtaking; react = launch reaction delay at the start.
  const skill = 1.0 - (def.lap - 136) / 12 * 0.09;
  return { def, mesh, u: 0, v: 0, lat: 0, latV: 0, gridLat: null, skill, tire: 'M',
    aggr: 0.3 + Math.random() * 0.6, react: 0.12 + Math.random() * 0.35, errT: 3 + Math.random() * 6, errUntil: 0 };
});
const GRID_BLEND = 4.5; // seconds to merge from grid box onto the racing line
const idxAtU = u => Math.floor((((u % 1) + 1) % 1) * N) % N;
function placeRival(r) {
  const f = (((r.u % 1) + 1) % 1) * N;
  const i0 = Math.floor(f) % N, i1 = (i0 + 1) % N, frac = f - Math.floor(f);
  const a = P(i0), b = P(i1), n = normals[i0];
  const lat = r.lat != null ? r.lat : RACE[i0];
  const cx = a[0] + (b[0] - a[0]) * frac + n[0] * lat;
  const cz = a[2] + (b[2] - a[2]) * frac + n[1] * lat;
  r.mesh.position.set(cx, trackInfo(cx, cz, i0).y, cz);
  // heading = track tangent, nudged by lateral movement so darts read naturally
  r.mesh.rotation.y = Math.atan2(b[0] - a[0], b[2] - a[2]) + (r.latV || 0) * 0.03;
}

// ---------------------------------------------------------------------------
// Rival AI: dynamic speed (launch from standstill, brake for corners via the
// V_ALLOW profile) + lateral racecraft (pass / leave room / defend) + 2-way
// collision. Rivals stay parametrised by (u = laps, lat = m off centre) so they
// can never spin off, but they genuinely race within that.
// ---------------------------------------------------------------------------
function updateRivals(dt) {
  const racing = sess.mode === 'race';
  const pinfo = trackInfo(state.x, state.z, state.idx);
  const pu = playerDist() / TRACK_LEN, pLat = pinfo.lateral, pv = Math.hypot(state.vx, state.vz);

  // longitudinal: target V_ALLOW*skill, launch from 0, brake hard for corners
  for (const r of rivals) {
    const i = idxAtU(r.u);
    r.errT -= dt;
    if (r.errT <= 0) { r.errT = 5 + Math.random() * 7; r.errUntil = Math.random() < 0.22 ? 0.4 + Math.random() * 0.9 : 0; }
    if (r.errUntil > 0) r.errUntil -= dt;
    let vt = V_ALLOW[i] * r.skill * (r.errUntil > 0 ? 0.8 : 1);
    if (racing && sess.raceElapsed < r.react) vt = 0;      // reaction delay at lights-out
    const aMax = 12 * Math.max(0.16, 1 - r.v / 95);        // engine accel, tapers with speed
    if (r.v < vt) r.v = Math.min(vt, r.v + aMax * dt);
    else r.v = Math.max(vt, r.v - 42 * dt);                // hard braking (~4.3 g)
    if (r.v < 0) r.v = 0;
  }

  // lateral racecraft: pull out to pass a slower car, leave room when alongside
  const cars = rivals.map(r => ({ r, u: r.u, lat: r.lat, v: r.v }));
  cars.push({ r: null, u: pu, lat: pLat, v: pv });
  // at the start, hold grid formation and converge to the line over the run to T1
  const startMerge = racing ? Math.min(1, Math.max(0, sess.raceElapsed) / 6) : 1;
  for (const r of rivals) {
    const i = idxAtU(r.u);
    let target = RACE[i];
    if (racing && startMerge < 1 && r.gridLat != null) target = r.gridLat * (1 - startMerge) + RACE[i] * startMerge;
    const tight = Math.max(0.28, 1 - Math.abs(CURV[i]) * 22);   // hug the line in tight corners
    if (racing && startMerge > 0.35) {                          // racecraft only once away from the grid
      for (const o of cars) {
        if (o.r === r) continue;
        const ds = (o.u - r.u) * TRACK_LEN;
        if (ds < -5 || ds > 16) continue;
        const dlat = o.lat - r.lat;
        if (ds > 2.5 && Math.abs(dlat) < 3.2 && o.v < r.v - 1) target += (r.lat >= o.lat ? 1 : -1) * (2.6 + r.aggr * 1.5) * tight;
        else if (Math.abs(ds) <= 4 && Math.abs(dlat) < 3.0) target += (dlat > 0 ? -1 : 1) * 2.2 * tight;
      }
    }
    target = Math.max(-(HWm[i] - 1.0), Math.min(HWp[i] - 1.0, target));
    const nl = r.lat + Math.max(-6 * dt, Math.min(6 * dt, target - r.lat));
    r.latV = (nl - r.lat) / Math.max(dt, 1e-3); r.lat = nl;
  }

  for (const r of rivals) r.u += (r.v * dt) / TRACK_LEN;   // advance by speed

  // rival<->rival collision in (u,lat) space — momentum both ways
  const LEN = 4.6, WID = 1.9;
  for (let a = 0; a < rivals.length; a++) for (let b = a + 1; b < rivals.length; b++) {
    const r = rivals[a], o = rivals[b];
    const ds = (o.u - r.u) * TRACK_LEN, dlat = o.lat - r.lat;
    if (Math.abs(ds) < LEN && Math.abs(dlat) < WID) {
      const ovLat = WID - Math.abs(dlat), ovLon = LEN - Math.abs(ds);
      if (ovLat <= ovLon) { const p = ovLat / 2 * (dlat >= 0 ? 1 : -1); o.lat += p; r.lat -= p; r.v *= 0.99; o.v *= 0.99; }
      else { const p = (ovLon / 2) / TRACK_LEN; if (ds >= 0) { o.u += p; r.u -= p; r.v = Math.min(r.v, o.v); } else { r.u += p; o.u -= p; o.v = Math.min(o.v, r.v); } }
    }
  }

  for (const r of rivals) placeRival(r);
  // player<->rival, both ways: player shoved + scrubbed, rival knocked aside too
  if (racing && sess.phase === 'racing') {
    for (const r of rivals) {
      const rp = r.mesh.position;
      const dx = state.x - rp.x, dz = state.z - rp.z, d = Math.hypot(dx, dz);
      if (d < COLL_R && d > 1e-4) {
        const push = COLL_R - d, nx = dx / d, nz = dz / d;
        state.x += nx * push * 0.55; state.z += nz * push * 0.55;
        const vn = state.vx * nx + state.vz * nz;
        if (vn < 0) { state.vx -= nx * vn * 1.3; state.vz -= nz * vn * 1.3; }
        state.vx *= 0.95; state.vz *= 0.95;
        const ni = normals[idxAtU(r.u)];
        r.lat += -(nx * ni[0] + nz * ni[1]) * push * 0.55;
        r.v *= 0.95;
        placeRival(r);
      }
    }
  }
}
// world pose at a given progress (m) and lateral offset (m, + = left)
function poseAtGrid(prog, lat) {
  const f = (((prog / STEP) % N) + N) % N;
  const i0 = Math.floor(f) % N, i1 = (i0 + 1) % N, frac = f - Math.floor(f);
  const a = P(i0), b = P(i1), n = normals[i0];
  const x = a[0] + (b[0] - a[0]) * frac + n[0] * lat;
  const z = a[2] + (b[2] - a[2]) * frac + n[1] * lat;
  return { x, z, heading: Math.atan2(b[0] - a[0], b[2] - a[2]), idx: i0 };
}
const FIELD_N = RIVALS_DEF.length + 1;
const gridProgOf = slot => TRACK_LEN - 12 - slot * 8;   // pole nearest the line
const gridLatOf = slot => (slot % 2 === 0 ? -1 : 1) * 2.7; // 2-wide stagger

// painted grid-box markings, built once at the fixed grid positions
const gridBoxes = new THREE.Group();
gridBoxes.visible = false;
scene.add(gridBoxes);
{
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 140;
  const g2 = cv.getContext('2d');
  g2.strokeStyle = 'rgba(235,235,235,0.72)'; g2.lineWidth = 6;   // matte paint (less bloom glow)
  g2.strokeRect(5, 5, 54, 100);                       // start box
  g2.fillStyle = 'rgba(235,235,235,0.72)'; g2.fillRect(26, 108, 12, 26); // stub line
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const geo = new THREE.PlaneGeometry(2.4, 6.0);
  for (let slot = 0; slot < FIELD_N; slot++) {
    const p = poseAtGrid(gridProgOf(slot), gridLatOf(slot));
    // yaw a holder to the track heading (same as the cars), lay the box flat
    // inside it — so the box always lines up square with the track
    const holder = new THREE.Group();
    holder.position.set(p.x, trackInfo(p.x, p.z, p.idx).y + 0.02, p.z);
    holder.rotation.y = p.heading;
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    holder.add(m);
    gridBoxes.add(holder);
  }
}

// start-light gantry over the line, a few metres ahead of pole
const startLights = new THREE.Group();
startLights.visible = false;
scene.add(startLights);
const startLightBulbs = [];
{
  const gp = poseAtGrid(5, 0);
  const gy = trackInfo(gp.x, gp.z, gp.idx).y;
  const dark = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.7 });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(11, 0.7, 0.5), dark);
  bar.position.set(0, 6.2, 0); startLights.add(bar);
  for (const sx of [-5.4, 5.4]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 6.4, 0.35), dark);
    post.position.set(sx, 3.1, 0); startLights.add(post);
  }
  const bulbGeo = new THREE.CircleGeometry(0.42, 20);
  for (let i = 0; i < 5; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a0000, emissive: 0x000000 });
    const bulb = new THREE.Mesh(bulbGeo, mat);
    bulb.position.set(-3.6 + i * 1.8, 6.2, 0.28);
    startLights.add(bulb); startLightBulbs.push(mat);
  }
  startLights.position.set(gp.x, gy, gp.z);
  startLights.rotation.y = gp.heading;
}
function updateStartLights(lit, allOff) {
  for (let i = 0; i < 5; i++) {
    const on = !allOff && i < lit;
    startLightBulbs[i].color.setHex(on ? 0xff2200 : 0x2a0000);
    startLightBulbs[i].emissive.setHex(on ? 0xff1500 : 0x000000);
  }
}

// ---------------------------------------------------------------------------
// Pit crew — a small crew that swarms the car during a stop (cutscene)
// ---------------------------------------------------------------------------
function makeCrewman(color, gun) {
  const g = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.6 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xcf9b6f, roughness: 0.75 });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.32), suit); torso.position.y = 1.12; g.add(torso);
  const hip = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.34, 0.3), dark); hip.position.y = 0.74; g.add(hip);
  for (const s of [-1, 1]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.72, 0.22), dark); leg.position.set(s * 0.12, 0.36, 0); g.add(leg); }
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), skin); head.position.y = 1.55; g.add(head);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), suit); helmet.position.y = 1.57; helmet.scale.y = 0.9; g.add(helmet);
  for (const s of [-1, 1]) { const arm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.46, 0.15), suit); arm.position.set(s * 0.3, 1.12, 0.06); arm.rotation.x = -0.7; g.add(arm); }
  if (gun) {
    const wg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.55, 8), new THREE.MeshStandardMaterial({ color: 0xffb400, roughness: 0.5, metalness: 0.4 }));
    wg.rotation.x = Math.PI / 2; wg.position.set(0, 0.95, 0.42); g.add(wg); g.userData.gun = wg;
  }
  g.userData.suit = suit;   // exposed so podium figures can be recoloured per team
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}
const pitCrew = new THREE.Group(); pitCrew.visible = false; scene.add(pitCrew);
const crewGunners = [];
let crewLollipop, crewFrontJack;
{
  const RED = 0xf36a00;   // papaya, matching the McLaren player car
  const slots = [   // [x, z, faceY, gun]
    [1.7, 1.75, -Math.PI / 2, 1], [2.55, 1.75, -Math.PI / 2, 0],
    [-1.7, 1.75, Math.PI / 2, 1], [-2.55, 1.75, Math.PI / 2, 0],
    [1.7, -1.55, -Math.PI / 2, 1], [2.55, -1.55, -Math.PI / 2, 0],
    [-1.7, -1.55, Math.PI / 2, 1], [-2.55, -1.55, Math.PI / 2, 0],
    [0, -3.5, 0, 0],   // rear jack man
  ];
  for (const [x, z, fy, gun] of slots) {
    const c = makeCrewman(RED, gun);
    c.position.set(x, 0, z); c.rotation.y = fy; c.userData.phase = Math.random() * 6.28;
    pitCrew.add(c); if (gun) crewGunners.push(c);
  }
  const jm = makeCrewman(RED, 0); jm.position.set(0, 0, 3.7); jm.rotation.y = Math.PI; pitCrew.add(jm);
  crewFrontJack = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 1.4), new THREE.MeshStandardMaterial({ color: 0x1c1e22 }));
  crewFrontJack.position.set(0, 0.15, 3.0); pitCrew.add(crewFrontJack);
  const lm = makeCrewman(RED, 0); lm.position.set(0, 0, 4.5); lm.rotation.y = Math.PI; pitCrew.add(lm);
  crewLollipop = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 6), new THREE.MeshStandardMaterial({ color: 0x222222 })); pole.position.y = 1.1; crewLollipop.add(pole);
  const sign = new THREE.Mesh(new THREE.CircleGeometry(0.34, 20), new THREE.MeshBasicMaterial({ color: 0xf36a00, side: THREE.DoubleSide })); sign.position.y = 2.2; crewLollipop.add(sign);
  crewLollipop.userData.sign = sign; crewLollipop.position.set(0, 0, 4.3); pitCrew.add(crewLollipop);
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
  for (const [sx, sz] of [[3.3, 1.75], [-3.3, 1.75], [3.3, -1.55], [-3.3, -1.55]])
    for (let s = 0; s < 2; s++) { const ty = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 16), tyreMat); ty.position.set(sx, 0.12 + s * 0.26, sz); pitCrew.add(ty); }
  pitCrew.traverse(o => { if (o.isMesh) o.castShadow = true; });
}
function updatePitCrew(dt, now) {
  const on = state.pitFrozen;
  pitCrew.visible = on;
  if (!on) return;
  pitCrew.position.copy(car.position);
  pitCrew.rotation.y = state.heading;
  const svc = state.pitService, working = svc > 0.3 && svc < PIT_STOP_TIME - 0.3;
  for (const c of crewGunners) {
    c.position.y = working ? Math.sin(now / 90 + c.userData.phase) * 0.06 - 0.15 : 0;  // crouch + bob
    if (c.userData.gun) c.userData.gun.rotation.z += (working ? 30 : 0) * dt;
  }
  crewFrontJack.position.y = 0.15 + (working ? 0.12 : 0);
  const releasing = svc > PIT_STOP_TIME - 0.4;
  crewLollipop.rotation.x = releasing ? -1.2 : 0;
  crewLollipop.userData.sign.material.color.setHex(releasing ? 0x1fbf3a : 0xf36a00);
}

// Trackside broadcast cameras: elevated, on the outside of corners, spread
// around the lap. The TV/replay mode picks the nearest one and frames the car.
const TV_CAMS = [];
{
  // dense enough that there is always a close camera (a distant one shoots
  // through the forest); close to the track edge for a clean line to the car
  const step = Math.max(1, Math.floor(N / 48));
  for (let i = 0; i < N; i += step) {
    const p = P(i), n = normals[i];
    const side = Math.abs(CURV[i]) > 1e-4 ? -Math.sign(CURV[i]) : (i % 2 ? 1 : -1);
    const off = 13 + (i % 4) * 2;
    const cx = p[0] + n[0] * side * off, cz = p[2] + n[1] * side * off;
    // above the real ground here (track height buries cams on the hills), floored
    // at track+7 so a dip below the track can't put it underground
    TV_CAMS.push(new THREE.Vector3(cx, Math.max(terrainHeight(cx, cz), p[1]) + 8, cz));
  }
}

// ---------------------------------------------------------------------------
// Podium — post-race ceremony beside the start/finish line
// ---------------------------------------------------------------------------
const podium = new THREE.Group(); podium.visible = false; scene.add(podium);
const podiumFigs = [], podiumTrophies = [];
let confetti, podiumActive = false, podiumT = 0;
const PODIUM_SLOTS = [[0, 1.7], [2.2, 1.3], [-2.2, 1.0]];   // [x, height] for P1 (centre), P2 (left), P3 (right)
{
  const tierMat = new THREE.MeshStandardMaterial({ color: 0xe2e4ea, roughness: 0.7 });
  for (const [tx, h] of PODIUM_SLOTS) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.0, h, 1.6), tierMat);
    box.position.set(tx, h / 2, 0); box.castShadow = true; box.receiveShadow = true; podium.add(box);
  }
  const board = new THREE.Mesh(new THREE.BoxGeometry(8.2, 2.7, 0.2), new THREE.MeshStandardMaterial({ color: 0x0b1220, roughness: 0.8 }));
  board.position.set(0, 2.75, 1.3); podium.add(board);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.45, 0.22), new THREE.MeshStandardMaterial({ color: 0xe10600 }));
  strip.position.set(0, 3.95, 1.29); podium.add(strip);
  for (let k = 0; k < 3; k++) {
    const fig = makeCrewman(0xffffff, 0); podium.add(fig); podiumFigs.push(fig);
    const tr = new THREE.Group();
    const gold = new THREE.MeshStandardMaterial({ color: 0xffd34d, metalness: 0.7, roughness: 0.3 });
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.09, 0.34, 12), gold); cup.position.y = 0.28; tr.add(cup);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.14, 8), gold); stem.position.y = 0.06; tr.add(stem);
    tr.visible = false; podium.add(tr); podiumTrophies.push(tr);
  }
  const CN = 320, pos = new Float32Array(CN * 3), col = new Float32Array(CN * 3);
  const cc = [[0.92, 0.12, 0.12], [0.12, 0.42, 0.92], [0.96, 0.82, 0.12], [0.12, 0.82, 0.32], [0.95, 0.95, 0.95]];
  for (let i = 0; i < CN; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 10; pos[i * 3 + 1] = Math.random() * 8; pos[i * 3 + 2] = (Math.random() - 0.5) * 5;
    const c = cc[i % cc.length]; col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); cg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  confetti = new THREE.Points(cg, new THREE.PointsMaterial({ size: 0.18, vertexColors: true }));
  podium.add(confetti);
  const gp = poseAtGrid(34, 0), n = normals[gp.idx];
  const px = gp.x + n[0] * 13, pz = gp.z + n[1] * 13;
  podium.position.set(px, trackInfo(px, pz, gp.idx).y, pz);
  podium.rotation.y = Math.atan2(n[0], n[1]);   // figures face the track (-normal), board behind them
  podium.userData.toTrack = new THREE.Vector3(-n[0], 0, -n[1]);   // camera sits on the track side
}
function showPodium(top3) {
  for (let k = 0; k < 3; k++) {
    const [x, h] = PODIUM_SLOTS[k], fig = podiumFigs[k], tr = podiumTrophies[k];
    fig.position.set(x, h, 0); fig.rotation.y = Math.PI;
    fig.userData.suit.color.setHex(top3[k] ? top3[k].color : 0x888888);
    tr.position.set(x + 0.32, h + 0.9, 0.2); tr.visible = !!top3[k]; tr.scale.setScalar(k === 0 ? 1.5 : 1);
  }
  podium.visible = true; podiumActive = true; podiumT = 0;
}
function updateConfetti(dt) {
  if (!podiumActive) return;
  const p = confetti.geometry.attributes.position, a = p.array;
  for (let i = 0; i < a.length; i += 3) {
    a[i + 1] -= (1.2 + (i % 7) * 0.15) * dt;
    a[i] += Math.sin(podiumT * 2 + i) * 0.004;
    if (a[i + 1] < 0) a[i + 1] = 8;
  }
  p.needsUpdate = true;
}

const fmtShort = ms => !isFinite(ms) ? '—'
  : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`;
const $id = id => document.getElementById(id);
const idxAtProg = m => ((Math.round(m / STEP) % N) + N) % N;

// menu selections + live session state
const menu = { mode: 'race', laps: 5, qmin: 5, startGarage: false };
const sess = { mode: 'menu', running: false, timeLeft: 0, laps: 5 };

// race distance measured from the start line (negative while on the grid,
// which sits behind the line — so grid order and lap counting line up)
const playerDist = () => state.lap * TRACK_LEN + state.prog - TRACK_LEN;
const rivalDist = r => r.u * TRACK_LEN;
const playerRacePos = () => rivals.filter(r => rivalDist(r) > playerDist()).length + 1;

function clearPlayerLaps() {
  state.lap = 0; state.best = null; state.last = null; state.bestT = null;
  state.running = false; state.curT.fill(-1);
  // reset sector timing (fresh best sectors each session)
  state.sec = 0; state.secStart = 0; state.secLap = [null, null, null];
  state.secBest = [null, null, null]; state.secCol = ['', '', ''];
  // reset ERS (start with a useful charge) + DRS
  state.ers = 0.7; state.ersDeploy = false; state.ersOT = false;
  state.drsAvail = false; state.drsOpen = false; state.drsAnn = false;
  // fresh tyres/fuel + cleared penalties each session (keep brake-bias/mix setup)
  state.tireTemp = [90, 90, 88, 88]; state.fuel = 100;
  state.lapInvalid = false; state.trackStrikes = 0; state.penalty = 0; state.blueFlag = false; state.wasOff = false;
  // fresh tyres of the chosen compound, and a clean pit state, each session
  state.tire = { compound: state.nextCompound || 'M', wear: 0 };
  state.pitRun = false; state.pitLimiter = false;
  state.pitService = 0; state.pitServiced = false; state.pitFrozen = false;
}
function showTower(on) { $id('tower').classList.toggle('show', on); }

function startRace(playerGrid) {
  sess.mode = 'race'; sess.running = true; sess.laps = menu.laps;
  sess.phase = 'lights'; sess.lightT = 0; sess.lights = 0;
  sess.hold = 0.7 + Math.random() * 1.6;      // suspense before lights out
  sess.raceElapsed = -1e9;                     // frozen on the grid until GO
  rivalsGroup.visible = true; showTower(true);
  gridBoxes.visible = true; startLights.visible = true;
  updateStartLights(0, false);
  // rival starting tyres: a mixed grid (mostly mediums, some softs/hards)
  rivals.forEach(r => { const x = Math.random(); r.tire = x < 0.55 ? 'M' : x < 0.82 ? 'S' : 'H'; });
  // pole = fastest; player slots in at playerGrid (default: the back)
  const order = rivals.slice().sort((a, b) => a.def.lap - b.def.lap);
  const pg = playerGrid != null ? playerGrid : rivals.length;
  const field = [];
  let ri = 0;
  for (let slot = 0; slot <= rivals.length; slot++) field.push(slot === pg ? 'player' : order[ri++]);
  field.forEach((ent, slot) => {
    const gp = gridProgOf(slot), lat = gridLatOf(slot);
    if (ent === 'player') {
      const p = poseAtGrid(gp, lat);
      state.x = p.x; state.z = p.z; state.heading = p.heading; state.idx = p.idx;
      state.vx = state.vz = 0; state.steer = 0;
      state.r = 0; state.thr = 0; state.brk = 0; state.ax = 0; state.axSm = 0;
      clearPlayerLaps(); state.prog = gp;
    } else {
      ent.u = gp / TRACK_LEN - 1; ent.gridLat = lat; ent.lat = lat; ent.v = 0; placeRival(ent);
    }
  });
  flashLap(`RACE — ${menu.laps} laps — lights out and away we go`);
  updateModeBar(); updateTower();
}

function qualiSlot() {
  const pb = state.best || Infinity;
  return rivals.filter(r => r.def.lap * 1000 < pb).length; // 0 = pole
}
function endQuali() {
  sess.running = false;
  const slot = qualiSlot();
  flashLap(state.best ? `QUALIFYING OVER — you start P${slot + 1} — lights out!` : 'NO LAP SET — starting at the back');
  startRace(slot);
}
function endRace() {
  sess.running = false;
  const order = rivals.map(r => ({ name: r.def.full || r.def.name, color: r.def.color, dist: rivalDist(r), you: false }))
    .concat([{ name: 'YOU', color: 0xf36a00, dist: playerDist() - state.penalty * 68, you: true }])   // time penalty in the classification
    .sort((a, b) => b.dist - a.dist);
  const pos = order.findIndex(e => e.you) + 1;
  $id('resultPos').textContent = 'P' + pos;
  $id('resultGrid').innerHTML = order.map((e, i) =>
    `<div class="r${e.you ? ' you' : ''}"><span class="p">P${i + 1}</span><span class="n">${e.name}${e.you && state.penalty > 0 ? ` <small style="opacity:.7">(+${state.penalty}s)</small>` : ''}</span></div>`).join('');
  // podium ceremony plays first, then the full classification appears over it
  showPodium(order.slice(0, 3));
  setTimeout(() => $id('results').classList.add('show'), 4200);
}

function updateModeBar() {
  const el = $id('modebar');
  if (sess.mode === 'practice') { el.textContent = 'PRACTICE'; return; }
  if (sess.mode === 'quali') {
    const t = Math.max(0, sess.timeLeft);
    el.innerHTML = `<span class="q">QUALIFYING</span><span class="clock">${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}</span>`;
  } else if (sess.mode === 'race') {
    if (sess.phase === 'lights') { el.innerHTML = `<span class="q">RACE</span><span class="clock">GET READY</span>`; return; }
    const lap = Math.min(Math.max(state.lap, 1), sess.laps);
    el.innerHTML = `<span class="q">RACE</span><span class="clock">LAP ${lap}/${sess.laps} · P${playerRacePos()}</span>`;
  }
}
const TYRE_COL = { S: '#e5342b', M: '#e8c43a', H: '#e9edf2' };
function tyreDot(comp) {
  const c = TYRE_COL[comp] || '#e8c43a';
  return `<span class="tyre" style="border-color:${c};color:${c}">${comp}</span>`;
}
function towerRow(row) {
  const col = '#' + row.color.toString(16).padStart(6, '0');
  return `<div class="r${row.you ? ' you' : ''}${row.fastest ? ' fastest' : ''}">`
    + `<span class="pos">${row.pos}</span>`
    + `<span class="bar" style="background:${col}"></span>`
    + `<span class="nm">${row.name}</span>`
    + tyreDot(row.tyre)
    + `<span class="gap">${row.gap}</span></div>`;
}
function updateTower() {
  const el = $id('tower');
  if (sess.mode === 'race') {
    // fastest-lap holder gets the purple name (rivals use their nominal pace)
    let flName = null, flBest = Infinity;
    for (const r of rivals) { const t = r.def.lap * 1000; if (t < flBest) { flBest = t; flName = r.def.name; } }
    if (state.best && state.best < flBest) flName = 'YOU';
    const rows = rivals.map(r => ({ id: r.def.name, name: r.def.full || r.def.name, color: r.def.color,
      dist: rivalDist(r), v: r.v, tyre: r.tire, you: false }));
    rows.push({ id: 'YOU', name: 'YOU', color: 0xffffff, dist: playerDist(),
      v: Math.hypot(state.vx, state.vz), tyre: state.tire.compound, you: true });
    rows.sort((a, b) => b.dist - a.dist);
    const lead = rows[0].dist, racing = sess.phase === 'racing';
    const lap = Math.min(Math.max(state.lap, 1), sess.laps);
    el.innerHTML = `<div class="th"><span>RACE ORDER</span><span class="laps">LAP ${lap}/${sess.laps}</span></div>`
      + rows.map((r, i) => towerRow({
        pos: i + 1, color: r.color, name: r.name, tyre: r.tyre, you: r.you, fastest: r.id === flName,
        gap: racing ? (i === 0 ? '' : '+' + ((lead - r.dist) / Math.max(r.v, 30)).toFixed(1)) : '',
      })).join('');
  } else if (sess.mode === 'quali') {
    const rows = rivals.map(r => ({ name: r.def.full || r.def.name, color: r.def.color, ms: r.def.lap * 1000, tyre: r.tire, you: false }));
    rows.push({ name: 'YOU', color: 0xffffff, ms: state.best || Infinity, tyre: state.tire.compound, you: true });
    rows.sort((a, b) => a.ms - b.ms);
    el.innerHTML = '<div class="th"><span>QUALIFYING</span></div>' + rows.map((r, i) =>
      towerRow({ pos: i + 1, color: r.color, name: r.name, tyre: r.tyre, gap: fmtShort(r.ms), you: r.you, fastest: i === 0 })).join('');
  }
}
function updateSession(dt) {
  if (sess.mode === 'menu') return;
  if (sess.mode === 'race') {
    if (sess.phase === 'lights') {
      sess.lightT += dt;
      sess.lights = Math.min(5, Math.floor(sess.lightT)); // one red light per second
      updateStartLights(sess.lights, false);
      const sl = $id('startlights'); sl.classList.add('show'); sl.classList.remove('go');
      [...sl.children].forEach((c, k) => c.classList.toggle('on', k < sess.lights));
      if (sess.lightT >= 5 + sess.hold) {          // all five held, then out
        sess.phase = 'racing'; sess.raceElapsed = 0;
        updateStartLights(0, true); startLights.visible = false;
        [...sl.children].forEach(c => c.classList.remove('on'));
        sl.classList.add('go'); setTimeout(() => sl.classList.remove('show', 'go'), 1000);  // flash green, then clear
        flashLap('GO GO GO!');
      }
    } else if (sess.running) {
      sess.raceElapsed += dt;
      updateRivals(dt);
      if (playerDist() >= sess.laps * TRACK_LEN) { endRace(); sess.running = false; gridBoxes.visible = false; }
    }
    updateModeBar(); updateTower();
    return;
  }
  if (sess.running) {  // quali
    for (const r of rivals) { r.u += dt / r.def.lap; placeRival(r); }
    sess.timeLeft -= dt;
    if (sess.timeLeft <= 0) { sess.timeLeft = 0; endQuali(); }
  }
  updateModeBar();
  if (sess.mode !== 'practice') updateTower();
}

// start menu wiring
// place the car stopped in its pit box, limiter armed, ready to peel out
function placeInGarage() {
  const pb = pitBoxes[PLAYER_BOX], nd = pitPath[pb.k], t = tangents[nd.i];
  state.x = nd.x; state.z = nd.z; state.idx = nd.i;
  state.heading = Math.atan2(t[0], t[1]);
  state.vx = state.vz = 0; state.r = 0; state.thr = 0; state.brk = 0; state.steer = 0;
  state.pitK = pb.k; state.pitRun = true; state.pitLimiter = true;
  state.pitServiced = true; state.pitService = 0; state.pitFrozen = false;
}
function startGame(mode) {
  $id('title').style.display = 'none';
  $id('results').classList.remove('show');
  document.body.classList.add('driving');   // reveal the touch controls
  if (!started) { started = true; initAudio(); }
  if (mode === 'practice') {
    sess.mode = 'practice'; sess.running = false;
    rivalsGroup.visible = false; showTower(false);
    clearPlayerLaps();
    if (menu.startGarage) { placeInGarage(); flashLap('IN THE GARAGE — drive out down the pit lane'); }
    else { state.idx = 0; resetCar(); flashLap('PRACTICE — free running'); }
  } else if (mode === 'quali') {
    sess.mode = 'quali'; sess.running = true; sess.timeLeft = menu.qmin * 60;
    rivalsGroup.visible = true; showTower(true);
    rivals.forEach((r) => { r.u = Math.random(); r.lat = RACE[idxAtU(r.u)]; r.v = V_ALLOW[idxAtU(r.u)] * r.skill * 0.85; r.tire = 'S'; placeRival(r); });
    // start ~300 m back on the pit straight (just past the Bus Stop) so there's
    // room to wind up before the line and start the flying lap at speed
    const qi = ((Math.round((TRACK_LEN - 300) / STEP)) % N + N) % N;
    state.idx = qi; resetCar(); clearPlayerLaps(); state.prog = qi * STEP;
    flashLap(`QUALIFYING — ${menu.qmin}:00 — build speed, then set your lap`);
  } else {
    startRace(null);
  }
  updateModeBar();
}
function backToMenu() {
  sess.mode = 'menu'; sess.running = false; tvMode = false;
  podiumActive = false; podium.visible = false;
  rivalsGroup.visible = false; showTower(false);
  $id('results').classList.remove('show');
  $id('title').style.display = 'flex';
  document.body.classList.remove('driving');   // hide the touch controls on the menu
  state.idx = 0; resetCar(); clearPlayerLaps();
  $id('modebar').textContent = '';
  $id('startlights').classList.remove('show', 'go');
}

// fullscreen: hides the mobile browser chrome (address bar) in landscape.
// Works on Android; on iOS use "Add to Home Screen" (web-app meta handles that).
const _fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
function goFullscreen() {
  const el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req && !_fsEl()) { try { const p = req.call(el); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
}
function toggleFullscreen() {
  if (_fsEl()) { (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document); }
  else goFullscreen();
}

{
  const modes = document.querySelectorAll('.modes .mode');
  modes.forEach(b => b.addEventListener('click', () => {
    modes.forEach(x => x.classList.remove('active')); b.classList.add('active');
    menu.mode = b.dataset.mode;
    $id('optRaceLaps').style.display = menu.mode === 'race' ? '' : 'none';
    $id('optQualiMin').style.display = menu.mode === 'quali' ? '' : 'none';
    $id('optPractice').style.display = menu.mode === 'practice' ? '' : 'none';
  }));
  document.querySelectorAll('.seg').forEach(seg => seg.querySelectorAll('button').forEach(btn =>
    btn.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('on')); btn.classList.add('on');
      if (seg.dataset.opt === 'laps') menu.laps = +btn.dataset.v;
      else if (seg.dataset.opt === 'qmin') menu.qmin = +btn.dataset.v;
      else if (seg.dataset.opt === 'start') menu.startGarage = btn.dataset.v === 'garage';
      else if (seg.dataset.opt === 'quality' && btn.dataset.v !== QUALITY) { localStorage.setItem('ardennes.quality', btn.dataset.v); location.reload(); }
    })));
  document.querySelector('#optQuality button[data-v="' + QUALITY + '"]')?.classList.add('on');   // reflect current quality
  $id('startBtn').addEventListener('click', () => { if (IS_TOUCH) goFullscreen(); startGame(menu.mode); });   // phones go fullscreen on start
  $id('resultBtn').addEventListener('click', backToMenu);
}

// on-screen touch controls for phones: steering, pedals, DRS/ERS, reset, menu
if (IS_TOUCH) document.body.classList.add('touch');
{
  const hold = (id, on, off) => {
    const el = $id(id); if (!el) return;
    el.addEventListener('pointerdown', e => { e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch (_) {} el.classList.add('active'); on(); });
    const end = () => { el.classList.remove('active'); off(); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
  };
  const tap = (id, fn) => {
    const el = $id(id); if (!el) return;
    el.addEventListener('pointerdown', e => { e.preventDefault(); el.classList.add('active'); fn(); });
    const end = () => el.classList.remove('active');
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  };
  hold('tcLeft', () => (input.left = true), () => (input.left = false));
  hold('tcRight', () => (input.right = true), () => (input.right = false));
  hold('tcGas', () => (input.throttle = 1), () => (input.throttle = 0));
  hold('tcBrake', () => (input.brake = 1), () => (input.brake = 0));
  hold('tcErs', () => (input.overtake = true), () => (input.overtake = false));
  tap('tcDrs', () => (input.drsWant = true));
  tap('tcReset', () => resetCar());
  tap('tcMenu', () => backToMenu());
  tap('tcFull', () => toggleFullscreen());
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const camPos = new THREE.Vector3();
let prevCamMode = null;   // remembers your view while a cinematic camera takes over
let camInit = false;
let acc = 0, lastT = performance.now(), lcdAcc = 0, pitchSm = 0, slopeSm = 0;
const FIXED = 1 / 120;

// HUD shift-light strip: 15 LEDs, lit by rpm, all flashing blue at the limiter
const shiftEls = [];
{ const sl = document.getElementById('shiftlights');
  for (let i = 0; i < 15; i++) { const s = document.createElement('span'); sl.appendChild(s); shiftEls.push(s); } }
function updateShiftLights(rpmFrac, driving, flash) {
  document.getElementById('shiftlights').classList.toggle('show', !!driving);
  if (!driving) return;
  const lit = Math.round(rpmFrac * 15);
  for (let i = 0; i < 15; i++) shiftEls[i].className = flash ? 'b' : (i < lit ? (i < 9 ? 'g' : 'r') : '');
}

function frame() {
  if (window.__gen !== GEN) return; // a newer module instance took over
  requestAnimationFrame(frame);
  const now = performance.now();
  let dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;

  // hold the car on the grid until the lights go out — and in the box mid-stop
  if ((sess.mode === 'race' && sess.phase === 'lights') || state.pitFrozen) {
    input.throttle = 0; input.brake = 0;
    state.vx = 0; state.vz = 0; state.thr = 0; state.r = 0;
  }
  if (started) {
    acc += dt;
    while (acc >= FIXED) { physStep(FIXED); acc -= FIXED; }
  }

  // place car on track surface
  const info = trackInfo(state.x, state.z, state.idx);
  const speed = Math.hypot(state.vx, state.vz);
  car.position.set(state.x, info.y, state.z);
  // YXZ: yaw first, so pitch tilts about the car's own lateral axis —
  // with the default XYZ order, slope pitch leaks into roll when yawed
  car.rotation.order = 'YXZ';
  car.rotation.y = state.heading;
  // pitch/roll from track gradient, low-passed so data noise never shakes the body
  const ahead = trackInfo(state.x + Math.sin(state.heading) * 6, state.z + Math.cos(state.heading) * 6, state.idx);
  const pitchTarget = Math.atan2(info.y - ahead.y, 6) * 0.9;
  pitchSm += (pitchTarget - pitchSm) * (1 - Math.exp(-dt * 10));
  car.rotation.x = pitchSm;
  car.rotation.z = -state.steer * Math.min(speed * 0.004, 0.05);
  for (const w of car.userData.wheels) w.rotation.x += speed / (w.userData.radius || 0.44) * dt;
  for (const h of car.userData.hubs) if (h.userData.front) h.rotation.y = state.steer * 0.35;
  car.userData.steeringWheel.rotation.z = -state.steer * 1.6;

  // cinematic cameras (pit stop, podium, race-start, broadcast) play in the
  // chase view — if you're in cockpit or nose-pod, drop to the main camera for
  // the duration (clearing the cockpit vignette) and restore your view after
  const inCinematic = state.pitFrozen || podiumActive || tvMode || (sess.mode === 'race' && sess.phase === 'lights');
  if (inCinematic && prevCamMode === null && camMode !== 0) {
    prevCamMode = camMode; camMode = 0; document.body.classList.remove('cockpit');
  } else if (!inCinematic && prevCamMode !== null) {
    camMode = prevCamMode; prevCamMode = null; document.body.classList.toggle('cockpit', camMode >= 1);
  }

  // camera
  const fwdX = Math.sin(state.heading), fwdZ = Math.cos(state.heading);
  // uphill positive: tilt the view with the road; low-passed to keep the horizon steady
  slopeSm += ((ahead.y - info.y) / 6 - slopeSm) * (1 - Math.exp(-dt * 8));
  const slope = slopeSm;
  let target, cockpitLook = null;
  if (camMode === 0) {
    target = new THREE.Vector3(state.x - fwdX * 8.5, info.y + 3.1 - slope * 3.5, state.z - fwdZ * 8.5);
  } else if (camMode === 1) {
    // cockpit: the eye is BOLTED to the chassis frame (like a real onboard
    // bolted to the halo), so through Eau Rouge's dive-and-climb the halo
    // holds a constant distance instead of swinging into the lens. Position
    // and look-point both ride the car's pitch; camera.up stays world-up so
    // steering roll only nudges the frame sideways a hair, never rolls it.
    car.updateMatrixWorld(true);
    target = new THREE.Vector3(0, cfg.camUp, -cfg.camBack).applyMatrix4(car.matrixWorld);
    cockpitLook = new THREE.Vector3(0, cfg.pitch, 14).applyMatrix4(car.matrixWorld);
  } else {
    // nose pod: the higher over-cockpit view
    target = new THREE.Vector3(state.x - fwdX * 0.15, info.y + 1.26, state.z - fwdZ * 0.15);
  }
  if (!camInit) { camPos.copy(target); camInit = true; }
  const k = camMode === 0 ? 1 - Math.exp(-dt * 12) : 1;
  camPos.lerp(target, k);
  // off-track shake
  if (!onTrackState && speed > 8) {
    camPos.x += (Math.random() - 0.5) * 0.15;
    camPos.y += (Math.random() - 0.5) * 0.12;
  }
  camera.position.copy(camPos);
  if (cockpitLook) {
    camera.lookAt(cockpitLook);
  } else {
    camera.lookAt(state.x + fwdX * 14, info.y + 1.0 + slope * 14, state.z + fwdZ * 14);
  }
  camera.fov = (camMode === 0 ? 68 : camMode === 1 ? cfg.fov : 82) + Math.min(speed * 0.12, 14);
  camera.updateProjectionMatrix();

  // cinematic camera overrides: podium, pit stop, race-start grid intro, TV/replay
  if (podiumActive) {
    podiumT += dt;
    const tt = podium.userData.toTrack, sway = Math.sin(podiumT * 0.35) * 2;
    camera.position.set(podium.position.x + tt.x * 13 - tt.z * sway, podium.position.y + 5.0, podium.position.z + tt.z * 13 + tt.x * sway);
    camera.lookAt(podium.position.x, podium.position.y + 2.2, podium.position.z);
    camera.fov = 40; camera.updateProjectionMatrix();
  } else if (state.pitFrozen) {
    car.updateMatrixWorld(true);
    const c = new THREE.Vector3(6.2, 2.4, 3.4).applyMatrix4(car.matrixWorld);
    camPos.lerp(c, 1 - Math.exp(-dt * 5));
    camera.position.copy(camPos);
    camera.lookAt(car.position.x, car.position.y + 0.7, car.position.z);
    camera.fov = 46; camera.updateProjectionMatrix();
  } else if (sess.mode === 'race' && sess.phase === 'lights' && sess.lightT < 4) {
    // grid intro: slow low orbit while the first lights build, then (lightT >= 4)
    // hand back to the driving view so you settle in and watch the last lights go
    // out from the cockpit — you get the launch, not a camera cut at lights-out
    const a = sess.lightT * 0.5 + 1.4, R = 11;
    camPos.lerp(new THREE.Vector3(state.x + Math.sin(a) * R, info.y + 2.7, state.z + Math.cos(a) * R), 1 - Math.exp(-dt * 4));
    camera.position.copy(camPos);
    camera.lookAt(state.x, info.y + 0.6, state.z);
    camera.fov = 38; camera.updateProjectionMatrix();
  } else if (tvMode) {
    // nearest trackside camera, framing the car with a long lens when far
    let best = TV_CAMS[0], bd = 1e18;
    for (const cpos of TV_CAMS) { const d = cpos.distanceToSquared(car.position); if (d < bd) { bd = d; best = cpos; } }
    camera.position.copy(best);
    camera.lookAt(car.position.x, car.position.y + 0.5, car.position.z);
    camera.fov = Math.max(14, Math.min(40, 1600 / Math.max(20, Math.sqrt(bd))));
    camera.updateProjectionMatrix();
  }

  // sun shadow follows car
  sun.position.set(state.x - 350, info.y + 500, state.z + 200);
  sun.target.position.set(state.x, info.y, state.z);

  const kmh = speed * 3.6;
  const rpmFrac = updateHUD(kmh);
  // rev lights: wheel LEDs + HUD shift strip, flashing blue at the limiter
  const lit = Math.round(rpmFrac * 12);
  const limiterFlash = rpmFrac > 0.985 && Math.floor(now / 55) % 2 === 0;
  car.userData.leds.forEach((led, k) => {
    led.visible = limiterFlash || k < lit;
    led.material.color.setHex(limiterFlash ? 0x2040ff : (k < 6 ? 0x1fbf3a : k < 9 ? 0xd82020 : 0x2040ff));
  });
  updateShiftLights(rpmFrac, sess.mode !== 'menu', limiterFlash);
  // rear-wing DRS flap lies flat when open
  if (car.userData.drsFlap) {
    const f = car.userData.drsFlap;
    f.rotation.x += ((state.drsOpen ? -0.05 : -0.5) - f.rotation.x) * Math.min(1, dt * 12);
  }

  // kerb rumble: shake the camera when riding the painted kerbs
  const hwK = info.lateral > 0 ? HWp[info.idx] : HWm[info.idx];
  const onKerb = Math.abs(info.lateral) > hwK - 0.25 &&
                 Math.abs(info.lateral) < hwK + KERB_W + 0.3 &&
                 Math.abs(C(info.idx)) > 0.003;
  if (onKerb && speed > 8) {
    camPos.y += (Math.random() - 0.5) * 0.025;
    camPos.x += (Math.random() - 0.5) * 0.015;
  }

  // steering-wheel LCD (redrawn ~10x/s): gear, speed, ERS battery + mode, delta
  lcdAcc += dt;
  if (lcdAcc > 0.1) {
    lcdAcc = 0;
    const { ctx, tex } = car.userData.lcd;
    ctx.fillStyle = '#0a0e12'; ctx.fillRect(0, 0, 256, 160);
    ctx.strokeStyle = '#2a3644'; ctx.lineWidth = 3; ctx.strokeRect(2, 2, 252, 156);
    // gear (big, centre)
    ctx.fillStyle = '#e8eef4'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '900 74px Arial';
    ctx.fillText(kmh < 3 ? 'N' : String(gearAt(kmh) + 1), 128, 66);
    // speed (top-left) + lap (top-right)
    ctx.font = 'bold 26px Arial'; ctx.textAlign = 'left'; ctx.fillStyle = '#e8eef4';
    ctx.fillText(String(Math.round(kmh)), 12, 24);
    ctx.font = '12px Arial'; ctx.fillStyle = '#8899aa'; ctx.fillText('KM/H', 12, 42);
    ctx.textAlign = 'right'; ctx.font = 'bold 20px Arial'; ctx.fillStyle = '#e8eef4';
    ctx.fillText('L' + Math.max(state.lap, 0), 246, 22);
    // ERS battery bar (bottom-left)
    ctx.fillStyle = '#8899aa'; ctx.font = '12px Arial'; ctx.textAlign = 'left';
    ctx.fillText('BATT ' + Math.round(state.ers * 100) + '%', 12, 114);
    ctx.fillStyle = '#1a2430'; ctx.fillRect(12, 124, 110, 12);
    ctx.fillStyle = state.ersOT ? '#ffd34d' : state.ersDeploy ? '#39d0ff' : '#25c46a';
    ctx.fillRect(12, 124, 110 * state.ers, 12);
    // ERS mode (bottom-right)
    ctx.textAlign = 'right'; ctx.font = 'bold 15px Arial';
    ctx.fillStyle = state.ersOT ? '#ffd34d' : state.ersDeploy ? '#39d0ff' : '#8899aa';
    ctx.fillText(state.ersOT ? 'OVERTAKE' : state.ersDeploy ? 'DEPLOY' : (state.brk > 0.05 ? 'HARVEST' : 'BALANCED'), 246, 114);
    // delta (centre) + DRS flag when open
    if (state.deltaStr) {
      ctx.textAlign = 'center'; ctx.font = 'bold 22px Arial';
      ctx.fillStyle = state.deltaAhead ? '#4be07a' : '#ff6060';
      ctx.fillText(state.deltaStr, 128, 148);
    }
    if (state.drsOpen) {
      ctx.fillStyle = '#25e05a'; ctx.fillRect(196, 140, 40, 16);
      ctx.fillStyle = '#04240f'; ctx.font = '900 11px Arial'; ctx.textAlign = 'center';
      ctx.fillText('DRS', 216, 148);
    }
    tex.needsUpdate = true;
  }

  updateAudio(rpmFrac, input.throttle, speed);
  updatePitStop(dt);
  updatePitCrew(dt, now);
  updateConfetti(dt);
  updateSession(dt);
  drawMinimap();

  if (composer) composer.render(); else renderer.render(scene, camera);
  renderRearView();
}
frame();

// debug/testing hook
window.__game = { state, input, trackInfo, tangents, resetCar, P, N, STEP, scene, CURV, camera, camPos, renderer, physStep, rivals, sess, placeRival, car,
  placeInGarage, updateHUD, updateSession, updateRivals, startRace, drawMinimap, updateTower, updateCarSystems, updateShiftLights, updatePitCrew, pitCrew, TV_CAMS, showPodium, podium, endRace, composer, renderRearView, menu, startGame, V_ALLOW, RACE, TRACK_LEN, idxAtU, DRS_ZONES, inDrsZone,
  pit: { pitPath, pitBoxes, PLAYER_BOX, PIT_NN, PIT_TAPER, pitInfo, pitKofTrack, PIT_LEN, PIT_LIMIT, updatePitState, updatePitStop, TCOMP } };

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (composer) composer.setSize(innerWidth, innerHeight);
});
