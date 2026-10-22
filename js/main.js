import * as THREE from 'three';
import * as T from './track-data.js';
import { newKart, stepKart, wallCollide, kartCollide, speedOf } from './physics.js';
import { botInput } from './ai.js';
import { createWorld } from './scene.js';
import { buildKart } from './kart-model.js';
import { FX } from './fx.js';
import { Sound } from './audio.js';
import { Items, ITEMS, botUseItem } from './items.js';
import { Net } from './net.js';

const $ = id => document.getElementById(id);
const COLORS = ['#e63946', '#2a9df4', '#2ecc71', '#f4d03f', '#9b59b6', '#ff8c1a', '#ff4fa3', '#1abc9c', '#e5e7eb', '#334155'];
const BOT_NAMES = ['Rayo', 'Turbina', 'Chispa', 'Bólido', 'Tornado', 'Pistón', 'Cometa', 'Nitro'];
const STEP = 1 / 240, MAX_KARTS = 8;
const IDLE = { steer: 0, up: false, down: false, drift: false };
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};
const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`;
const cleanName = n => String(n || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 12) || 'Piloto';

// ---------- Motor ----------
const quality = store.get('ka-quality', 'alta');
const renderer = new THREE.WebGLRenderer({ antialias: quality === 'alta', powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'alta' ? 1.5 : 1));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const world = createWorld(renderer, quality);
addEventListener('resize', world.resize);
const fx = new FX(world.scene, quality === 'alta');
const net = new Net();
const sound = new Sound();

const game = {
  world, fx, net, sound, karts: [], phase: 'menu', laps: 3, raceTime: 0, countdown: 0,
  me: { name: store.get('ka-name', 'Piloto' + Math.floor(Math.random() * 90 + 10)), color: store.get('ka-color', COLORS[0]) },
  lobby: { players: [], bots: 3, laps: 3, diff: 0.98, racing: false },
  placeOf(k) { return ranking().indexOf(k) + 1; },
  kartById(id) { return this.karts.find(k => k.id === id); },
  kartAhead(k) { const r = ranking(), i = r.indexOf(k); return i > 0 ? r[i - 1] : null; },
  hitKart(k, kind) {
    const s = k.s;
    if (s.spinT > 0) return;
    s.spinT = kind === 'cascara' ? 0.9 : kind === 'bomba' ? 1.5 : 1.2;
    s.spinDir = Math.random() < 0.5 ? -1 : 1;
    const keep = kind === 'cascara' ? 0.6 : 0.4;
    s.vx *= keep; s.vz *= keep;
    s.drifting = false; s.boostT = 0;
    s.hopV = kind === 'bomba' ? 7 : 3.5;
    if (k.isPlayer) { sound.sfx('hit'); shake = 0.6; }
  },
};
const items = new Items(game);
game.items = items;

// ---------- Karts y carrera ----------
let player = null;

function makeKart(r, slot, diff) {
  const g = T.gridSlot(slot);
  const s = newKart(g.x, g.z, g.h);
  s.idx = g.idx;
  T.locate(s);
  s.hop = 0; s.hopV = 0;
  const isPlayer = !r.bot && r.owner === net.me;
  const owned = r.bot ? (!net.online || net.host) : isPlayer;
  const base = r.bot ? diff * (0.96 + Math.random() * 0.08) : 1;
  const model = buildKart(r.color, r.name, !isPlayer);
  world.scene.add(model.root);
  return {
    ...r, owned, isPlayer, s, model,
    ai: { lane: (Math.random() - 0.5) * 4, laneT: 2, base, skill: base },
    laps: -1, half: true, prevIdx: s.idx, finished: false, finishTime: 0, lapStart: 0, bestLap: Infinity,
    item: null, itemRoll: 0, pending: null, buf: [], wrongT: 0, skidD: 0, smokeT: 0,
  };
}

function clearKarts() {
  for (const k of game.karts) k.model.dispose();
  game.karts = [];
  player = null;
}

function startRace(roster, laps, diff) {
  clearKarts();
  game.karts = roster.map((r, i) => makeKart(r, i, diff));
  player = game.karts.find(k => k.isPlayer) || null;
  Object.assign(game, { laps, raceTime: 0, countdown: 4.2, phase: 'countdown' });
  items.reset();
  world.setStartLights(0, false);
  lastRed = 0;
  show('hud'); hide('menu'); hide('lobby'); hide('results');
  $('touch').hidden = !isTouch;
  if (player) camYaw = player.s.h;
  snapCam = true;
}

const progress = k => (k.finished ? 1e9 - k.finishTime : k.laps * T.N + k.s.idx);
const ranking = () => [...game.karts].sort((a, b) => progress(b) - progress(a));
const inRace = () => ['countdown', 'race', 'done'].includes(game.phase);

// ---------- Entrada ----------
const keys = new Set();
let itemPressed = false, respawnPressed = false;
const isTouch = matchMedia('(pointer: coarse)').matches;
const touch = { steer: 0, up: false, down: false, drift: false };
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (!e.repeat && ['KeyE', 'ShiftLeft', 'ShiftRight', 'KeyK'].includes(e.code)) itemPressed = true;
  if (!e.repeat && e.code === 'KeyR') respawnPressed = true;
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const gpPrev = {};
function readInput() {
  let steer = (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) - (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0);
  let up = keys.has('KeyW') || keys.has('ArrowUp'), down = keys.has('KeyS') || keys.has('ArrowDown');
  let drift = keys.has('Space'), look = keys.has('KeyC');
  const gp = navigator.getGamepads?.()[0];
  if (gp) {
    const b = i => !!gp.buttons[i]?.pressed;
    if (Math.abs(gp.axes[0]) > 0.15) steer = -gp.axes[0];
    up = up || b(0) || (gp.buttons[7]?.value ?? 0) > 0.3;
    down = down || b(1) || (gp.buttons[6]?.value ?? 0) > 0.3;
    drift = drift || b(5);
    look = look || b(3);
    for (const [i, act] of [[2, 'item'], [4, 'item'], [8, 'respawn']]) {
      if (b(i) && !gpPrev[i]) { if (act === 'item') itemPressed = true; else respawnPressed = true; }
      gpPrev[i] = b(i);
    }
  }
  if (touch.steer) steer = touch.steer;
  return { steer, up: up || touch.up, down: down || touch.down, drift: drift || touch.drift, look };
}

// Controles táctiles
if (isTouch) {
  const bind = (id, on, off) => {
    const el = $(id);
    el.addEventListener('touchstart', e => { e.preventDefault(); on(); }, { passive: false });
    el.addEventListener('touchend', e => { e.preventDefault(); off(); }, { passive: false });
  };
  bind('tLeft', () => { touch.steer = 1; }, () => { touch.steer = 0; });
  bind('tRight', () => { touch.steer = -1; }, () => { touch.steer = 0; });
  bind('tGas', () => { touch.up = true; }, () => { touch.up = false; });
  bind('tBrake', () => { touch.down = true; }, () => { touch.down = false; });
  bind('tDrift', () => { touch.drift = true; }, () => { touch.drift = false; });
  bind('tItem', () => { itemPressed = true; }, () => {});
}

// ---------- Simulación ----------
let acc = 0;
function stepOwned(dt, inputs) {
  const owned = game.karts.filter(k => k.owned);
  acc += dt;
  while (acc >= STEP) {
    for (const k of owned) {
      const s = k.s, t = T.tan[s.idx];
      const along = T.slope[s.idx] * (Math.sin(s.h) * t.x + Math.cos(s.h) * t.z);
      const v0 = speedOf(s);
      stepKart(s, inputs.get(k), STEP, along);
      T.locate(s);
      s.offroad = Math.abs(s.lat) > T.ROAD_W / 2 + T.CURB;
      if (wallCollide(s, T.nor[s.idx], T.WALL) && k.isPlayer && v0 > 10 && wallCd <= 0) {
        wallCd = 0.4; shake = Math.min(0.5, v0 / 60); sound.noise(0.15, 0.25, 900);
      }
    }
    acc -= STEP;
  }
}

function lapLogic(k) {
  const i = k.s.idx;
  if (i > T.N * 0.4 && i < T.N * 0.6) k.half = true;
  if (k.prevIdx > T.N * 0.8 && i < T.N * 0.2 && k.half) {
    k.laps++; k.half = false;
    if (k.laps > 0) {
      k.bestLap = Math.min(k.bestLap, game.raceTime - k.lapStart);
      if (k.isPlayer && k.laps < game.laps) {
        toast(k.laps === game.laps - 1 ? '¡ÚLTIMA VUELTA!' : `Vuelta ${k.laps + 1}/${game.laps}`);
        sound.sfx('lap');
      }
    }
    k.lapStart = game.raceTime;
    if (k.laps >= game.laps && !k.finished) {
      k.finished = true;
      k.finishTime = game.raceTime;
      net.send({ t: 'fin', id: k.id, time: k.finishTime });
      if (k.isPlayer) { game.phase = 'done'; sound.sfx('lap'); showResults(); }
    }
  } else if (k.prevIdx < T.N * 0.2 && i > T.N * 0.8 && !k.half) {
    k.laps--; k.half = true;
  }
  k.prevIdx = i;
}

function collisions() {
  const ks = game.karts;
  for (let a = 0; a < ks.length; a++) for (let b = a + 1; b < ks.length; b++) {
    const A = ks[a], B = ks[b];
    if (!A.owned && !B.owned) continue;
    const imp = kartCollide(A.s, B.s, A.owned, B.owned);
    if (imp <= 0) continue;
    if (A.owned && B.s.shieldT > 0 && A.s.shieldT <= 0) game.hitKart(A, 'misil');
    if (B.owned && A.s.shieldT > 0 && B.s.shieldT <= 0) game.hitKart(B, 'misil');
    if ((A.isPlayer || B.isPlayer) && imp > 4) sound.noise(0.12, 0.2, 700);
  }
}

// Ajuste dinámico de los bots respecto al mejor humano
function rubberBand() {
  const humans = game.karts.filter(k => !k.bot);
  if (!humans.length) return;
  const best = Math.max(...humans.map(progress));
  for (const k of game.karts) {
    if (!k.bot || !k.owned) continue;
    const gap = (best - progress(k)) / T.N;
    k.ai.skill = k.ai.base * (gap > 0.3 ? 1.07 : gap < -0.3 ? 0.94 : 1);
  }
}

// ---------- Red ----------
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
function sendSnapshot() {
  const ks = game.karts.filter(k => k.owned).map(k => {
    const s = k.s;
    const flags = (s.drifting ? 1 : 0) | (s.boostT > 0 ? 2 : 0) | (s.shieldT > 0 ? 4 : 0) | (s.spinT > 0 ? 8 : 0)
      | (s.driftCharge > 1 ? 16 : 0) | (s.driftCharge > 2 ? 32 : 0) | (k.finished ? 64 : 0);
    return [k.id, r2(s.x), r2(s.ground), r2(s.z), r3(s.h), r2(s.vx), r2(s.vz), r3(s.delta), flags, k.laps, s.idx, r2(s.beta)];
  });
  if (ks.length) net.send({ t: 'st', ks });
}

function applyRemote(k, now) {
  const b = k.buf;
  if (!b.length) return;
  const rt = now - 100;
  while (b.length > 2 && b[1].t <= rt) b.shift();
  const a = b[0], c = b[1], s = k.s;
  let x, y, z, h;
  if (c && rt >= a.t) {
    const f = Math.min(1, (rt - a.t) / Math.max(1, c.t - a.t));
    x = a.x + (c.x - a.x) * f; y = a.y + (c.y - a.y) * f; z = a.z + (c.z - a.z) * f;
    h = a.h + T.wrap(c.h - a.h) * f;
    Object.assign(s, { vx: c.vx, vz: c.vz, delta: c.delta });
  } else {
    const l = b[b.length - 1], e = Math.max(0, Math.min(0.25, (rt - l.t) / 1000));
    x = l.x + l.vx * e; y = l.y; z = l.z + l.vz * e; h = l.h;
    Object.assign(s, { vx: l.vx, vz: l.vz, delta: l.delta });
  }
  const l = b[b.length - 1], f = l.flags;
  Object.assign(s, {
    x, z, h, ground: y, idx: l.idx, beta: l.beta,
    drifting: !!(f & 1), boostT: f & 2 ? 0.1 : 0, shieldT: f & 4 ? 0.1 : 0, spinT: f & 8 ? 0.1 : 0,
    driftCharge: f & 32 ? 2.1 : f & 16 ? 1.1 : f & 1 ? 0.5 : 0, lonAcc: 0, latAcc: 0,
  });
  s.vf = s.vx * Math.sin(h) + s.vz * Math.cos(h);
  k.laps = l.laps;
}

net.on('join', m => {
  if (!net.host) return;
  if (game.lobby.players.length >= MAX_KARTS) return;
  const used = new Set(game.lobby.players.map(p => p.color));
  const color = COLORS.includes(m.color) && !used.has(m.color) ? m.color : COLORS.find(c => !used.has(c));
  const p = { pid: m.from, name: cleanName(m.name), color };
  game.lobby.players.push(p);
  toast(`${p.name} se ha unido`);
  broadcastLobby();
});
net.on('leave', m => {
  const p = game.lobby.players.find(p => p.pid === m.from);
  if (p) toast(`${p.name} se ha ido`);
  if (net.host) { game.lobby.players = game.lobby.players.filter(p => p.pid !== m.from); broadcastLobby(); }
  for (const k of game.karts.filter(k => k.owner === m.from && !k.bot)) k.model.dispose();
  game.karts = game.karts.filter(k => k.owner !== m.from || k.bot);
});
net.on('lobby', m => {
  if (net.host) return;
  game.lobby = m.lobby;
  renderLobby();
});
net.on('start', m => { if (!net.host) startRace(m.roster, m.laps, m.diff); });
net.on('tolobby', () => { if (!net.host) showLobby(); });
net.on('st', m => {
  const now = performance.now();
  for (const e of m.ks || []) {
    const k = game.kartById(e[0]);
    if (!k || k.owned) continue;
    const [, x, y, z, h, vx, vz, delta, flags, laps, idx, beta] = e;
    k.buf.push({ t: now, x, y, z, h, vx, vz, delta, flags, laps, idx, beta });
    if (k.buf.length > 12) k.buf.shift();
  }
});
net.on('box', m => items.takeBox(m.b));
net.on('spawn', m => { if (m.o && !items.objs.has(m.o.id) && ITEMS[m.o.type]) items.spawn(m.o); });
net.on('hit', m => items.onRemoteHit(m.o));
net.on('fin', m => {
  const k = game.kartById(m.id);
  if (k && !k.finished) { k.finished = true; k.finishTime = m.time; }
});
net.on('hostgone', () => { goMenu(); setMsg('El anfitrión ha cerrado la sala.'); });

// ---------- Menú y sala ----------
const show = id => { $(id).hidden = false; }, hide = id => { $(id).hidden = true; };
const setMsg = t => { $('menuMsg').textContent = t; };
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
}

function renderColors() {
  const box = $('colors');
  box.innerHTML = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === game.me.color ? ' on' : '');
    b.style.background = c;
    b.title = c;
    b.onclick = () => { game.me.color = c; store.set('ka-color', c); renderColors(); };
    box.appendChild(b);
  }
}

function broadcastLobby() {
  game.lobby.racing = inRace();
  net.send({ t: 'lobby', lobby: game.lobby });
  renderLobby();
}

function renderLobby() {
  const L = game.lobby, ul = $('players');
  ul.innerHTML = '';
  for (const p of L.players) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.style.background = p.color;
    li.append(dot, document.createTextNode(p.name + (p.pid === 'H' ? ' (anfitrión)' : '') + (p.pid === net.me ? ' — tú' : '')));
    ul.appendChild(li);
  }
  const hosting = !net.online || net.host;
  $('hostOpts').hidden = !hosting;
  $('waitMsg').hidden = hosting;
  $('waitMsg').textContent = L.racing ? 'Hay una carrera en curso: entrarás en la siguiente.' : 'Esperando a que el anfitrión empiece…';
  $('bots').value = L.bots; $('botsVal').textContent = L.bots;
  $('laps').value = L.laps; $('lapsVal').textContent = L.laps;
  $('diff').value = String(L.diff);
}

function showLobby() {
  clearKarts();
  items.reset();
  game.phase = 'lobby';
  sound.silence();
  hide('menu'); hide('hud'); hide('results'); show('lobby');
  $('touch').hidden = true;
  $('linkBox').hidden = !net.online;
  $('lobbyTitle').textContent = net.online ? `Sala ${net.code}` : 'Carrera contra bots';
  if (net.online) $('link').value = `${location.origin}${location.pathname}#${net.code}`;
  renderLobby();
}

