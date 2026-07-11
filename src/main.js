import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import trackData from './track.json';

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
const V_ALLOW = new Float32Array(N);
{
  for (let i = 0; i < N; i++) V_ALLOW[i] = Math.min(88, Math.sqrt(11.5 / Math.max(Math.abs(CURV[i]), 1e-5)));
  for (let pass = 0; pass < 3; pass++)
    for (let i = N - 1; i >= 0; i--)
      V_ALLOW[i] = Math.min(V_ALLOW[i], Math.sqrt(V_ALLOW[(i + 1) % N] ** 2 + 2 * 30 * STEP));
}

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
// Renderer / scene
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
const app = document.getElementById('app');
app.innerHTML = ''; // drop any canvas from a previous module instance (HMR)
app.appendChild(renderer.domElement);
window.__gen = (window.__gen || 0) + 1;
const GEN = window.__gen; // stale render loops check this and stop

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa8c8ea);
scene.fog = new THREE.Fog(0xbdd2e6, 320, 3200);

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.3, 6000);

const hemi = new THREE.HemisphereLight(0xd8e8ff, 0x42603a, 1.05);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe9c4, 2.0);
sun.position.set(-350, 500, 200);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 50; sun.shadow.camera.far = 1400;
const sc = 120;
sun.shadow.camera.left = -sc; sun.shadow.camera.right = sc;
sun.shadow.camera.top = sc; sun.shadow.camera.bottom = -sc;
scene.add(sun); scene.add(sun.target);

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
// per-vertex UVs for a ribbon built by buildRibbon (2 verts per step)
function addRibbonUVs(mesh, uAcross, vMeters) {
  const count = mesh.geometry.attributes.position.count;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i <= N; i++) {
    uv[i * 4 + 0] = 0;        uv[i * 4 + 1] = i * STEP / vMeters;
    uv[i * 4 + 2] = uAcross;  uv[i * 4 + 3] = i * STEP / vMeters;
  }
  mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
{
  const road = buildRibbon(i => HALF_W, i => -HALF_W, 0, i => {
    const v = 0.155 + asphaltTone[i] * 0.05;
    return { r: v, g: v, b: v + 0.008 };
  });
  addRibbonUVs(road, 1, 9);
  surfaceTex('/textures/road.png', t => {
    road.material = new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 });
  });
  scene.add(road);
}

// rubbered-in racing groove down the middle of the road
scene.add(buildRibbon(i => 2.1, i => -2.1, 0.008, i => {
  const v = 0.115 + asphaltTone[i] * 0.035;
  return { r: v, g: v, b: v + 0.006 };
}));

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

// white edge lines
const white = { r: 0.92, g: 0.92, b: 0.92 };
scene.add(buildRibbon(i => HALF_W - 0.05, i => HALF_W - 0.30, 0.01, () => white));
scene.add(buildRibbon(i => -(HALF_W - 0.30), i => -(HALF_W - 0.05), 0.01, () => white));

// kerbs on corners (red/white stripes), placed where curvature is significant
const KERB_THRESH = 0.0045;
function kerbColor(i) {
  return (Math.floor(i / 2) % 2 === 0) ? { r: 0.85, g: 0.12, b: 0.10 } : { r: 0.92, g: 0.90, b: 0.88 };
}
scene.add(buildRibbon(
  i => Math.abs(C(i)) > KERB_THRESH ? HALF_W + KERB_W : HALF_W + 0.001,
  i => HALF_W, 0.035, kerbColor));
scene.add(buildRibbon(
  i => -HALF_W,
  i => Math.abs(C(i)) > KERB_THRESH ? -(HALF_W + KERB_W) : -(HALF_W + 0.001), 0.035, kerbColor));

