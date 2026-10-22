// Mundo 3D: cielo HDRI, luz, terreno, circuito, vegetación y decorado.
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { pts, nor, tan, N, DS, ROAD_W, CURB, WALL, trackInfluence, headingAt, wrap } from './track-data.js';

export const QUALITY = {
  ultra: { hdr: '2k', shadow: 4096, shadowBox: 80, verge: 7, field: 2, grassFar: 70, trees: 520, msaa: 4, post: true, seg: 240, maxRatio: 2 },
  alta: { hdr: '2k', shadow: 2048, shadowBox: 55, verge: 3.5, field: 0.9, grassFar: 55, trees: 360, msaa: 0, post: true, seg: 200, maxRatio: 1.5 },
  baja: { hdr: '1k', shadow: 1024, shadowBox: 45, verge: 0, field: 0, grassFar: 0, trees: 200, msaa: 0, post: false, seg: 120, maxRatio: 1 },
};

// Dirección del sol y color del horizonte medidos sobre el HDRI (kloofendal_48d_partly_cloudy_puresky)
const SUN = new THREE.Vector3(0.5546, 0.742, 0.3767).normalize();
const HORIZON = new THREE.Color().setRGB(0.43, 0.465, 0.56);
const TCX = 6, TCZ = 16, BOARD = WALL + 1.6;
const { smoothstep, lerp } = THREE.MathUtils;
const rand = (a, b) => a + Math.random() * (b - a);

// Resplandor a un cuarto de resolución (el de serie va a la mitad): en un brillo difuminado no se nota y cuesta mucho menos
class LightBloomPass extends UnrealBloomPass {
  setSize(w, h) { super.setSize(Math.max(2, w / 2), Math.max(2, h / 2)); }
}

// ---------- Utilidades ----------
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
const solid = (r, g, b) => { const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1); t.needsUpdate = true; return t; };
function repeated(tex, x, y) {
  const t = tex.clone();
  t.repeat.set(x, y);
  t.needsUpdate = true;
  return t;
}

