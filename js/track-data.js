// Geometría del circuito sin Three.js: la usan la física, la IA, la red y los gráficos.
export const ROAD_W = 16, CURB = 1.4, WALL = ROAD_W / 2 + 5, N = 1000;

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// [x, z, altura]
const CP = [
  [0, -150, 0], [120, -150, 0], [185, -105, 2], [175, -25, 8], [115, 5, 12], [100, 70, 13],
  [160, 120, 7], [130, 182, 2], [40, 172, 0], [-20, 112, -1], [-90, 152, 3], [-162, 110, 8],
  [-172, 20, 11], [-112, -20, 7], [-152, -90, 3], [-100, -150, 0],
];

// Catmull-Rom centrípeta (Barry-Goldman)
function catmull(p0, p1, p2, p3, t) {
  const d = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), 0.5) || 1e-4;
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const mix = (a, b, ta, tb) => a.map((v, i) => ((tb - u) * v + (u - ta) * b[i]) / (tb - ta));
  const A1 = mix(p0, p1, t0, t1), A2 = mix(p1, p2, t1, t2), A3 = mix(p2, p3, t2, t3);
  return mix(mix(A1, A2, t0, t2), mix(A2, A3, t1, t3), t1, t2);
}

const P = CP.map(([x, z, y]) => [x, y, z]);
const dense = [];
for (let i = 0; i < P.length; i++) {
  const n = P.length;
  for (let s = 0; s < 300; s++) dense.push(catmull(P[(i - 1 + n) % n], P[i], P[(i + 1) % n], P[(i + 2) % n], s / 300));
}
const cum = [0];
for (let i = 1; i <= dense.length; i++) {
  const a = dense[i - 1], b = dense[i % dense.length];
  cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[2] - a[2]));
}

export const LENGTH = cum[dense.length];
export const DS = LENGTH / N;

// Puntos equiespaciados del eje central
export const pts = [];
for (let i = 0, j = 0; i < N; i++) {
  const target = i * DS;
  while (cum[j + 1] < target) j++;
  const f = (target - cum[j]) / (cum[j + 1] - cum[j]);
  const a = dense[j], b = dense[(j + 1) % dense.length];
  pts.push({ x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, z: a[2] + (b[2] - a[2]) * f });
}

export const tan = pts.map((p, i) => {
  const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N], dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
  return { x: dx / l, z: dz / l };
});
export const nor = tan.map(t => ({ x: -t.z, z: t.x })); // derecha del sentido de carrera
export const headingAt = i => Math.atan2(tan[i].x, tan[i].z);
export const slope = pts.map((p, i) => (pts[(i + 1) % N].y - pts[(i - 1 + N) % N].y) / (2 * DS));
const ang = tan.map(t => Math.atan2(t.x, t.z));
export const curv = ang.map((a, i) => Math.abs(wrap(ang[(i + 4) % N] - ang[(i - 4 + N) % N])) / (8 * DS));

// Velocidad máxima recomendable por punto (para la IA)
export function speedProfile(alat, decel, vtop) {
  const v = curv.map(k => Math.min(vtop, Math.sqrt(alat / Math.max(k, 1e-4))));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      const nx = v[(i + 1) % N];
      v[i] = Math.min(v[i], Math.sqrt(nx * nx + 2 * decel * DS));
    }
  }
  return v;
}

// Actualiza idx (punto más cercano), lat (desplazamiento lateral, + = derecha) y ground (altura del asfalto)
export function locate(k) {
  let best = k.idx, bd = Infinity;
  for (let o = -20; o <= 30; o++) {
    const i = (k.idx + o + N) % N, dx = k.x - pts[i].x, dz = k.z - pts[i].z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  k.idx = best;
  const p = pts[best], t = tan[best], n = nor[best], dx = k.x - p.x, dz = k.z - p.z;
  k.lat = dx * n.x + dz * n.z;
  const along = dx * t.x + dz * t.z;
  const q = pts[(best + (along >= 0 ? 1 : N - 1)) % N];
  k.ground = p.y + (q.y - p.y) * Math.min(1, Math.abs(along) / DS);
}

export function nearestIdx(x, z) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < N; i++) {
    const d = (x - pts[i].x) ** 2 + (z - pts[i].z) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Altura del eje central más cercano y distancia a él (para el terreno)
export function trackInfluence(x, z, step = 2) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < N; i += step) {
    const d = (x - pts[i].x) ** 2 + (z - pts[i].z) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return { dist: Math.sqrt(bd), y: pts[best].y, idx: best };
}

// Posiciones de salida en parrilla (dos columnas)
export function gridSlot(s) {
  const row = Math.floor(s / 2), idx = (N - 6 - row * 5) % N, side = s % 2 ? 3.5 : -3.5;
  return { idx, x: pts[idx].x + nor[idx].x * side, z: pts[idx].z + nor[idx].z * side, h: headingAt(idx) };
}

export const ITEM_ROWS = [Math.round(N * 0.12), Math.round(N * 0.45), Math.round(N * 0.74)];
export const ITEM_LANES = [-5.4, -1.8, 1.8, 5.4];
