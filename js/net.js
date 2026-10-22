// Multijugador: conexión directa entre navegadores (PeerJS/WebRTC) y, si la red la bloquea,
// respaldo a través de servidores MQTT públicos por WebSocket seguro (funciona en cualquier red).
// El anfitrión escucha por todas las vías y reenvía los mensajes de cada cliente al resto.
/* global Peer, mqtt */
const PREFIX = 'kartamigos-v1-';
const TOPIC = 'kartamigos/v1/';
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};
const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
const DIRECT_TIMEOUT = 6000, RELAY_TIMEOUT = 9000;
const rid = n => Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
const decode = p => { try { return JSON.parse(new TextDecoder().decode(p)); } catch { return null; } };

const hasPeer = () => typeof Peer === 'function';
const hasMqtt = () => typeof mqtt === 'object' && typeof mqtt.connect === 'function';

function connectBroker(url) {
  return new Promise((resolve, reject) => {
    if (!hasMqtt()) { reject(new Error('mqtt no cargado')); return; }
    const c = mqtt.connect(url, { clientId: 'ka_' + rid(10), clean: true, connectTimeout: 7000, reconnectPeriod: 3000, keepalive: 20 });
    const t = setTimeout(() => { c.end(true); reject(new Error('timeout ' + url)); }, 8000);
    c.once('connect', () => { clearTimeout(t); resolve(c); });
  });
}

export class Net {
  constructor() {
    this.handlers = new Map();
    this.reset();
  }

  reset() {
    clearInterval(this.beat);
    this.peer?.destroy();
    for (const b of this.brokers || []) b.end(true);
    Object.assign(this, {
      peer: null, brokers: [], host: false, me: 'solo', code: null, active: false, via: null,
      conns: new Map(), seen: new Map(), relayIds: new Map(), toHost: null, hostSeen: 0,
    });
  }

  get online() { return this.active; }
  on(type, fn) { this.handlers.set(type, fn); }
  dispatch(msg) { this.handlers.get(msg.t)?.(msg); }

  // ---------- Anfitrión ----------
  async createRoom() {
    this.code = rid(5);
    const direct = new Promise(resolve => {
      if (!hasPeer()) { resolve(false); return; }
      const peer = new Peer(PREFIX + this.code, { config: ICE, debug: 1 });
      peer.on('open', () => { this.peer = peer; resolve(true); });
      peer.on('connection', conn => this.acceptDirect(conn));
      peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
      peer.on('error', e => { console.warn('PeerJS', e.type); resolve(false); });
      setTimeout(() => resolve(false), 8000);
    });
    const relays = Promise.allSettled(BROKERS.map(connectBroker)).then(rs => {
      for (const r of rs) if (r.status === 'fulfilled') this.listenRelay(r.value);
      return this.brokers.length > 0;
    });
    const [okDirect, okRelay] = await Promise.all([direct, relays]);
    if (!okDirect && !okRelay) { this.reset(); throw new Error('sin conexión a internet o servicios bloqueados'); }
    Object.assign(this, { host: true, me: 'H', active: true });
    this.startHeartbeat();
    return this.code;
  }

  addClient(pid, send, close, meta) {
    this.conns.set(pid, { send, close });
    this.seen.set(pid, Date.now());
    send({ t: 'welcome', you: pid, from: 'H' });
    this.dispatch({ t: 'join', from: pid, ...(meta || {}) });
  }

  // Mensaje de un cliente: el anfitrión fija el remitente para que nadie se haga pasar por otro
  fromClient(pid, msg) {
    if (!msg || typeof msg !== 'object' || !this.conns.has(pid)) return;
    msg.from = pid;
    this.seen.set(pid, Date.now());
    if (msg.t === 'ping' || msg.t === 'hello') return;
    this.dispatch(msg);
    this.relay(msg, pid);
  }

  acceptDirect(conn) {
    const pid = 'P' + rid(6);
    conn.on('open', () => this.addClient(pid, m => { if (conn.open) conn.send(m); }, () => conn.close(), conn.metadata));
    conn.on('data', msg => this.fromClient(pid, msg));
    conn.on('close', () => this.drop(pid));
    conn.on('error', () => this.drop(pid));
  }

  listenRelay(client) {
    this.brokers.push(client);
    const base = TOPIC + this.code;
    client.subscribe(base + '/h');
    client.on('message', (topic, payload) => {
      const env = decode(payload);
      if (!env || typeof env.cid !== 'string' || !env.msg) return;
      let pid = this.relayIds.get(env.cid);
      if (!pid && env.msg.t === 'hello') {
        pid = 'R' + rid(6);
        this.relayIds.set(env.cid, pid);
        const out = base + '/c/' + env.cid;
        this.addClient(pid, m => client.publish(out, JSON.stringify(m)), () => this.relayIds.delete(env.cid), env.msg.meta);
        return;
      }
      if (pid) this.fromClient(pid, env.msg);
    });
  }