function goMenu() {
  net.close();
  clearKarts();
  items.reset();
  game.phase = 'menu';
  sound.silence();
  history.replaceState(null, '', location.pathname + location.search);
  hide('lobby'); hide('hud'); hide('results'); show('menu');
  $('touch').hidden = true;
  setupMenu();
}

function readMe() {
  game.me.name = cleanName($('name').value);
  store.set('ka-name', game.me.name);
  sound.init();
}

function setupMenu() {
  const code = location.hash.slice(1).toUpperCase();
  const valid = /^[A-Z0-9]{5}$/.test(code);
  $('joinBox').hidden = !valid;
  $('joinCode').textContent = valid ? code : '';
}

async function join(code) {
  readMe();
  setMsg('Conectando…');
  try {
    await net.joinRoom(code, { name: game.me.name, color: game.me.color });
    setMsg('');
    game.lobby = { players: [], bots: 0, laps: 3, diff: 0.98, racing: false };
    showLobby();
  } catch (e) {
    setMsg(e.message || String(e));
  }
}

$('name').value = game.me.name;
$('quality').value = quality;
$('quality').onchange = e => { store.set('ka-quality', e.target.value); location.reload(); };
renderColors();
setupMenu();

$('btnSolo').onclick = () => {
  readMe();
  net.close();
  game.lobby = { players: [{ pid: 'solo', name: game.me.name, color: game.me.color }], bots: 5, laps: 3, diff: 0.98, racing: false };
  showLobby();
};
$('btnHost').onclick = async () => {
  readMe();
  setMsg('Creando sala…');
  try {
    await net.createRoom();
    setMsg('');
    game.lobby = { players: [{ pid: 'H', name: game.me.name, color: game.me.color }], bots: 2, laps: 3, diff: 0.98, racing: false };
    history.replaceState(null, '', `#${net.code}`);
    showLobby();
  } catch (e) {
    setMsg('No se pudo crear la sala: ' + (e.type || e.message || e));
  }
};
$('btnJoin').onclick = () => join(location.hash.slice(1).toUpperCase());
$('btnCode').onclick = () => {
  const c = $('codeInput').value.trim().toUpperCase();
  if (/^[A-Z0-9]{5}$/.test(c)) join(c); else setMsg('El código tiene 5 letras o números.');
};
$('btnCopy').onclick = async () => {
  const link = $('link').value;
  try { await navigator.clipboard.writeText(link); toast('Enlace copiado'); }
  catch { $('link').select(); document.execCommand('copy'); toast('Enlace copiado'); }
};
$('btnLeave').onclick = goMenu;
for (const id of ['bots', 'laps']) {
  $(id).oninput = e => { game.lobby[id] = +e.target.value; broadcastLobby(); };
}
$('diff').onchange = e => { game.lobby.diff = +e.target.value; broadcastLobby(); };
$('btnStart').onclick = () => {
  sound.init();
  const L = game.lobby;
  const humans = L.players.map(p => ({ id: 'k-' + p.pid, name: p.name, color: p.color, owner: p.pid, bot: false }))
    .sort(() => Math.random() - 0.5);
  const used = new Set(humans.map(h => h.color));
  const free = COLORS.filter(c => !used.has(c));
  const nb = Math.max(0, Math.min(L.bots, MAX_KARTS - humans.length));
  const bots = Array.from({ length: nb }, (_, i) => ({ id: 'b' + i, name: BOT_NAMES[i], color: free[i % free.length], owner: net.me, bot: true }));
  const roster = [...bots, ...humans];
  net.send({ t: 'start', roster, laps: L.laps, diff: L.diff });
  startRace(roster, L.laps, L.diff);
};