// painted tarmac runoff outside medium/fast corners (asphalt apron + green band)
const RUNOFF = i => {
  const c = Math.abs(C(i));
  return c > 0.0045 && c < 0.022;
};
for (const side of [1, -1]) {
  scene.add(buildRibbon(
    i => side * (RUNOFF(i) ? HALF_W + KERB_W + 4.5 : HALF_W + KERB_W + 0.001),
    i => side * (HALF_W + KERB_W),
    0.02,
    i => { const v = 0.22 + asphaltTone[i] * 0.05; return { r: v, g: v, b: v }; }));
  scene.add(buildRibbon(
    i => side * (RUNOFF(i) ? HALF_W + KERB_W + 6.3 : HALF_W + KERB_W + 4.5 + 0.001),
    i => side * (RUNOFF(i) ? HALF_W + KERB_W + 4.5 : HALF_W + KERB_W + 4.5),
    0.02,
    () => ({ r: 0.12, g: 0.42, b: 0.16 })));
}

// grass shoulders: track edge out to ~22 m, sloping down to meet the sunken
// terrain so the road always sits proud of the ground on crests
for (const side of [1, -1]) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const p = P(i % N), n = normals[i % N];
    const inner = side * (HALF_W + 0.001);
    const outer = side * 22;
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
  surfaceTex('/textures/grass.png', t => {
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
  surfaceTex('/textures/grass.png', t => {
    t.repeat.set(320, 320);
    terrMat.map = t; terrMat.vertexColors = false; terrMat.color.set(0xb9c4ae); terrMat.needsUpdate = true;
  });
  const terr = new THREE.Mesh(g, terrMat);
  terr.position.set(cx, 0, cz);
  terr.receiveShadow = true;
  scene.add(terr);

  // Ardennes forest — instanced trees outside the track corridor
  const trunkG = new THREE.CylinderGeometry(0.35, 0.5, 4, 5);
  const crownG = new THREE.ConeGeometry(3.2, 11, 6);
  const trunkM = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 });
  const crownM = new THREE.MeshStandardMaterial({ color: 0x2c5233, roughness: 1 });
  const COUNT = 4200;
  const trunks = new THREE.InstancedMesh(trunkG, trunkM, COUNT);
  const crowns = new THREE.InstancedMesh(crownG, crownM, COUNT);
  const dummy = new THREE.Object3D();
  let placed = 0, tries = 0;
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  while (placed < COUNT && tries < COUNT * 30) {
    tries++;
    const x = minX - pad + rand() * (maxX - minX + pad * 2);
    const z = minZ - pad + rand() * (maxZ - minZ + pad * 2);
    let dmin = 1e18;
    for (const s of samples) dmin = Math.min(dmin, (s[0] - x) ** 2 + (s[2] - z) ** 2);
    const d = Math.sqrt(dmin);
    if (d < 21 || d > 700) continue; // dense tree walls right behind the barriers
    const y = terrainHeight(x, z);
    const s = 0.7 + rand() * 0.9;
    dummy.position.set(x, y + 2 * s, z); dummy.scale.setScalar(s); dummy.rotation.y = rand() * 6.28;
    dummy.updateMatrix(); trunks.setMatrixAt(placed, dummy.matrix);
    dummy.position.y = y + (4 + 5.5) * s;
    dummy.updateMatrix(); crowns.setMatrixAt(placed, dummy.matrix);
    placed++;
  }
  trunks.count = crowns.count = placed;
  crowns.castShadow = true;
  scene.add(trunks, crowns);
}