  drop(pid) {
    const c = this.conns.get(pid);
    if (!c) return;
    this.conns.delete(pid);
    c.close();
    const m = { t: 'leave', from: pid };
    this.dispatch(m);
    this.relay(m, null);
  }

  relay(msg, except) {
    for (const [pid, c] of this.conns) if (pid !== except) c.send(msg);
  }

  // ---------- Cliente ----------
  async joinRoom(code, meta) {
    this.code = code;
    const forceRelay = new URLSearchParams(location.search).has('relay'); // para pruebas
    try {
      if (forceRelay || !hasPeer()) throw new Error('directa no disponible');
      await this.joinDirect(code, meta);
      this.via = 'directa';
    } catch {
      this.peer?.destroy(); this.peer = null;
      await this.joinRelay(code, meta);
      this.via = 'servidor';
    }
    this.active = true;
    this.startHeartbeat();
  }

  joinDirect(code, meta) {
    return new Promise((resolve, reject) => {
      const peer = new Peer({ config: ICE, debug: 1 });
      this.peer = peer;
      let done = false;
      const fail = () => { if (!done) { done = true; reject(new Error('directa no disponible')); } };
      setTimeout(fail, DIRECT_TIMEOUT);
      peer.on('error', fail);
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json', metadata: meta });
        conn.on('data', msg => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.t === 'welcome' && !done) {
            done = true;
            this.me = msg.you;
            this.toHost = m => { if (conn.open) conn.send(m); };
            resolve();
          }
          if (done) this.fromHost(msg);
        });
        conn.on('close', () => { if (done && this.active) this.hostGone(); });
      });
    });
  }

  async joinRelay(code, meta) {
    const cid = rid(12), base = TOPIC + code;
    const clients = await Promise.allSettled(BROKERS.map(connectBroker));
    const ok = clients.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!ok.length) throw new Error('No se pudo conectar: tu red bloquea tanto la conexión directa como el servidor.');
    // Pedimos entrar por todos los servidores y nos quedamos con el primero que responda
    await new Promise((resolve, reject) => {
      let done = false;
      setTimeout(() => {
        if (done) return;
        ok.forEach(c => c.end(true));
        reject(new Error('Sala no encontrada. Comprueba que el anfitrión sigue con la sala abierta.'));
      }, RELAY_TIMEOUT);
      for (const c of ok) {
        c.subscribe(base + '/c/' + cid);
        c.on('message', (topic, payload) => {
          const msg = decode(payload);
          if (!msg || typeof msg !== 'object') return;
          if (msg.t === 'welcome' && !done) {
            done = true;
            this.me = msg.you;
            this.toHost = m => c.publish(base + '/h', JSON.stringify({ cid, msg: m }));
            this.brokers = [c];
            ok.filter(o => o !== c).forEach(o => o.end(true));
            resolve();
          }
          if (done && this.brokers[0] === c) this.fromHost(msg);
        });
        c.publish(base + '/h', JSON.stringify({ cid, msg: { t: 'hello', meta } }));
      }
    });
  }

  fromHost(msg) {
    this.hostSeen = Date.now();
    if (msg.t !== 'ping') this.dispatch(msg);
  }

  hostGone() {
    if (!this.active) return;
    this.dispatch({ t: 'hostgone' });
    this.close();
  }

  // ---------- Común ----------
  // Latido: cerrar la pestaña no siempre avisa, así que cada lado comprueba que el otro sigue ahí
  startHeartbeat() {
    clearInterval(this.beat);
    this.hostSeen = Date.now();
    this.beat = setInterval(() => {
      const now = Date.now();
      if (this.host) {
        this.relay({ t: 'ping', from: 'H' }, null);
        for (const pid of [...this.conns.keys()]) if (now - (this.seen.get(pid) || now) > 9000) this.drop(pid);
      } else {
        this.toHost?.({ t: 'ping' });
        if (now - this.hostSeen > 9000) this.hostGone();
      }
    }, 2000);
  }

  // Anfitrión: a todos los clientes. Cliente: al anfitrión (que lo reenvía).
  send(msg) {
    if (!this.active) return;
    msg.from = this.me;
    if (this.host) this.relay(msg, null);
    else this.toHost?.(msg);
  }

  close() { this.reset(); }
}