// ---------- Resultados ----------
function showResults() {
  show('results');
  const btns = $('resBtns');
  btns.innerHTML = '';
  const add = (text, fn, primary) => {
    const b = document.createElement('button');
    b.textContent = text;
    if (primary) b.className = 'primary';
    b.onclick = fn;
    btns.appendChild(b);
  };
  if (!net.online) { add('Repetir', () => $('btnStart').onclick(), true); add('Cambiar ajustes', showLobby); add('Menú', goMenu); }
  else if (net.host) { add('Otra carrera', () => { net.send({ t: 'tolobby' }); showLobby(); broadcastLobby(); }, true); add('Cerrar sala', goMenu); }
  else { add('Salir de la sala', goMenu); }
  renderResults();
}
function renderResults() {
  const r = ranking(), place = r.indexOf(player) + 1;
  $('resTitle').textContent = place === 1 ? '¡Victoria!' : `Has quedado ${place}º`;
  const table = $('resTable');
  table.innerHTML = '';
  r.forEach((k, i) => {
    const tr = document.createElement('tr');
    if (k === player) tr.className = 'me';
    const cells = [`${i + 1}º`, k.name + (k.bot ? ' 🤖' : ''), k.finished ? fmt(k.finishTime) : '—', isFinite(k.bestLap) ? fmt(k.bestLap) : ''];
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
    tr.firstChild.style.borderLeft = `4px solid ${k.color}`;
    table.appendChild(tr);
  });
}