// Tira que sigue el circuito: o0/o1 = desplazamiento lateral, h0/h1 = altura sobre el asfalto, v = metros por repetición
function ribbon(o0, o1, h0, h1, vScale) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const p = pts[i % N], n = nor[i % N], v = (i * DS) / vScale;
    pos.push(p.x + n.x * o0, p.y + h0, p.z + n.z * o0, p.x + n.x * o1, p.y + h1, p.z + n.z * o1);
    uv.push(0, v, 1, v);
    if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function quadGeometry(quads) {
  // quads: [{ v: [4 x Vector3], n: Vector3, uv?: [[u,v] x4] }]
  const pos = [], nrm = [], uv = [], idx = [];
  const UV = [[0, 0], [1, 0], [1, 1], [0, 1]];
  quads.forEach((q, k) => {
    q.v.forEach((v, j) => { pos.push(v.x, v.y, v.z); nrm.push(q.n.x, q.n.y, q.n.z); uv.push(...(q.uv ? q.uv[j] : UV[j])); });
    const a = k * 4;
    idx.push(a, a + 1, a + 2, a, a + 2, a + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// En materiales de doble cara con normales "de volumen", ignoramos la cara para que no se oscurezca el reverso
const keepNormal = s => { s.fragmentShader = s.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n\tnormal = normalize( vNormal );'); };

// ---------- Carga de recursos ----------
async function loadAssets(q, renderer, onProgress) {
  const manager = new THREE.LoadingManager();
  manager.onProgress = (url, loaded, total) => onProgress?.(loaded / total);
  const tl = new THREE.TextureLoader(manager);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tex = (name, srgb, fallback) => new Promise(res => tl.load(`assets/${name}`, t => {
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    res(t);
  }, undefined, () => { const t = fallback(); t.wrapS = t.wrapT = THREE.RepeatWrapping; res(t); }));
  const gray = () => solid(110, 110, 110), flatN = () => solid(128, 128, 255), green = () => solid(80, 110, 50);
  const hdr = new Promise(res => new RGBELoader(manager).load(`assets/sky_${q.hdr}.hdr`, t => { t.mapping = THREE.EquirectangularReflectionMapping; res(t); }, undefined, () => res(null)));
  const [asphaltD, asphaltN, asphaltARM, grassD, grassN, grassM, rockD, rockN, sky] = await Promise.all([
    tex('asphalt_diff.jpg', true, gray), tex('asphalt_nor.jpg', false, flatN), tex('asphalt_arm.jpg', false, () => solid(255, 230, 0)),
    tex('grass_diff.jpg', true, green), tex('grass_nor.jpg', false, flatN), tex('grass_macro.jpg', true, () => solid(128, 128, 128)),
    tex('rock_diff.jpg', true, gray), tex('rock_nor.jpg', false, flatN), hdr,
  ]);
  return { asphaltD, asphaltN, asphaltARM, grassD, grassN, grassM, rockD, rockN, sky, waterN: waterNormals() };
}

// Olas: suma de ondas con frecuencias enteras para que la textura se repita sin costuras
function waterNormals() {
  const S = 256, waves = [[3, 1, 0.6], [1, 4, 0.5], [5, -2, 0.35], [-2, 7, 0.25], [9, 3, 0.15], [-7, -5, 0.12]].map(([kx, kz, a]) => ({ kx, kz, a, ph: Math.random() * 6.28 }));
  return canvasTex(S, S, (g) => {
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let dx = 0, dz = 0;
      for (const w of waves) { const d = w.a * Math.cos((2 * Math.PI * (w.kx * x + w.kz * y)) / S + w.ph); dx += d * w.kx; dz += d * w.kz; }
      const nx = -dx * 0.06, nz = -dz * 0.06, l = Math.hypot(nx, nz, 1), i = (y * S + x) * 4;
      img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (nz / l * 0.5 + 0.5) * 255; img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, false);
}

// ---------- Texturas procedurales para vegetación ----------
function leafTexture() {
  return canvasTex(256, 256, (g, w, h) => {
    for (let i = 0; i < 260; i++) {
      const x = rand(18, w - 18), y = rand(18, h - 18), r = rand(9, 17), a = rand(0, Math.PI * 2);
      // más denso en el centro para que la silueta sea orgánica
      if (Math.hypot(x - w / 2, y - h / 2) > rand(70, 125)) continue;
      g.save(); g.translate(x, y); g.rotate(a);
      g.fillStyle = `hsl(${rand(78, 112)},${rand(38, 60)}%,${rand(18, 36)}%)`;
      g.beginPath(); g.ellipse(0, 0, r, r * 0.48, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1; g.beginPath(); g.moveTo(-r, 0); g.lineTo(r, 0); g.stroke();
      g.restore();
    }
  });
}
function needleTexture() {
  return canvasTex(128, 256, (g, w, h) => {
    g.strokeStyle = '#3b2a1c'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h * 0.97); g.stroke();
    for (let y = 4; y < h * 0.98; y += 2.2) {
      const len = (w / 2 - 6) * (1 - (y / h) * 0.55) * rand(0.75, 1.05);
      for (const s of [-1, 1]) {
        g.strokeStyle = `hsl(${rand(110, 135)},${rand(30, 45)}%,${rand(14, 26)}%)`;
        g.lineWidth = rand(1.5, 2.6);
        g.beginPath(); g.moveTo(w / 2, y); g.lineTo(w / 2 + s * len, y + len * rand(0.35, 0.6)); g.stroke();
      }
    }
  });
}

// ---------- Geometría de árboles (tarjetas de hojas con normales de volumen) ----------
function broadleafGeometries() {
  const trunk = mergeGeometries([
    new THREE.CylinderGeometry(0.17, 0.3, 4.8, 7).translate(0, 2.4, 0),
    new THREE.CylinderGeometry(0.07, 0.12, 2.2, 5).rotateZ(0.8).translate(0.7, 3.7, 0),
    new THREE.CylinderGeometry(0.07, 0.12, 2, 5).rotateZ(-0.7).rotateY(2).translate(-0.4, 3.9, 0.5),
  ].map(g => g.toNonIndexed()));
  const quads = [], center = new THREE.Vector3(0, 4.9, 0);
  for (let i = 0; i < 44; i++) {
    const u = rand(-1, 1), th = rand(0, Math.PI * 2), r = Math.sqrt(1 - u * u), k = rand(0.45, 1);
    const dir = new THREE.Vector3(r * Math.cos(th), u, r * Math.sin(th));
    const c = new THREE.Vector3(dir.x * 2.3 * k, dir.y * 1.8 * k, dir.z * 2.3 * k).add(center);
    const t = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize()).normalize();
    const b = new THREE.Vector3().crossVectors(dir, t);
    const s = rand(0.85, 1.15);
    const n = dir.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, 0.45, 0)).normalize();
    quads.push({ v: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => c.clone().addScaledVector(t, x * s).addScaledVector(b, y * s)), n });
  }
  return { trunk, crown: quadGeometry(quads) };
}

function coniferGeometries() {
  const trunk = new THREE.CylinderGeometry(0.13, 0.27, 8.4, 7).translate(0, 4.2, 0);
  const quads = [], up = new THREE.Vector3(0, 1, 0);
  for (let L = 0; L < 7; L++) {
    const y = 1.5 + L * 0.95, R = 2.9 * (1 - L / 7.4) + 0.4, count = 10 - Math.floor(L / 2);
    for (let k = 0; k < count; k++) {
      const th = (k / count) * Math.PI * 2 + L * 0.37 + rand(-0.15, 0.15);
      const dir = new THREE.Vector3(Math.cos(th), 0, Math.sin(th));
      const inner = new THREE.Vector3(0, y, 0), outer = new THREE.Vector3(dir.x * R, y - R * rand(0.3, 0.45), dir.z * R);
      const side = new THREE.Vector3().crossVectors(dir, up).normalize();
      const w = 0.55 + R * 0.28;
      const n = dir.clone().add(new THREE.Vector3(0, 0.75, 0)).normalize();
      quads.push({
        v: [inner.clone().addScaledVector(side, -w * 0.25), inner.clone().addScaledVector(side, w * 0.25), outer.clone().addScaledVector(side, w * 0.5), outer.clone().addScaledVector(side, -w * 0.5)],
        n, uv: [[0, 0], [1, 0], [1, 1], [0, 1]],
      });
    }
  }
  for (const a of [0, Math.PI / 2]) {
    const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    quads.push({ v: [new THREE.Vector3(0, 7.2, 0).addScaledVector(d, -0.45), new THREE.Vector3(0, 7.2, 0).addScaledVector(d, 0.45), new THREE.Vector3(0, 8.9, 0), new THREE.Vector3(0, 8.9, 0)], n: up, uv: [[0, 1], [1, 1], [0.5, 0], [0.5, 0]] });
  }
  return { trunk, crown: quadGeometry(quads) };
}

// ---------- Hierba 3D ----------
// Mata de tres hojas cruzadas (x de -0,5 a 0,5 por hoja, y de 0 a 1)
function bladeGeometry() {
  const P = [], C = [], I = [];
  [[0, 0, 0, 1], [1.05, 0.12, 0.08, 0.8], [2.1, -0.1, 0.1, 0.9]].forEach(([a, ox, oz, h], k) => {
    const c = Math.cos(a), s = Math.sin(a), lean = 0.15 * (k - 1);
    for (const [x, y] of [[-0.5, 0], [0.5, 0], [-0.3, 0.45], [0.3, 0.45], [lean, 1]]) {
      P.push(ox + c * x, y * h, oz - s * x);
      const t = 0.3 + 0.7 * y;
      C.push(t, t, t);
    }
    const b = k * 5;
    I.push(b, b + 1, b + 2, b + 2, b + 1, b + 3, b + 2, b + 3, b + 4);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(P.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(I);
  return g;
}

function grassMaterial(uniforms) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide, envMapIntensity: 0.6 });
  m.onBeforeCompile = s => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 iPos; attribute vec4 iData; attribute vec3 iColor;
        uniform float uTime; uniform float uFar;`)
      .replace('#include <begin_vertex>', `
        float cy = cos(iData.x), sy = sin(iData.x);
        vec3 p = vec3(position.x * iData.z, position.y * iData.y, position.z * iData.z);
        p = vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
        float bend = position.y * position.y;
        float gust = sin(uTime * 1.7 + iPos.x * 0.13 + iPos.z * 0.09 + iData.w) * 0.6 + sin(uTime * 3.9 + iData.w * 3.0) * 0.25;
        p.x += gust * 0.35 * bend * iData.y;
        p.z += gust * 0.2 * bend * iData.y;
        float fade = 1.0 - smoothstep(uFar * 0.65, uFar, distance(iPos.xz, cameraPosition.xz));
        vec3 transformed = iPos + p * fade;`)
      .replace('#include <color_vertex>', '#include <color_vertex>\n\tvColor.rgb *= iColor;');
    keepNormal(s);
    // Sin brillo especular: mirada rasante, la hierba reflejaría el cielo y se vería blanquecina
    s.fragmentShader = s.fragmentShader.replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n\tmaterial.specularColor = vec3(0.0);\n\tmaterial.specularF90 = 0.0;');
  };
  return m;
}

// ---------- Mundo ----------
export async function createWorld(renderer, qualityName, onProgress) {
  const Q = { ...(QUALITY[qualityName] || QUALITY.alta) };
  // Solo para pruebas: ?debug&msaa=0&verge=2 ... sobrescribe el preset
  const params = new URLSearchParams(location.search);
  if (params.has('debug')) for (const k of Object.keys(Q)) if (params.has(k)) Q[k] = typeof Q[k] === 'number' ? +params.get(k) : params.get(k);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const A = await loadAssets(Q, renderer, onProgress);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HORIZON, 260, 1350);
  const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 4000);
  const uniforms = { uTime: { value: 0 }, uFar: { value: Q.grassFar } };

  // Cielo e iluminación de entorno
  const pmrem = new THREE.PMREMGenerator(renderer);
  if (A.sky) {
    scene.background = A.sky;
    scene.environment = pmrem.fromEquirectangular(A.sky).texture;
  } else {
    const sky = new Sky();
    sky.scale.setScalar(10000);
    sky.material.uniforms.sunPosition.value.copy(SUN);
    scene.add(sky);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    scene.environment = pmrem.fromScene(envScene).texture;
  }
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(Q.shadow, Q.shadow);
  Object.assign(sun.shadow.camera, { left: -Q.shadowBox, right: Q.shadowBox, top: Q.shadowBox, bottom: -Q.shadowBox, near: 1, far: 420 });
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // ---------- Terreno (rejilla de alturas compartida con árboles y hierba) ----------
  const pond = findPond();
  const SIZE = 920, SEG = Q.seg, CELL = SIZE / SEG, X0 = TCX - SIZE / 2, Z0 = TCZ - SIZE / 2;
  const gridH = new Float32Array((SEG + 1) ** 2), gridD = new Float32Array((SEG + 1) ** 2);
  const hills = (x, z) => 5 * Math.sin(x * 0.012 + 1.3) * Math.cos(z * 0.010) + 2.5 * Math.sin(x * 0.031) * Math.sin(z * 0.027 + 2) + 1.2 * Math.sin(x * 0.07 + z * 0.05);
  const natural = (x, z) => {
    const t = trackInfluence(x, z, 4);
    const w = smoothstep(t.dist, WALL + 2, WALL + 45);
    const far = Math.max(0, Math.hypot(x - TCX, z - TCZ) - 290);
    return { y: lerp(t.y - 0.35, t.y * 0.6 + hills(x, z) + Math.pow(far, 1.25) * 0.12, w), d: t.dist };
  };
  if (pond) {
    let rim = Infinity;
    for (let k = 0; k < 48; k++) { const a = (k / 48) * Math.PI * 2; rim = Math.min(rim, natural(pond.x + Math.cos(a) * (pond.r + 6), pond.z + Math.sin(a) * (pond.r + 6)).y); }
    pond.waterY = rim - 0.4;
  }
  const heightAt = (x, z) => {
    const h = natural(x, z);
    if (pond) {
      const d = Math.hypot(x - pond.x, z - pond.z);
      if (d < pond.r + 6) h.y = Math.min(h.y, lerp(pond.waterY - 1.8, h.y, smoothstep(d, pond.r * 0.6, pond.r + 6)));
    }
    return h;
  };
  const tg = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG).rotateX(-Math.PI / 2).translate(TCX, 0, TCZ);
  const tp = tg.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const h = heightAt(tp.getX(i), tp.getZ(i));
    tp.setY(i, h.y); gridH[i] = h.y; gridD[i] = h.d;
  }
  tg.computeVertexNormals();
  const sample = (arr, x, z) => {
    const fx = THREE.MathUtils.clamp((x - X0) / CELL, 0, SEG - 0.001), fz = THREE.MathUtils.clamp((z - Z0) / CELL, 0, SEG - 0.001);
    const ix = Math.floor(fx), iz = Math.floor(fz), ax = fx - ix, az = fz - iz, i = iz * (SEG + 1) + ix;
    return lerp(lerp(arr[i], arr[i + 1], ax), lerp(arr[i + SEG + 1], arr[i + SEG + 2], ax), az);
  };
  const groundAt = (x, z) => sample(gridH, x, z);
  const trackDistAt = (x, z) => sample(gridD, x, z);
  const splat = [], tn = tg.attributes.normal;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i), slope = 1 - tn.getY(i);
    splat.push(Math.max(smoothstep(y, 120, 170), smoothstep(slope, 0.32, 0.55)), 0);
  }
  tg.setAttribute('splat', new THREE.Float32BufferAttribute(splat, 2));
  const terrain = new THREE.Mesh(tg, splatMaterial(A, SIZE / 3, SIZE / 3, 0.04, true));
  terrain.receiveShadow = true;
  scene.add(terrain);
  const outer = new THREE.Mesh(new THREE.CircleGeometry(4000, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x51683f, roughness: 1 }));
  outer.position.set(TCX, 35, TCZ);
  scene.add(outer);

  // Cordillera lejana: un anillo con crestas de ruido (frecuencias enteras para que cierre sin costura)
  {
    const AS = 360, RS = 30, R0 = 560, R1 = 1300, pos = [], uv = [], idx = [];
    const oct = [[3, 0.9, 0.0021], [7, 0.55, 0.0043], [13, 0.35, 0.0071], [29, 0.18, 0.013], [61, 0.09, 0.021]].map(([f, a, g]) => ({ f, a, g, p: rand(0, 6.28) }));
    for (let a = 0; a <= AS; a++) {
      const th = (a / AS) * Math.PI * 2;
      for (let j = 0; j <= RS; j++) {
        const r = R0 + (j / RS) * (R1 - R0);
        let n = 0;
        for (const o of oct) n += o.a * (1 - Math.abs(Math.sin(th * o.f + o.p + r * o.g)));
        const h = smoothstep(r, R0, R0 + 220) * (30 + 150 * n * n) * (1 - 0.35 * smoothstep(r, 1000, R1));
        const x = TCX + Math.cos(th) * r, z = TCZ + Math.sin(th) * r;
        pos.push(x, h + 20, z);
        uv.push(x / 60, z / 60);
        if (a < AS && j < RS) { const i = a * (RS + 1) + j; idx.push(i, i + 1, i + RS + 1, i + 1, i + RS + 2, i + RS + 1); }
      }
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    mg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    mg.setIndex(idx);
    mg.computeVertexNormals();
    const sp = [], mp = mg.attributes.position, mn = mg.attributes.normal;
    for (let j = 0; j < mp.count; j++) {
      const y = mp.getY(j), slope = 1 - mn.getY(j);
      sp.push(Math.max(smoothstep(y, 70, 120), smoothstep(slope, 0.2, 0.45)), smoothstep(y, 165, 205) * (1 - smoothstep(slope, 0.45, 0.7)));
    }
    mg.setAttribute('splat', new THREE.Float32BufferAttribute(sp, 2));
    const range = new THREE.Mesh(mg, splatMaterial(A, 1, 1, 0.08, true));
    range.material.side = THREE.DoubleSide;
    scene.add(range);
  }

  // ---------- Circuito ----------
  const road = new THREE.Mesh(ribbon(-ROAD_W / 2, ROAD_W / 2, 0.03, 0.03, 4), new THREE.MeshStandardMaterial({
    map: repeated(A.asphaltD, 4, 1), normalMap: repeated(A.asphaltN, 4, 1), normalScale: new THREE.Vector2(0.9, 0.9),
    roughnessMap: repeated(A.asphaltARM, 4, 1), aoMap: repeated(A.asphaltARM, 4, 1), aoMapIntensity: 0.8,
    roughness: 1, metalness: 0, envMapIntensity: 0.55, color: new THREE.Color().setScalar(4.6), // la foto es casi negra (albedo 0,014)
  }));
  road.receiveShadow = true;
  scene.add(road);
  const paint = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6, normalMap: repeated(A.asphaltN, 0.2, 1), polygonOffset: true, polygonOffsetFactor: -1 });
  for (const s of [1, -1]) {
    const l = new THREE.Mesh(ribbon(s * (ROAD_W / 2 - 0.4), s * (ROAD_W / 2 - 0.12), 0.036, 0.036, 4), paint);
    l.receiveShadow = true;
    scene.add(l);
  }
  const kerbTex = canvasTex(64, 128, (g, w, h) => {
    g.fillStyle = '#c62828'; g.fillRect(0, 0, w, h / 2);
    g.fillStyle = '#f1f1f1'; g.fillRect(0, h / 2, w, h / 2);
  });
  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex, normalMap: repeated(A.asphaltN, 0.35, 1), roughness: 0.75, envMapIntensity: 0.35 });
  for (const s of [1, -1]) {
    const k = new THREE.Mesh(ribbon(s * ROAD_W / 2, s * (ROAD_W / 2 + CURB), 0.045, 0.1, 4), kerbMat);
    k.receiveShadow = true;
    scene.add(k);
  }
  const vergeW = BOARD - (ROAD_W / 2 + CURB);
  const vergeMat = splatMaterial(A, vergeW / 3, 1, 0.08, false);
  for (const s of [1, -1]) {
    const v = new THREE.Mesh(ribbon(s * (ROAD_W / 2 + CURB), s * BOARD, 0.0, 0.0, 3), vergeMat);
    v.receiveShadow = true;
    scene.add(v);
  }

  // Vallas publicitarias
  const boards = ['KART AMIGOS', 'TURBO', 'DERRAPA', 'KART AMIGOS', 'META'];
  const wallTex = canvasTex(1024, 64, (g, w, h) => {
    const cols = ['#1d4ed8', '#dc2626', '#f8fafc', '#15803d', '#f59e0b'];
    boards.forEach((txt, i) => {
      const x = (i * w) / boards.length, bw = w / boards.length;
      g.fillStyle = cols[i]; g.fillRect(x, 0, bw, h);
      g.fillStyle = cols[i] === '#f8fafc' || cols[i] === '#f59e0b' ? '#111' : '#fff';
      g.font = 'bold 36px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(txt, x + bw / 2, h / 2 + 2);
      g.fillStyle = '#0005'; g.fillRect(x + bw - 3, 0, 3, h);
    });
  });
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.45, side: THREE.DoubleSide, envMapIntensity: 0.8 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0xa4acb6, metalness: 0.85, roughness: 0.3 });
  for (const s of [1, -1]) {
    const geo = ribbon(s * BOARD, s * BOARD, 0, 1.1, 40);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) { const u = uv.getX(i), v = uv.getY(i); uv.setXY(i, s > 0 ? -v : v, u); } // el muro derecho se ve por la otra cara
    const w = new THREE.Mesh(geo, wallMat);
    w.castShadow = true; w.receiveShadow = true;
    scene.add(w);
    scene.add(new THREE.Mesh(ribbon(s * BOARD, s * (BOARD + 0.25), 1.1, 1.1, 10), railMat));
  }

  // Muros de neumáticos en el exterior de las curvas: una pila texturizada cada 0,85 m
  {
    const tyreTex = canvasTex(128, 96, (g, w, h) => {
      for (let k = 0; k < 3; k++) {
        const y0 = (k * h) / 3, bh = h / 3;
        const gr = g.createLinearGradient(0, y0, 0, y0 + bh);
        gr.addColorStop(0, '#050505'); gr.addColorStop(0.25, '#2a2a2a'); gr.addColorStop(0.5, '#3a3a3a'); gr.addColorStop(0.75, '#2a2a2a'); gr.addColorStop(1, '#050505');
        g.fillStyle = gr; g.fillRect(0, y0, w, bh);
        g.fillStyle = '#00000088';
        for (let x = 0; x < w; x += 6) g.fillRect(x, y0 + bh * 0.3, 2, bh * 0.4);
      }
    });
    tyreTex.repeat.set(3, 1);
    const spots = [];
    let acc = 0;
    for (let i = 0; i < N; i++) {
      const turn = wrap(headingAt((i + 4) % N) - headingAt((i - 4 + N) % N)) / (8 * DS);
      if (Math.abs(turn) < 0.011) { acc = 0; continue; }
      const s = turn > 0 ? 1 : -1; // girando a la izquierda, el exterior es la derecha
      const a = pts[i], b = pts[(i + 1) % N], n = nor[i], lat = s * (WALL + 1.15);
      for (; acc < DS; acc += 0.85) {
        const f = acc / DS;
        spots.push({ x: a.x + (b.x - a.x) * f + n.x * lat, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f + n.z * lat });
      }
      acc -= DS;
    }
    const tyres = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.43, 0.43, 0.75, 12, 1, true), new THREE.MeshStandardMaterial({ map: tyreTex, roughness: 0.9, envMapIntensity: 0.4 }), spots.length);
    const M = new THREE.Matrix4(), c = new THREE.Color();
    spots.forEach((p, k) => {
      M.makeRotationY(k * 1.7).setPosition(p.x, p.y + 0.375, p.z);
      tyres.setMatrixAt(k, M);
      tyres.setColorAt(k, c.set(k % 14 < 2 ? (k % 28 < 14 ? 0xff5a5a : 0xffffff) : 0xffffff).multiplyScalar(k % 14 < 2 ? 3.2 : 1));
    });
    tyres.castShadow = true; tyres.receiveShadow = true;
    scene.add(tyres);
  }

  // ---------- Lago ----------
  let water = null;
  if (pond) {
    const wy = pond.waterY;
    // Dos capas de olas a distinta escala y dirección para que no se note la repetición
    const wMat = new THREE.MeshPhysicalMaterial({ color: 0x0d2c36, roughness: 0.05, metalness: 0, envMapIntensity: 1.1, transparent: true, opacity: 0.93, clearcoat: 1, clearcoatRoughness: 0.04 });
    wMat.normalMap = repeated(A.waterN, 7, 7);
    wMat.normalScale.set(0.3, 0.3);
    wMat.clearcoatNormalMap = repeated(A.waterN, 19, 19);
    wMat.clearcoatNormalMap.rotation = 0.7;
    wMat.clearcoatNormalScale.set(0.25, 0.25);
    water = new THREE.Mesh(new THREE.CircleGeometry(pond.r + 6, 64).rotateX(-Math.PI / 2), wMat);
    water.position.set(pond.x, wy, pond.z);
    water.receiveShadow = true;
    scene.add(water);
  }
  const nearPond = (x, z, m) => pond && Math.hypot(x - pond.x, z - pond.z) < pond.r + m;

  // ---------- Árboles ----------
  {
    const leafTex = leafTexture(), needleTex = needleTexture();
    const bark = new THREE.MeshStandardMaterial({ color: 0x5a4433, roughness: 0.95, envMapIntensity: 0.4 });
    const foliage = map => {
      const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.8, envMapIntensity: 0.5, alphaToCoverage: Q.msaa > 0 });
      m.onBeforeCompile = s => {
        Object.assign(s.uniforms, uniforms);
        s.vertexShader = s.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            float ph = instanceMatrix[3].x * 0.05 + instanceMatrix[3].z * 0.07;
            float hh = max(transformed.y - 1.5, 0.0);
            transformed.x += sin(uTime * 1.3 + ph) * 0.03 * hh;
            transformed.z += cos(uTime * 1.05 + ph) * 0.022 * hh;`);
        keepNormal(s);
      };
      return m;
    };
    const species = [
      { geo: broadleafGeometries(), mat: foliage(leafTex), hue: [0.2, 0.3] },
      { geo: coniferGeometries(), mat: foliage(needleTex), hue: [0.27, 0.36] },
    ].map(sp => {
      const t = new THREE.InstancedMesh(sp.geo.trunk, bark, Q.trees), c = new THREE.InstancedMesh(sp.geo.crown, sp.mat, Q.trees);
      t.castShadow = c.castShadow = true; t.receiveShadow = c.receiveShadow = true;
      t.name = c.name = 'trees';
      scene.add(t, c);
      return { ...sp, t, c, n: 0 };
    });
    const M = new THREE.Matrix4(), Q4 = new THREE.Quaternion(), S = new THREE.Vector3(), V = new THREE.Vector3(), tint = new THREE.Color();
    let guard = 0;
    while (species.some(s => s.n < Q.trees) && guard++ < 40000) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 410;
      const x = TCX + Math.cos(a) * r, z = TCZ + Math.sin(a) * r;
      const d = trackDistAt(x, z);
      if (d < WALL + 8 || nearPond(x, z, 6)) continue;
      const t = trackInfluence(x, z, 6);
      if ((t.idx > N - 45 || t.idx < 45) && d < WALL + 32) continue; // tribuna
      const sp = species[Math.random() < 0.5 ? 0 : 1];
      if (sp.n >= Q.trees) continue;
      const sc = rand(0.8, 1.45);
      Q4.setFromAxisAngle(V.set(0, 1, 0), Math.random() * 6.28);
      M.compose(V.set(x, groundAt(x, z) - 0.15, z), Q4, S.set(sc, sc * rand(0.9, 1.15), sc));
      sp.t.setMatrixAt(sp.n, M); sp.c.setMatrixAt(sp.n, M);
      sp.c.setColorAt(sp.n++, tint.setHSL(rand(...sp.hue), rand(0.45, 0.75), rand(0.42, 0.62)));
    }
    for (const sp of species) { sp.t.count = sp.c.count = sp.n; }
  }

  // Rocas
  {
    const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ map: repeated(A.rockD, 0.3, 0.3), normalMap: repeated(A.rockN, 0.3, 0.3), roughness: 0.95 }), 80);
    const M = new THREE.Matrix4(), Q4 = new THREE.Quaternion(), S = new THREE.Vector3(), V = new THREE.Vector3();
    let n = 0, guard = 0;
    while (n < 80 && guard++ < 5000) {
      const x = TCX + rand(-390, 390), z = TCZ + rand(-390, 390);
      if (trackDistAt(x, z) < WALL + 6 || nearPond(x, z, -2)) continue;
      const sc = rand(0.5, 2.6);
      const g = rand(0.5, 0.9);
      Q4.setFromEuler(new THREE.Euler(rand(0, 3), rand(0, 3), rand(0, 3)));
      M.compose(V.set(x, groundAt(x, z) + sc * 0.15, z), Q4, S.set(sc * rand(0.8, 1.4), sc * g, sc));
      rocks.setMatrixAt(n++, M);
    }
    rocks.count = n;
    rocks.castShadow = true; rocks.receiveShadow = true;
    scene.add(rocks);
  }

  // ---------- Hierba 3D por trozos de circuito (para que se descarten los que no se ven) ----------
  const grassChunks = [];
  if (Q.verge > 0) {
    const base = bladeGeometry(), mat = grassMaterial(uniforms);
    const tint = new THREE.Color();
    const CH = 25;
    for (let i0 = 0; i0 < N; i0 += CH) {
      const P = [], D = [], C = [];
      const add = (x, y, z, h, w, field) => {
        P.push(x, y, z);
        D.push(Math.random() * Math.PI, h, w, Math.random() * 6.28);
        tint.setHSL(field ? rand(0.2, 0.28) : rand(0.25, 0.3), field ? rand(0.35, 0.55) : rand(0.4, 0.55), field ? rand(0.2, 0.3) : rand(0.17, 0.24));
        C.push(tint.r, tint.g, tint.b);
      };
      for (let i = i0; i < Math.min(N, i0 + CH); i++) {
        const p = pts[i], t = tan[i], n = nor[i];
        for (const s of [-1, 1]) {
          const nv = Math.round(Q.verge * vergeW * DS);
          for (let b = 0; b < nv; b++) {
            const lat = s * rand(ROAD_W / 2 + CURB + 0.2, BOARD - 0.1), al = rand(0, DS);
            add(p.x + t.x * al + n.x * lat, p.y, p.z + t.z * al + n.z * lat, rand(0.09, 0.2), rand(0.06, 0.1), false);
          }
          if ((i < 40 || i > N - 40) && s < 0) continue; // bajo la tribuna no
          const nf = Math.round(Q.field * 24 * DS);
          for (let b = 0; b < nf; b++) {
            const lat = s * rand(BOARD + 1, BOARD + 25), al = rand(0, DS);
            const x = p.x + t.x * al + n.x * lat, z = p.z + t.z * al + n.z * lat;
            if (trackDistAt(x, z) < BOARD + 0.5 || nearPond(x, z, 1)) continue;
            add(x, groundAt(x, z), z, rand(0.22, 0.55), rand(0.08, 0.13), true);
          }
        }
      }
      const count = P.length / 3;
      if (!count) continue;
      const geo = new THREE.InstancedBufferGeometry();
      geo.setIndex(base.getIndex());
      for (const k of ['position', 'normal', 'color']) geo.setAttribute(k, base.getAttribute(k));
      geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(P), 3));
      geo.setAttribute('iData', new THREE.InstancedBufferAttribute(new Float32Array(D), 4));
      geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(C), 3));
      geo.instanceCount = count;
      const mid = pts[Math.min(N - 1, i0 + (CH >> 1))];
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(mid.x, mid.y, mid.z), CH * DS + BOARD + 30);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'grass';
      grassChunks.push(mesh);
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  // ---------- Tribuna con público en la recta de meta ----------
  const h0 = headingAt(0);
  {
    const stand = new THREE.Group();
    stand.rotation.y = h0 - Math.PI / 2; // +z local apunta al circuito, +x local en sentido de carrera
    const p = pts[0];
    stand.position.set(p.x - nor[0].x * (BOARD + 5), p.y, p.z - nor[0].z * (BOARD + 5));
    const concrete = new THREE.MeshStandardMaterial({ color: 0xbdb9b2, roughness: 0.9, normalMap: repeated(A.asphaltN, 8, 1), normalScale: new THREE.Vector2(0.4, 0.4) });
    for (let s = 0; s < 7; s++) {
      const tier = new THREE.Mesh(new THREE.BoxGeometry(60, 0.8 * (s + 1), 1.4), concrete);
      tier.position.set(0, 0.4 * (s + 1), -s * 1.4);
      tier.castShadow = true; tier.receiveShadow = true;
      stand.add(tier);
    }
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, metalness: 0.6, roughness: 0.35 });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(62, 0.3, 11), roofMat);
    roof.position.set(0, 9.5, -4.5);
    roof.castShadow = true;
    stand.add(roof);
    for (const x of [-30, -10, 10, 30]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 9.5, 8), roofMat);
      col.position.set(x, 4.75, -9.6);
      stand.add(col);
    }
    const fans = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.22, 0.5, 3, 6), new THREE.MeshStandardMaterial({ roughness: 0.8 }), 7 * 70);
    const M = new THREE.Matrix4(), V = new THREE.Vector3(), Qi = new THREE.Quaternion(), S1 = new THREE.Vector3(1, 1, 1), tint = new THREE.Color();
    let n = 0;
    for (let s = 0; s < 7; s++) for (let i = 0; i < 70; i++) {
      if (Math.random() < 0.15) continue;
      M.compose(V.set(-29 + i * 0.84 + rand(-0.1, 0.1), 0.8 * (s + 1) + 0.47, -s * 1.4 + rand(-0.2, 0.1)), Qi, S1);
      fans.setMatrixAt(n, M);
      fans.setColorAt(n++, tint.setHSL(Math.random(), rand(0.4, 0.8), rand(0.35, 0.65)));
    }
    fans.count = n;
    fans.castShadow = true;
    stand.add(fans);
    scene.add(stand);
  }

  // Banderas en la recta principal
  const flags = new THREE.Group();
  {
    const mats = [0xd32f2f, 0x1565c0, 0xfbc02d, 0x2e7d32].map(color => {
      const m = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.7 });
      m.onBeforeCompile = s => {
        Object.assign(s.uniforms, uniforms);
        s.vertexShader = s.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            float ph = modelMatrix[3].x * 0.3;
            transformed.z += sin(position.x * 4.0 - uTime * 7.0 + ph) * 0.13 * position.x;
            transformed.y += sin(position.x * 3.0 - uTime * 5.0 + ph) * 0.03 * position.x;`);
      };
      return m;
    });
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xcfd4da, metalness: 0.8, roughness: 0.3 });
    const flagGeo = new THREE.PlaneGeometry(1.6, 1, 12, 4).translate(0.8, 0, 0);
    let k = 0;
    for (const i of [24, 48, 72, 96, 120, N - 24, N - 48, N - 72, N - 96]) {
      const s = 1, p = pts[i], n = nor[i], lat = s * (BOARD + 2.5);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 7, 6), poleMat);
      pole.position.set(p.x + n.x * lat, p.y + 3.5, p.z + n.z * lat);
      pole.castShadow = true;
      const flag = new THREE.Mesh(flagGeo, mats[k++ % mats.length]);
      flag.position.set(pole.position.x, p.y + 6.3, pole.position.z);
      flag.rotation.y = Math.atan2(SUN.x, SUN.z) + Math.PI / 2; // ondean con el viento, todas igual
      flag.castShadow = true;
      flags.add(pole, flag);
    }
    scene.add(flags);
  }

  // Pórtico de salida con semáforo y línea de meta
  const lamps = [];
  {
    const gantry = new THREE.Group();
    gantry.rotation.y = h0 - Math.PI / 2;
    gantry.position.set(pts[0].x, pts[0].y, pts[0].z);
    const metal = new THREE.MeshStandardMaterial({ color: 0x30343a, metalness: 0.75, roughness: 0.35 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7.5, 0.6), metal);
      post.position.set(0, 3.75, s * (ROAD_W / 2 + 1.6));
      post.castShadow = true;
      gantry.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.4, ROAD_W + 4), metal);
    beam.position.set(0, 7.2, 0);
    beam.castShadow = true;
    gantry.add(beam);
    for (let i = 0; i < 5; i++) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x000000, roughness: 0.25 }));
      lamp.position.set(-0.45, 7.2, (i - 2) * 1.1);
      gantry.add(lamp);
      lamps.push(lamp);
    }
    const chk = canvasTex(256, 32, (g) => { for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5'; g.fillRect(x * 16, y * 16, 16, 16); } });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, 2), new THREE.MeshStandardMaterial({ map: chk, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 }));
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = Math.PI / 2;
    line.position.y = 0.04;
    line.receiveShadow = true;
    gantry.add(line);
    scene.add(gantry);
  }

  // ---------- Posprocesado ----------
  let composer = null, fxPass = null, fxaa = null;
  if (Q.post) {
    const rt = new THREE.WebGLRenderTarget(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio(), { type: THREE.HalfFloatType, samples: Q.msaa });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new LightBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.3, 0.45, 1.0));
    composer.addPass(new OutputPass());
    // Sin MSAA, un FXAA barato suaviza los bordes
    if (!Q.msaa) { fxaa = new ShaderPass(FXAAShader); composer.addPass(fxaa); }
    fxPass = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uBoost: { value: 0 }, uVignette: { value: 0.28 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uBoost; uniform float uVignette; varying vec2 vUv;
        void main() {
          vec2 c = vUv - 0.5;
          vec4 col = texture2D(tDiffuse, vUv);
          if (uBoost > 0.001) {
            vec3 acc = col.rgb;
            for (int i = 1; i <= 6; i++) acc += texture2D(tDiffuse, 0.5 + c * (1.0 - float(i) * 0.014 * uBoost)).rgb;
            col.rgb = mix(col.rgb, acc / 7.0, smoothstep(0.12, 0.5, length(c)));
          }
          float l = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
          col.rgb = mix(vec3(l), col.rgb, 1.1);
          col.rgb = (col.rgb - 0.5) * 1.04 + 0.5;
          col.rgb *= mix(1.0 - uVignette, 1.0, smoothstep(0.85, 0.3, length(c * vec2(1.0, 0.8))));
          gl_FragColor = col;
        }`,
    });
    composer.addPass(fxPass);
  }

  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(innerWidth, innerHeight); }
    const pr = renderer.getPixelRatio();
    fxaa?.material.uniforms.resolution.value.set(1 / (innerWidth * pr), 1 / (innerHeight * pr));
  }

  pmrem.dispose();
  resize();
  await renderer.compileAsync(scene, camera).catch(() => {});
  return {
    scene, camera, resize, quality: Q, pond, composer,
    render: () => (composer ? composer.render() : renderer.render(scene, camera)),
    setPixelRatio(pr) { renderer.setPixelRatio(pr); resize(); },
    update(dt, time, boost) {
      uniforms.uTime.value = time;
      const cp = camera.position, far2 = (Q.grassFar + 40) ** 2;
      for (const g of grassChunks) g.visible = g.geometry.boundingSphere.center.distanceToSquared(cp) < far2;
      if (water) { water.material.normalMap.offset.set(time * 0.011, time * 0.007); water.material.clearcoatNormalMap.offset.set(-time * 0.016, time * 0.012); }
      if (fxPass) fxPass.uniforms.uBoost.value += ((boost ? 1 : 0) - fxPass.uniforms.uBoost.value) * Math.min(1, dt * 6);
    },
    followSun(target) {
      sun.position.copy(target).addScaledVector(SUN, 180);
      sun.target.position.copy(target);
      sun.target.updateMatrixWorld();
    },
    // red = nº de luces rojas encendidas (0-5); green = todas en verde
    setStartLights(red, green) {
      lamps.forEach((l, i) => {
        const on = green || i < red;
        l.material.emissive.set(green ? 0x00ff44 : on ? 0xff1a1a : 0x000000);
        l.material.emissiveIntensity = on ? 6 : 0;
      });
    },
  };
}

