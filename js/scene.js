// Mundo 3D: cielo, luz, terreno, circuito y decorado.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { pts, nor, N, DS, ROAD_W, CURB, WALL, trackInfluence, headingAt } from './track-data.js';

const rand = (a, b) => a + Math.random() * (b - a);

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
function speckle(g, w, h, count, alpha, size = 2) {
  for (let i = 0; i < count; i++) {
    const v = Math.random() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${Math.random() * alpha})`;
    g.fillRect(Math.random() * w, Math.random() * h, size * Math.random() + 0.5, size * Math.random() + 0.5);
  }
}

// Tira que sigue el circuito: o0/o1 = desplazamiento lateral, h0/h1 = altura sobre el asfalto
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

// Altura del terreno: igual al circuito cerca de él, colinas suaves lejos y montañas en el borde
const TCX = 6, TCZ = 16;
function hills(x, z) {
  return 5 * Math.sin(x * 0.012 + 1.3) * Math.cos(z * 0.010) + 2.5 * Math.sin(x * 0.031) * Math.sin(z * 0.027 + 2) + 1.2 * Math.sin(x * 0.07 + z * 0.05);
}
export function terrainHeight(x, z, step = 3) {
  const t = trackInfluence(x, z, step);
  const w = THREE.MathUtils.smoothstep(t.dist, WALL + 1, WALL + 45);
  const r = Math.hypot(x - TCX, z - TCZ);
  const far = Math.max(0, r - 290);
  const natural = t.y * 0.6 + hills(x, z) + Math.pow(far, 1.35) * 0.18;
  return THREE.MathUtils.lerp(t.y - 0.35, natural, w);
}

export function createWorld(renderer, quality) {
  const high = quality === 'alta';
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xc9dcef, 260, 1150);
  const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 3000);

  // Cielo y reflejos
  const sky = new Sky();
  sky.scale.setScalar(10000);
  const su = sky.material.uniforms;
  su.turbidity.value = 4; su.rayleigh.value = 1.1; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.82;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(52), THREE.MathUtils.degToRad(145));
  su.sunPosition.value.copy(sunDir);
  scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky.clone());
  scene.environment = pmrem.fromScene(envScene).texture;

  scene.add(new THREE.HemisphereLight(0xdfeeff, 0x45602a, 0.7));
  const sun = new THREE.DirectionalLight(0xfff0d8, 3.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 400 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // Texturas procedurales
  const asphalt = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#46484d'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 60000, 0.18, 2);
    g.fillStyle = 'rgba(20,20,22,0.25)';
    for (let i = 0; i < 6; i++) g.fillRect(w * 0.3 + rand(-20, 20), 0, rand(40, 90), h); // línea de trazada más oscura
    g.fillStyle = '#e8e8e8';
    g.fillRect(6, 0, 10, h); g.fillRect(w - 16, 0, 10, h);
  });
  const asphaltRough = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#d0d0d0'; g.fillRect(0, 0, w, h); speckle(g, w, h, 20000, 0.4, 2); }, false);
  const kerbTex = canvasTex(64, 128, (g, w, h) => {
    g.fillStyle = '#d42a2a'; g.fillRect(0, 0, w, h / 2);
    g.fillStyle = '#f2f2f2'; g.fillRect(0, h / 2, w, h / 2);
    speckle(g, w, h, 600, 0.15, 2);
  });
  const grassTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#5a8f3a'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = `hsla(${rand(80, 110)},${rand(35, 55)}%,${rand(22, 42)}%,0.5)`;
      g.fillRect(Math.random() * w, Math.random() * h, 1.5, rand(2, 5));
    }
  });
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

  // Circuito
  const road = new THREE.Mesh(ribbon(-ROAD_W / 2, ROAD_W / 2, 0.03, 0.03, ROAD_W),
    new THREE.MeshStandardMaterial({ map: asphalt, roughnessMap: asphaltRough, roughness: 0.92, metalness: 0 }));
  road.receiveShadow = true;
  scene.add(road);
  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.6 });
  for (const s of [1, -1]) {
    const k = new THREE.Mesh(ribbon(s * ROAD_W / 2, s * (ROAD_W / 2 + CURB), 0.05, 0.09, 4), kerbMat);
    k.receiveShadow = true;
    scene.add(k);
  }
  const vergeTex = grassTex.clone();
  vergeTex.needsUpdate = true;
  const vergeMat = new THREE.MeshStandardMaterial({ map: vergeTex, roughness: 1, color: 0xb8d8a0 });
  for (const s of [1, -1]) {
    const v = new THREE.Mesh(ribbon(s * (ROAD_W / 2 + CURB), s * (WALL + 1.2), 0.0, 0.0, 6), vergeMat);
    v.receiveShadow = true;
    scene.add(v);
  }
  wallTex.repeat.set(1, 1);
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.55, side: THREE.DoubleSide });
  for (const s of [1, -1]) {
    const geo = ribbon(s * (WALL + 1), s * (WALL + 1), 0, 1.1, 40);
    // en el muro, u recorre la altura y v el circuito: giramos las UV para que el texto quede horizontal
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) { const u = uv.getX(i), v = uv.getY(i); uv.setXY(i, s > 0 ? -v : v, u); } // el muro derecho se ve por la otra cara
    const w = new THREE.Mesh(geo, wallMat);
    w.castShadow = true; w.receiveShadow = true;
    scene.add(w);
    const rail = new THREE.Mesh(ribbon(s * (WALL + 1), s * (WALL + 1.25), 1.1, 1.1, 10), new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.8, roughness: 0.35 }));
    scene.add(rail);
  }

  // Terreno
  const SIZE = 920, SEG = high ? 200 : 120;
  const tg = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  tg.rotateX(-Math.PI / 2);
  tg.translate(TCX, 0, TCZ);
  const tp = tg.attributes.position, colors = [], c = new THREE.Color();
  for (let i = 0; i < tp.count; i++) {
    const x = tp.getX(i), z = tp.getZ(i), y = terrainHeight(x, z, 4);
    tp.setY(i, y);
    const shade = 0.85 + 0.15 * Math.sin(x * 0.05) * Math.cos(z * 0.043) + rand(-0.04, 0.04);
    if (y > 70) c.setRGB(0.95, 0.95, 0.97);
    else if (y > 35) c.setRGB(0.55, 0.52, 0.48).multiplyScalar(shade);
    else c.setRGB(shade, shade, shade * 0.95);
    colors.push(c.r, c.g, c.b);
  }
  tg.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  tg.computeVertexNormals();
  const gtex = grassTex.clone();
  gtex.needsUpdate = true;
  gtex.repeat.set(150, 150);
  const terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ map: gtex, vertexColors: true, roughness: 1 }));
  terrain.receiveShadow = true;
  scene.add(terrain);
  const outer = new THREE.Mesh(new THREE.CircleGeometry(4000, 48), new THREE.MeshStandardMaterial({ color: 0x5f7f52, roughness: 1 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.set(TCX, 40, TCZ);
  scene.add(outer);

  // Montañas lejanas
  {
    const geos = [];
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2 + rand(-0.08, 0.08), r = rand(620, 900), h = rand(140, 300);
      const g = new THREE.ConeGeometry(rand(150, 260), h, 7, 3);
      g.translate(TCX + Math.cos(a) * r, h / 2 + 20, TCZ + Math.sin(a) * r);
      const p = g.attributes.position, col = [];
      for (let j = 0; j < p.count; j++) {
        const y = p.getY(j) - 20, f = y / h;
        p.setX(j, p.getX(j) + rand(-12, 12)); p.setZ(j, p.getZ(j) + rand(-12, 12));
        if (f > 0.72) col.push(0.95, 0.96, 1); else if (f > 0.35) col.push(0.42, 0.42, 0.44); else col.push(0.3, 0.42, 0.26);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geos.push(g.toNonIndexed());
    }
    const m = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
    scene.add(m);
  }

  // Árboles
  const colorize = (g, col) => { const n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) col.toArray(a, i * 3); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
  const trunkCol = new THREE.Color(0x6b4a2f), leafCol = new THREE.Color(0x2f6e2c), leafCol2 = new THREE.Color(0x4f8a2e);
  const pine = mergeGeometries([
    colorize(new THREE.CylinderGeometry(0.22, 0.32, 2.4, 7).translate(0, 1.2, 0), trunkCol),
    colorize(new THREE.ConeGeometry(2.3, 4, 9).translate(0, 3.8, 0), leafCol),
    colorize(new THREE.ConeGeometry(1.8, 3.4, 9).translate(0, 5.6, 0), leafCol),
    colorize(new THREE.ConeGeometry(1.2, 2.8, 9).translate(0, 7.2, 0), leafCol),
  ].map(g => g.toNonIndexed()));
  const crown = new THREE.IcosahedronGeometry(2.4, 1);
  { const p = crown.attributes.position; for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * rand(0.85, 1.15), p.getY(i) * rand(0.8, 1.05), p.getZ(i) * rand(0.85, 1.15)); }
  const broad = mergeGeometries([
    colorize(new THREE.CylinderGeometry(0.25, 0.38, 3.2, 7).translate(0, 1.6, 0), trunkCol).toNonIndexed(),
    colorize(crown.translate(0, 4.6, 0), leafCol2).toNonIndexed(),
  ]);
  const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  const COUNT = high ? 420 : 200;
  const pines = new THREE.InstancedMesh(pine, treeMat, COUNT), broads = new THREE.InstancedMesh(broad, treeMat, COUNT);
  for (const m of [pines, broads]) { m.castShadow = true; m.receiveShadow = true; }
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), V = new THREE.Vector3(), tint = new THREE.Color();
  let np = 0, nb = 0, guard = 0;
  while ((np < COUNT || nb < COUNT) && guard++ < 20000) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 400;
    const x = TCX + Math.cos(a) * r, z = TCZ + Math.sin(a) * r;
    const t = trackInfluence(x, z, 4);
    if (t.dist < WALL + 7) continue;
    if (t.idx > N - 40 || t.idx < 40) { if (t.dist < WALL + 30) continue; } // tribuna
    const isPine = Math.random() < 0.55;
    if (isPine ? np >= COUNT : nb >= COUNT) continue;
    const sc = rand(0.75, 1.5);
    Q.setFromAxisAngle(V.set(0, 1, 0), Math.random() * 6.28);
    M.compose(V.set(x, terrainHeight(x, z, 6) - 0.2, z), Q, S.set(sc, sc * rand(0.9, 1.2), sc));
    tint.setHSL(rand(0.22, 0.32), rand(0.3, 0.6), rand(0.75, 1.05));
    if (isPine) { pines.setMatrixAt(np, M); pines.setColorAt(np++, tint); }
    else { broads.setMatrixAt(nb, M); broads.setColorAt(nb++, tint); }
  }
  pines.count = np; broads.count = nb;
  scene.add(pines, broads);

  // Rocas
  {
    const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x8a8580, roughness: 0.95, flatShading: true }), 70);
    let n = 0;
    while (n < 70) {
      const x = TCX + rand(-380, 380), z = TCZ + rand(-380, 380);
      if (trackInfluence(x, z, 6).dist < WALL + 5) continue;
      const sc = rand(0.6, 2.4);
      Q.setFromEuler(new THREE.Euler(rand(0, 3), rand(0, 3), rand(0, 3)));
      M.compose(V.set(x, terrainHeight(x, z, 6) + sc * 0.2, z), Q, S.set(sc * rand(0.8, 1.4), sc * rand(0.5, 0.9), sc));
      rocks.setMatrixAt(n++, M);
    }
    rocks.castShadow = true; rocks.receiveShadow = true;
    scene.add(rocks);
  }

  // Tribuna con público en la recta de meta (lado exterior)
  const h0 = headingAt(0);
  {
    const stand = new THREE.Group();
    stand.rotation.y = h0 - Math.PI / 2; // +z local apunta al circuito, +x local en sentido de carrera
    const p = pts[0];
    stand.position.set(p.x - nor[0].x * (WALL + 6), p.y, p.z - nor[0].z * (WALL + 6));
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b6b0, roughness: 0.9 });
    for (let s = 0; s < 7; s++) {
      const tier = new THREE.Mesh(new THREE.BoxGeometry(60, 0.8 * (s + 1), 1.4), concrete);
      tier.position.set(0, 0.4 * (s + 1), -s * 1.4);
      tier.castShadow = true; tier.receiveShadow = true;
      stand.add(tier);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(62, 0.3, 11), new THREE.MeshStandardMaterial({ color: 0xe5e7eb, metalness: 0.5, roughness: 0.4 }));
    roof.position.set(0, 9.5, -4.5);
    roof.castShadow = true;
    stand.add(roof);
    for (const x of [-30, -10, 10, 30]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 9.5, 8), roof.material);
      col.position.set(x, 4.75, -9.6);
      stand.add(col);
    }
    const fans = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.22, 0.5, 3, 6), new THREE.MeshStandardMaterial({ roughness: 0.8 }), 7 * 70);
    let n = 0;
    for (let s = 0; s < 7; s++) for (let i = 0; i < 70; i++) {
      if (Math.random() < 0.15) continue;
      M.compose(V.set(-29 + i * 0.84 + rand(-0.1, 0.1), 0.8 * (s + 1) + 0.47, -s * 1.4 + rand(-0.2, 0.1)), Q.identity(), S.set(1, 1, 1));
      fans.setMatrixAt(n, M);
      fans.setColorAt(n++, tint.setHSL(Math.random(), rand(0.4, 0.8), rand(0.35, 0.65)));
    }
    fans.count = n;
    fans.castShadow = true;
    stand.add(fans);
    scene.add(stand);
  }

  // Pórtico de salida con semáforo
  const lamps = [];
  {
    const gantry = new THREE.Group();
    gantry.rotation.y = h0 - Math.PI / 2;
    gantry.position.set(pts[0].x, pts[0].y, pts[0].z);
    const metal = new THREE.MeshStandardMaterial({ color: 0x30343a, metalness: 0.7, roughness: 0.4 });
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
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x000000, roughness: 0.3 }));
      lamp.position.set(-0.45, 7.2, (i - 2) * 1.1);
      gantry.add(lamp);
      lamps.push(lamp);
    }
    // Línea de meta a cuadros
    const chk = canvasTex(256, 32, (g, w, h) => { for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5'; g.fillRect(x * 16, y * 16, 16, 16); } });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, 2), new THREE.MeshStandardMaterial({ map: chk, roughness: 0.7 }));
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = Math.PI / 2;
    line.position.y = 0.045;
    line.receiveShadow = true;
    gantry.add(line);
    scene.add(gantry);
  }

  // Nubes
  {
    const cloud = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, emissive: 0x8899aa, emissiveIntensity: 0.35 }), 30 * 6);
    let n = 0;
    for (let i = 0; i < 30; i++) {
      const cx = TCX + rand(-1100, 1100), cz = TCZ + rand(-1100, 1100), cy = rand(170, 260);
      for (let j = 0; j < 6; j++) {
        const s = rand(14, 30);
        M.compose(V.set(cx + rand(-35, 35), cy + rand(-6, 8), cz + rand(-20, 20)), Q.identity(), S.set(s * 1.3, s * 0.6, s));
        cloud.setMatrixAt(n++, M);
      }
    }
    scene.add(cloud);
  }

  // Posprocesado
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.35, 0.5, 0.9);
  bloom.enabled = high;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
  }

  return {
    scene, camera, composer, resize,
    render: () => composer.render(),
    followSun(target) {
      sun.position.copy(target).addScaledVector(sunDir, 160);
      sun.target.position.copy(target);
      sun.target.updateMatrixWorld();
    },
    // red = nº de luces rojas encendidas (0-5); green = todas en verde
    setStartLights(red, green) {
      lamps.forEach((l, i) => {
        const on = green || i < red;
        l.material.emissive.set(green ? 0x00ff44 : on ? 0xff1a1a : 0x000000);
        l.material.emissiveIntensity = on ? 4 : 0;
      });
    },
  };
}