// ---------- HUD ----------
const mapCv = $('map'), mapCtx = mapCv.getContext('2d');
const xs = T.pts.map(p => p.x), zs = T.pts.map(p => p.z);
const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
const mapS = 160 / Math.max(maxX - minX, maxZ - minZ);
const toMap = (x, z) => [15 + (x - minX) * mapS, 15 + (z - minZ) * mapS]; // vista cenital sin espejo
const mapPath = new Path2D();
T.pts.forEach((p, i) => { if (i % 4 === 0) mapPath[i ? 'lineTo' : 'moveTo'](...toMap(p.x, p.z)); });
mapPath.closePath();
const icons = Object.values(ITEMS).map(i => i.icon);

function drawMap() {
  mapCtx.clearRect(0, 0, 190, 190);
  mapCtx.lineJoin = 'round';
  mapCtx.strokeStyle = '#0008'; mapCtx.lineWidth = 9; mapCtx.stroke(mapPath);
  mapCtx.strokeStyle = '#e5e7eb'; mapCtx.lineWidth = 5; mapCtx.stroke(mapPath);
  for (const k of [...game.karts.filter(k => k !== player), player].filter(Boolean)) {
    const [x, y] = toMap(k.s.x, k.s.z);
    mapCtx.fillStyle = k.color;
    mapCtx.beginPath(); mapCtx.arc(x, y, k === player ? 6 : 4.5, 0, Math.PI * 2); mapCtx.fill();
    mapCtx.strokeStyle = '#fff'; mapCtx.lineWidth = k === player ? 2.5 : 1; mapCtx.stroke();
  }
}