// barriers
// armco guardrail texture: gray base, two silver rails, catch fence on top
const armcoTex = (() => {
  const cnv = document.createElement('canvas'); cnv.width = 64; cnv.height = 128;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#7d838c'; ctx.fillRect(0, 0, 64, 128);       // armco base (bottom 60%)
  ctx.fillStyle = '#b8bec6'; ctx.fillRect(0, 70, 64, 14);       // rail
  ctx.fillStyle = '#a2a8b0'; ctx.fillRect(0, 96, 64, 14);       // rail
  ctx.fillStyle = '#31363d'; ctx.fillRect(0, 0, 64, 52);        // fence band (top 40%)
  ctx.strokeStyle = '#565c64'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(4, 52); ctx.stroke();  // fence post
  ctx.strokeStyle = '#4a5058'; ctx.lineWidth = 1;
  for (let k = -2; k < 6; k++) {
    ctx.beginPath(); ctx.moveTo(k * 16, 0); ctx.lineTo(k * 16 + 52, 52); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(k * 16, 52); ctx.lineTo(k * 16 + 52, 0); ctx.stroke();
  }
  const t = new THREE.CanvasTexture(cnv);
  t.wrapS = THREE.RepeatWrapping;
  return t;
})();
for (const side of [1, -1]) {
  const off = side * (HALF_W + 9);
  const pos = [], idx = [], uv = [];
  for (let i = 0; i <= N; i++) {
    const p = P(i), n = normals[i % N];
    const x = p[0] + n[0] * off, z = p[2] + n[1] * off;
    const y = p[1] - 2.2; // extend below the sloping shoulder so no gap shows
    pos.push(x, y, z, x, y + 3.6, z);
    uv.push(i * STEP / 4, 0, i * STEP / 4, 1);
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
  ctx.fillStyle = '#23282f'; ctx.fillRect(0, 0, 256, 64);
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const cols = ['#c0392b', '#2980b9', '#f1c40f', '#ecf0f1', '#27ae60', '#e67e22', '#8e44ad'];
  for (let k = 0; k < 1400; k++) {
    ctx.fillStyle = cols[Math.floor(rand() * cols.length)];
    ctx.fillRect(Math.floor(rand() * 256), Math.floor(rand() * 64), 2, 2);
  }
  const t = new THREE.CanvasTexture(cnv);
  t.magFilter = THREE.NearestFilter;
  return t;
})();
const crowdM = new THREE.MeshStandardMaterial({ map: crowdTex, roughness: 1 });
// grandstands at their real mapped positions (OSM building=grandstand
// polygons around the circuit: Tribune F1, Raidillon, Endurance, Silver, …)
for (const st of trackData.stands) {
  const tiers = Math.max(2, Math.min(4, Math.round(st.wid / 8)));
  const len = Math.min(st.len, 170);
  const ux = Math.cos(st.ang), uz = Math.sin(st.ang);   // long axis
  // step tiers across the footprint, away from the track
  let px = -uz, pz = ux;
  const near = (x, z) => {
    let b = 1e18;
    for (let i = 0; i < N; i += 4) { const q = P(i); b = Math.min(b, (q[0]-x)**2 + (q[2]-z)**2); }
    return b;
  };
  if (near(st.x + px * 20, st.z + pz * 20) < near(st.x - px * 20, st.z - pz * 20)) { px = -px; pz = -pz; }
  for (let tier = 0; tier < tiers; tier++) {
    const cx = st.x + px * (tier * 4 - (tiers - 1) * 2);
    const cz = st.z + pz * (tier * 4 - (tiers - 1) * 2);
    const stand = new THREE.Mesh(new THREE.BoxGeometry(len, 3, 4), crowdM);
    stand.rotation.y = -st.ang;
    stand.position.set(cx, terrainHeight(cx, cz) + 1.6 + tier * 2.6, cz);
    stand.castShadow = true; scene.add(stand);
  }
}
{ // pit building (left of pit straight)
  const i0 = 1700;
  const p = P(i0), t = tangents[i0 % N], n = normals[i0 % N];
  const yaw = -Math.atan2(t[1], t[0]); // parallel to the straight (no gantry +90°)
  const pitB = new THREE.Mesh(new THREE.BoxGeometry(150, 7, 12),
    new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.8 }));
  pitB.rotation.y = yaw;
  pitB.position.set(p[0] + n[0] * 26 + t[0] * 10, p[1] + 3.5, p[2] + n[1] * 26 + t[1] * 10);
  pitB.castShadow = true; scene.add(pitB);
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
const input = { throttle: 0, brake: 0, steer: 0, left: false, right: false, up: false, down: false };
const state = {
  x: P(0)[0] - tangents[0][0] * 12, z: P(0)[2] - tangents[0][1] * 12,
  heading: Math.atan2(tangents[0][0], tangents[0][1]), // yaw, forward = (sin,cos)
  vx: 0, vz: 0, idx: 0, steer: 0,
  lapStart: 0, running: false, lap: 0, best: null, last: null, prog: 0,
  // bicycle-model state: yaw rate, pedal ramps, longitudinal accel (raw + suspension-filtered)
  r: 0, thr: 0, brk: 0, ax: 0, axSm: 0,
  // per-checkpoint times (one slot per track point) for live delta-to-best
  curT: new Float32Array(N).fill(-1), bestT: null,
};