// Césped: de la foto solo se usa el detalle (luminancia), el color verde lo ponemos nosotros.
// Con "splat" además mezcla roca y nieve según altura y pendiente.
function splatMaterial(A, rx, ry, macroScale, withSplat) {
  const m = new THREE.MeshStandardMaterial({
    map: repeated(A.grassD, rx, ry), normalMap: repeated(A.grassN, rx, ry), roughness: 1, envMapIntensity: 0.45,
  });
  m.onBeforeCompile = s => {
    s.uniforms.macroMap = { value: A.grassM };
    s.uniforms.rockMap = { value: A.rockD };
    if (withSplat) {
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 splat;\nvarying vec2 vSplat;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat;');
    }
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D macroMap; uniform sampler2D rockMap;
        ${withSplat ? 'varying vec2 vSplat;' : ''}`)
      .replace('#include <map_fragment>', `
        vec3 g1 = texture2D(map, vMapUv).rgb;
        vec3 g2 = texture2D(map, vMapUv * 0.23 + 0.37).rgb;
        float detail = dot(mix(g1, g2, 0.45), vec3(0.2126, 0.7152, 0.0722)) / 0.244;
        vec3 macro = texture2D(macroMap, vMapUv * ${macroScale.toFixed(3)}).rgb / 0.0745;
        vec3 col = vec3(0.062, 0.13, 0.032) * detail * mix(vec3(1.0), macro, 0.35);
        ${withSplat ? `
        vec3 rock = texture2D(rockMap, vMapUv * ${(macroScale * 2.5).toFixed(3)}).rgb;
        rock = mix(vec3(dot(rock, vec3(0.2126, 0.7152, 0.0722))), rock, 0.45) * 1.2;
        vec3 snow = vec3(0.86, 0.88, 0.93) * (0.85 + 0.3 * dot(rock, vec3(0.33)));
        col = mix(col, rock, vSplat.x);
        col = mix(col, snow, vSplat.y);` : ''}
        diffuseColor.rgb *= col;`);
  };
  return m;
}

// Busca el punto del interior del circuito más alejado de la pista para poner un lago
function findPond() {
  const inside = (x, z) => {
    let r = false;
    for (let i = 0, j = N - 1; i < N; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) r = !r;
    }
    return r;
  };
  let best = null;
  for (let x = -170; x <= 185; x += 6) for (let z = -150; z <= 182; z += 6) {
    if (!inside(x, z)) continue;
    const d = trackInfluence(x, z, 2).dist;
    if (!best || d > best.d) best = { x, z, d };
  }
  if (!best) return null;
  const r = Math.min(30, best.d - WALL - 14);
  return r >= 8 ? { x: best.x, z: best.z, r } : null;
}