function drawHud(time) {
  if (!player) return;
  const r = ranking(), place = r.indexOf(player) + 1;
  $('pos').innerHTML = `${place}º<small>/${r.length}</small>`;
  $('lap').textContent = `Vuelta ${T.clamp(player.laps + 1, 1, game.laps)}/${game.laps}`;
  $('time').textContent = fmt(player.finished ? player.finishTime : game.raceTime);
  $('best').textContent = isFinite(player.bestLap) ? `Mejor vuelta ${fmt(player.bestLap)}` : '';
  $('spd').textContent = Math.round(speedOf(player.s) * 3.6);
  const s = player.s;
  $('spd').style.color = s.boostT > 0 ? '#ffb020' : s.driftCharge > 2 ? '#ff8a1a' : s.driftCharge > 1 ? '#5bb8ff' : '';
  $('itemIcon').textContent = player.itemRoll > 0 ? icons[Math.floor(time * 14) % icons.length] : player.item ? ITEMS[player.item].icon : '';
  $('itemSlot').classList.toggle('ready', !!player.item);
  const board = $('board');
  board.innerHTML = '';
  for (const k of r) {
    const li = document.createElement('li');
    if (k === player) li.className = 'me';
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.style.background = k.color;
    li.append(dot, document.createTextNode(k.name));
    board.appendChild(li);
  }
  $('wrong').hidden = player.wrongT < 1;
  if (game.phase === 'done') renderResults();
}