const MASS = 800, POWER = 690000, MU = 1.75, DFK = 0.0062, CDA = 1.45;
// bicycle-model parameters: yaw inertia, CG position/height, axle cornering stiffness
const IZ = 1050, CG_A = 1.8, CG_B = 1.6, WHEELBASE = 3.4, CG_H = 0.32;
const CA_F = 2.1e5, CA_R = 2.5e5; // N/rad before saturation

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
// the slip-angle dynamics need a finer timestep than 120 Hz to stay stable
// at low speed, so each fixed step is integrated in three substeps
function physStep(dt) {
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
  const onTrack = Math.abs(info.lateral) < HALF_W + KERB_W;
  onTrackState = onTrack;
  // grass grip: reduced but not a cliff — brushing a wheel over the edge
  // shouldn't instantly snap the car around
  const mu = onTrack ? MU : 0.85;

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
    FxDrive = s.thr * Math.min(14000, POWER / Math.max(vLong, 8));
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
      FxBrakeF = Math.min(0.62 * Fb, mu * Fzf); // forward brake bias, capped per axle
      FxBrakeR = Math.min(0.38 * Fb, mu * Fzr);
    } else {
      vLong = Math.max(vLong - 4 * s.brk * dt, -8); // gentle reverse
    }
  }
  const dirL = vLong >= 0 ? 1 : -1;
  const FxF = -FxBrakeF * dirL;
  const FxR = FxDrive - FxBrakeR * dirL;
  const Fdrag = (0.5 * 1.22 * CDA * speed * speed + 320 + (onTrack ? 0 : 1800)) * dirL;

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

  s.heading += rNew * dt;
  s.r = rNew;
  s.ax = axNet;
  const f2X = Math.sin(s.heading), f2Z = Math.cos(s.heading);
  s.vx = f2X * vLong + -f2Z * vLatNew;
  s.vz = f2Z * vLong + f2X * vLatNew;
  const vF = vLong; // forward speed, read by the lap-timing gate below

  s.x += s.vx * dt;
  s.z += s.vz * dt;

  // soft barrier at ±(HALF_W+9)
  const info2 = trackInfo(s.x, s.z, s.idx);
  const lim = HALF_W + 8.4;
  if (Math.abs(info2.lateral) > lim) {
    const n = normals[info2.idx];
    const over = Math.abs(info2.lateral) - lim;
    const sgn = Math.sign(info2.lateral);
    s.x -= n[0] * sgn * over; s.z -= n[1] * sgn * over;
    const vn = s.vx * n[0] + s.vz * n[1];
    s.vx -= n[0] * vn * 1.4; s.vz -= n[1] * vn * 1.4;
    // scrape speed off instead of dead-stopping, so you can drive away from a wall
    s.vx *= 0.96; s.vz *= 0.96;
  }

  // lap timing via progress
  const prog = info2.s;
  if (s.prog > TRACK_LEN - 60 && prog < 60 && vF > 3) {
    const now = performance.now();
    if (s.running) {
      s.last = now - s.lapStart;
      if (!s.best || s.last < s.best) {
        s.best = s.last;
        s.bestT = s.curT.slice(); // checkpoint times of the new best lap
        flashLap(`LAP ${s.lap}  —  ${fmt(s.last)}  ★ BEST`);
      } else flashLap(`LAP ${s.lap}  —  ${fmt(s.last)}`);
    }
    s.lap++; s.lapStart = now; s.running = true;
    s.curT.fill(-1);
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
let started = false, muted = false, camMode = 0, assistsOn = true;
addEventListener('keydown', e => {
  if (!started) { started = true; document.getElementById('title').style.display = 'none'; initAudio(); }
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': input.throttle = 1; break;
    case 'KeyS': case 'ArrowDown': input.brake = 1; break;
    case 'KeyA': case 'ArrowLeft': input.left = true; break;
    case 'KeyD': case 'ArrowRight': input.right = true; break;
    case 'KeyR': resetCar(); break;
    case 'KeyC':
      camMode = (camMode + 1) % 3; // chase -> cockpit -> nose pod
      document.body.classList.toggle('cockpit', camMode >= 1);
      break;
    case 'KeyL': raceLine.visible = !raceLine.visible; break;
    case 'KeyH': car.userData.halo.visible = !car.userData.halo.visible; break;
    case 'KeyX':
      assistsOn = !assistsOn;
      flashLap(assistsOn ? 'ASSISTS ON — brake assist / ABS / traction control' : 'ASSISTS OFF — you are on your own');
      break;
    case 'KeyB': if (car.userData.imported) car.userData.imported.rotation.y += Math.PI / 2; break;
    case 'KeyM': muted = !muted; break;
  }
});
addEventListener('keyup', e => {
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': input.throttle = 0; break;
    case 'KeyS': case 'ArrowDown': input.brake = 0; break;
    case 'KeyA': case 'ArrowLeft': input.left = false; break;
    case 'KeyD': case 'ArrowRight': input.right = false; break;
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
  fetch('/engine.wav')
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
  mm.beginPath();
  mm.arc(mmX(state.x), mmZ(state.z), 4, 0, 7);
  mm.fillStyle = '#e10600'; mm.fill();
  mm.strokeStyle = '#fff'; mm.lineWidth = 1.2; mm.stroke();
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
  outer.traverse(o => { if (o.isMesh) { o.castShadow = true; if (o.material) o.material.side = THREE.DoubleSide; } });
  car.add(outer);
  outer.updateMatrixWorld(true);
  car.userData.imported = outer;

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
  }
  flashLap('CUSTOM CAR LOADED' + (spinners.length === 4 ? ' — wheels linked' : '') + ' — B rotates 90°');
}

