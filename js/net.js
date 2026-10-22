// Multijugador entre navegadores con PeerJS (WebRTC). El anfitrión reenvía los mensajes de cada cliente al resto.
/* global Peer */
const PREFIX = 'kartamigos-v1-';
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

export class Net {
  constructor() {
    this.handlers = new Map();
    this.reset();
  }

  reset() {
    clearInterval(this.beat);
    this.peer = null; this.host = false; this.me = 'solo'; this.code = null;
    this.conns = new Map(); this.hostConn = null; this.seen = new Map(); this.hostSeen = 0;
  }

  // Latido: cerrar la pestaña no siempre avisa por WebRTC, así que cada lado comprueba que el otro sigue ahí
  startHeartbeat() {
    clearInterval(this.beat);
    this.beat = setInterval(() => {
      const now = Date.now();
      if (this.host) {
        this.relay({ t: 'ping', from: 'H' }, null);
        for (const [pid, conn] of this.conns) if (now - (this.seen.get(pid) || now) > 8000) { conn.close(); this.drop(pid); }
      } else if (this.hostConn) {
        if (this.hostConn.open) this.hostConn.send({ t: 'ping' });
        if (this.hostSeen && now - this.hostSeen > 8000) { this.dispatch({ t: 'hostgone' }); this.close(); }
      }
    }, 2000);
  }

  drop(pid) {
    if (!this.conns.delete(pid)) return;
    const m = { t: 'leave', from: pid };
    this.dispatch(m);
    this.relay(m, null);
  }

  get online() { return !!this.peer; }
  on(type, fn) { this.handlers.set(type, fn); }
  dispatch(msg) { this.handlers.get(msg.t)?.(msg); }

  createRoom(meta) {
    return new Promise((resolve, reject) => {
      const attempt = n => {
        const code = Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
        const peer = new Peer(PREFIX + code, { config: ICE, debug: 1 });
        let opened = false;
        peer.on('open', () => {
          opened = true;
          Object.assign(this, { peer, host: true, me: 'H', code });
          this.startHeartbeat();
          resolve(code);
        });
        peer.on('connection', conn => this.accept(conn));
        peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
        peer.on('error', e => {
          if (!opened && e.type === 'unavailable-id' && n < 5) { peer.destroy(); attempt(n + 1); }
          else if (!opened) { peer.destroy(); reject(e); }
          else console.warn('PeerJS', e.type, e);
        });
      };
      attempt(0);
    });
  }

  accept(conn) {
    const pid = 'P' + Math.random().toString(36).slice(2, 8);
    const gone = () => this.drop(pid);
    conn.on('open', () => {
      this.conns.set(pid, conn);
      this.seen.set(pid, Date.now());
      conn.send({ t: 'welcome', you: pid, from: 'H' });
      this.dispatch({ t: 'join', from: pid, ...(conn.metadata || {}) });
    });
    conn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      msg.from = pid; // el anfitrión fija el remitente: un cliente no puede hacerse pasar por otro
      this.seen.set(pid, Date.now());
      if (msg.t === 'ping') return;
      this.dispatch(msg);
      this.relay(msg, pid);
    });
    conn.on('close', gone);
    conn.on('error', gone);
  }

  relay(msg, except) {
    for (const [pid, c] of this.conns) if (pid !== except && c.open) c.send(msg);
  }

  joinRoom(code, meta) {
    return new Promise((resolve, reject) => {
      const peer = new Peer({ config: ICE, debug: 1 });
      let done = false;
      const fail = err => { if (done) return; done = true; peer.destroy(); this.reset(); reject(err); };
      const timer = setTimeout(() => fail(new Error('No se pudo conectar (tiempo agotado). Puede que vuestras redes bloqueen la conexión directa.')), 15000);
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json', metadata: meta });
        Object.assign(this, { peer, host: false, hostConn: conn, code });
        conn.on('data', msg => {
          if (!msg || typeof msg !== 'object') return;
          this.hostSeen = Date.now();
          if (msg.t === 'ping') return;
          if (msg.t === 'welcome' && !done) { done = true; clearTimeout(timer); this.me = msg.you; this.startHeartbeat(); resolve(); }
          this.dispatch(msg);
        });
        conn.on('close', () => { if (done && this.peer) { this.dispatch({ t: 'hostgone' }); this.close(); } });
      });
      peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
      peer.on('error', e => {
        clearTimeout(timer);
        if (e.type === 'peer-unavailable') fail(new Error('Sala no encontrada. Comprueba el enlace o pide uno nuevo.'));
        else if (!done) fail(new Error('Error de conexión: ' + e.type));
        else console.warn('PeerJS', e.type, e);
      });
    });
  }

  // Anfitrión: a todos los clientes. Cliente: al anfitrión (que lo reenvía).
  send(msg) {
    if (!this.peer) return;
    msg.from = this.me;
    if (this.host) this.relay(msg, null);
    else if (this.hostConn?.open) this.hostConn.send(msg);
  }

  close() {
    this.peer?.destroy();
    this.reset();
  }
}