// ---------- Cámara ----------
let camYaw = 0, snapCam = true, shake = 0, wallCd = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), tmpV = new THREE.Vector3(), tmpL = new THREE.Vector3();
function chaseCamera(dt, look) {
  const s = player.s, v = speedOf(s);
  const velYaw = v > 3 ? Math.atan2(s.vx, s.vz) : s.h;
  const target = s.spinT > 0 ? velYaw : s.h + T.wrap(velYaw - s.h) * 0.35;
  camYaw += T.wrap(target - camYaw) * (snapCam ? 1 : 1 - Math.exp(-5 * dt));
  const dir = look ? -1 : 1, fx = Math.sin(camYaw) * dir, fz = Math.cos(camYaw) * dir;
  tmpV.set(s.x - fx * 6.2, s.ground + 2.3, s.z - fz * 6.2);
  tmpL.set(s.x + fx * 3, s.ground + 0.9, s.z + fz * 3);
  const t = snapCam || look ? 1 : 1 - Math.exp(-12 * dt);
  camPos.lerp(tmpV, t); camLook.lerp(tmpL, t);
  if (snapCam) { camPos.copy(tmpV); camLook.copy(tmpL); snapCam = false; }
  world.camera.position.copy(camPos);
  if (shake > 0) {
    world.camera.position.x += (Math.random() - 0.5) * shake * 0.6;
    world.camera.position.y += (Math.random() - 0.5) * shake * 0.6;
    shake = Math.max(0, shake - dt * 1.5);
  }
  world.camera.lookAt(camLook);
  const fov = 68 + v * 0.35 + (s.boostT > 0 ? 8 : 0);
  world.camera.fov += (fov - world.camera.fov) * Math.min(1, 4 * dt);
  world.camera.updateProjectionMatrix();
  world.followSun(tmpL.set(s.x, s.ground, s.z));
}