const draco = new DRACOLoader();
draco.setDecoderPath('/draco/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(draco);
gltfLoader.load('/car.glb', g => attachCarModel(g.scene), undefined,
  () => {}); // no file — placeholder car stays

// steering wheel model: replaces the primitive wheel in the cockpit; the live
// LCD and LED strip stay, floating on the model's screen area
gltfLoader.load('/wheel.glb', g => {
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
  // seat the wheel inside the cockpit where the model puts it:
  // above the chassis line, forward of the headrest (measured from the model)
  wheelGroup.position.set(0, 0.78, 0.74);
  // seat the live LCD into the model's screen bezel: match the column rake,
  // shrink to the screen cutout, and drop the redundant procedural LEDs
  // (the model has its own baked light strip)
  const lcd = car.userData.lcdMesh;
  lcd.position.set(0, 0.025, -0.058);
  lcd.rotation.x = -0.30;
  lcd.scale.set(0.62, 0.62, 1);
  for (const led of car.userData.leds) led.visible = false;
}, undefined, () => {});

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
// Main loop
// ---------------------------------------------------------------------------
const camPos = new THREE.Vector3();
let camInit = false;
let acc = 0, lastT = performance.now(), lcdAcc = 0, pitchSm = 0, slopeSm = 0;
const FIXED = 1 / 120;

function frame() {
  if (window.__gen !== GEN) return; // a newer module instance took over
  requestAnimationFrame(frame);
  const now = performance.now();
  let dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;

  if (started) {
    acc += dt;
    while (acc >= FIXED) { physStep(FIXED); acc -= FIXED; }
  }

  // place car on track surface
  const info = trackInfo(state.x, state.z, state.idx);
  const speed = Math.hypot(state.vx, state.vz);
  car.position.set(state.x, info.y, state.z);
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

  // camera
  const fwdX = Math.sin(state.heading), fwdZ = Math.cos(state.heading);
  // uphill positive: tilt the view with the road; low-passed to keep the horizon steady
  slopeSm += ((ahead.y - info.y) / 6 - slopeSm) * (1 - Math.exp(-dt * 8));
  const slope = slopeSm;
  let target;
  if (camMode === 0) {
    target = new THREE.Vector3(state.x - fwdX * 8.5, info.y + 3.1 - slope * 3.5, state.z - fwdZ * 8.5);
  } else if (camMode === 1) {
    // cockpit: driver's eye at the headrest opening (measured from the
    // model), looking level over the wheel seated in the cockpit
    target = new THREE.Vector3(state.x - fwdX * 0.08, info.y + 0.93, state.z - fwdZ * 0.08);
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
  // cockpit view looks dead level so the horizon sits mid-frame
  const lookY = camMode === 1 ? 0.93 : 1.0;
  camera.lookAt(state.x + fwdX * 14, info.y + lookY + slope * 14, state.z + fwdZ * 14);
  camera.fov = (camMode === 0 ? 68 : 82) + Math.min(speed * 0.12, 14);
  camera.updateProjectionMatrix();

  // sun shadow follows car
  sun.position.set(state.x - 350, info.y + 500, state.z + 200);
  sun.target.position.set(state.x, info.y, state.z);

  const kmh = speed * 3.6;
  const rpmFrac = updateHUD(kmh);
  const lit = Math.round(rpmFrac * 12);
  car.userData.leds.forEach((led, k) => { led.visible = k < lit; });

  // kerb rumble: shake the camera when riding the painted kerbs
  const onKerb = Math.abs(info.lateral) > HALF_W - 0.25 &&
                 Math.abs(info.lateral) < HALF_W + KERB_W + 0.3 &&
                 Math.abs(C(info.idx)) > 0.003;
  if (onKerb && speed > 8) {
    camPos.y += (Math.random() - 0.5) * 0.025;
    camPos.x += (Math.random() - 0.5) * 0.015;
  }

  // steering-wheel LCD (redrawn ~10x/s)
  lcdAcc += dt;
  if (lcdAcc > 0.1) {
    lcdAcc = 0;
    const { ctx, tex } = car.userData.lcd;
    ctx.fillStyle = '#0a0e12'; ctx.fillRect(0, 0, 256, 160);
    ctx.strokeStyle = '#2a3644'; ctx.lineWidth = 3; ctx.strokeRect(2, 2, 252, 156);
    ctx.fillStyle = '#e8eef4'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '900 84px Arial';
    ctx.fillText(kmh < 3 ? 'N' : String(gearAt(kmh) + 1), 128, 84);
    ctx.font = 'bold 26px Arial'; ctx.textAlign = 'left';
    ctx.fillText(String(Math.round(kmh)), 12, 24);
    ctx.font = '13px Arial'; ctx.fillStyle = '#8899aa';
    ctx.fillText('KM/H', 12, 44);
    ctx.textAlign = 'right'; ctx.font = 'bold 20px Arial'; ctx.fillStyle = '#e8eef4';
    ctx.fillText('L' + state.lap, 246, 24);
    if (state.deltaStr) {
      ctx.textAlign = 'center'; ctx.font = 'bold 26px Arial';
      ctx.fillStyle = state.deltaAhead ? '#4be07a' : '#ff6060';
      ctx.fillText(state.deltaStr, 128, 140);
    }
    tex.needsUpdate = true;
  }

  updateAudio(rpmFrac, input.throttle, speed);
  drawMinimap();

  renderer.render(scene, camera);
}
frame();

// debug/testing hook
window.__game = { state, input, trackInfo, tangents, resetCar, P, N, STEP, scene, CURV, camera, camPos, renderer, physStep };

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