let orbit = 0;
function menuCamera(dt) {
  orbit += dt * 0.04;
  world.camera.position.set(6 + Math.cos(orbit) * 230, 95, 16 + Math.sin(orbit) * 230);
  world.camera.lookAt(6, 0, 16);
  world.camera.fov = 60;
  world.camera.updateProjectionMatrix();
  world.followSun(tmpL.set(6, 0, 16));
}

// ---------- Efectos por kart ----------
function kartFx(k, dt) {
  const s = k.s, v = speedOf(s);
  const slipping = (s.drifting || Math.abs(s.beta) > 0.16 || s.spinT > 0) && v > 7 && !s.offroad;
  const wheels = k.model.rearWheels(s);
  k.skidD += v * dt;
  if (k.skidD > 0.35) {
    k.skidD = 0;
    if (slipping) for (const w of wheels) fx.skid(w.x, w.y, w.z, s.h);
  }
  k.smokeT -= dt;
  if (k.smokeT <= 0) {
    if (slipping) { for (const w of wheels) fx.smokeAt(w.x, w.y, w.z, 0xe5e5e5, 0.8, 1.1, 0.35); k.smokeT = 0.05; }
    else if (s.offroad && v > 5) { for (const w of wheels) fx.smokeAt(w.x, w.y, w.z, 0x9b7b55, 0.9, 0.9, 0.4); k.smokeT = 0.07; }
  }
  if (s.drifting && s.driftCharge > 0.4) {
    const col = s.driftCharge > 2 ? 0xff8a1a : s.driftCharge > 1 ? 0x3fa9ff : 0xffffff;
    for (const w of wheels) if (Math.random() < 0.5) fx.sparkAt(w.x, w.y, w.z, col);
  }
  if (s.hopV || s.hop > 0) {
    s.hop += s.hopV * dt; s.hopV -= 20 * dt;
    if (s.hop <= 0) { s.hop = 0; s.hopV = 0; }
  }
}

// ---------- Bucle principal ----------
let last = performance.now(), time = 0, sendT = 0, hudT = 0, mapT = 0, lastRed = 0;
function countdownTick(dt) {
  game.countdown -= dt;
  const red = T.clamp(Math.floor((4.2 - game.countdown) / 0.7), 0, 5);
  if (red !== lastRed) { lastRed = red; world.setStartLights(red, false); sound.beep(440, 0.18); }
  $('center').textContent = '';
  if (game.countdown <= 0) {
    game.phase = 'race';
    world.setStartLights(0, true);
    sound.beep(880, 0.5);
    $('center').textContent = '¡YA!';
    setTimeout(() => { if ($('center').textContent === '¡YA!') $('center').textContent = ''; }, 900);
    setTimeout(() => world.setStartLights(0, false), 2500);
  }
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now; time += dt;
  wallCd -= dt;

  if (inRace()) {
    if (game.phase === 'countdown') countdownTick(dt);
    const racing = game.phase !== 'countdown';
    const inp = player ? readInput() : IDLE;
    if (racing) {
      game.raceTime += dt;
      rubberBand();
      const inputs = new Map();
      for (const k of game.karts) {
        if (!k.owned) continue;
        inputs.set(k, k.bot || k.finished ? botInput(k.s, k.ai) : inp);
      }
      stepOwned(dt, inputs);
      for (const k of game.karts) {
        if (!k.owned) continue;
        lapLogic(k);
        if (k.itemRoll > 0 && (k.itemRoll -= dt) <= 0) { k.item = k.pending; k.pending = null; }
        items.pickup(k);
        if (k.bot || k.finished) botUseItem(k, items, dt);
      }
      if (player && !player.finished) {
        if (itemPressed) items.use(player, inp.down);
        if (respawnPressed) {
          const s = player.s, i = (s.idx - 2 + T.N) % T.N;
          Object.assign(s, { x: T.pts[i].x, z: T.pts[i].z, h: T.headingAt(i), vx: 0, vz: 0, r: 0, spinT: 0, drifting: false, idx: i });
          T.locate(s);
          snapCam = true;
        }
        const t = T.tan[player.s.idx];
        const dot = Math.sin(player.s.h) * t.x + Math.cos(player.s.h) * t.z;
        player.wrongT = dot < -0.4 && speedOf(player.s) > 3 ? player.wrongT + dt : 0;
      }
      collisions();
    }
    itemPressed = false; respawnPressed = false;
    for (const k of game.karts) if (!k.owned) applyRemote(k, now);
    items.update(dt, time);

    if (net.online && (sendT -= dt) <= 0) { sendT = 0.05; sendSnapshot(); }
    if (player) {
      chaseCamera(dt, inp.look);
      const s = player.s;
      sound.engine(speedOf(s), racing ? inp.up : false, (s.drifting || Math.abs(s.beta) > 0.15) && speedOf(s) > 7 && !s.offroad ? Math.min(1, Math.abs(s.beta) * 2.5 + (s.drifting ? 0.3 : 0)) : 0, s.boostT > 0);
      if ((hudT -= dt) <= 0) { hudT = 0.1; drawHud(time); }
      if ((mapT -= dt) <= 0) { mapT = 1 / 30; drawMap(); }
    }
  } else {
    menuCamera(dt);
    items.update(dt, time);
  }

  for (const k of game.karts) { kartFx(k, dt); k.model.update(k.s, dt, time); }
  fx.update(dt);
  world.render();
  requestAnimationFrame(frame);
}

if (new URLSearchParams(location.search).has('debug')) window.kartDebug = { game, ranking, T };
hide('loading');
requestAnimationFrame(frame);
