'use strict';

const WebSocket = require('ws');
const {
  WEBSOCKET_URL, USER_AGENT, TIMINGS, RECONNECT_BACKOFF,
} = require('./constants');

/**
 * WebSocket push client for socket.cloud.leviton.com.
 *
 * Ported behaviour:
 *  - Auth is the FIRST text frame ({ token: {...} }), not a header/query param.
 *  - Waits for a { type:"status", status:"ready" } handshake before subscribing.
 *  - Subscriptions are { type:"subscribe", subscription:{ modelName, modelId } }.
 *  - Inbound { type:"notification", notification:{ modelName, modelId, data } } is routed out.
 *  - Proactive reconnect at 55 min (server hard-kills the socket at ~60 min).
 *  - Silence watchdog: reconnect if no data for 90 s.
 *  - Exponential reconnect backoff [10,30,60,120,300]s.
 */
class LevitonSocket {
  constructor({
    client, log = () => {}, error = () => {}, onNotification = () => {}, onStateChange = () => {},
  }) {
    this.client = client;
    this.log = log;
    this.error = error;
    this.onNotification = onNotification;
    this.onStateChange = onStateChange; // (connected: boolean)

    this._ws = null;
    this._ready = false;
    this._closing = false;
    this._connectionId = null;
    this._subscriptions = new Map(); // key `${modelName}:${modelId}` -> { modelName, modelId }
    this._lastMessageAt = 0;
    this._reconnectAttempts = 0;
    this._timers = { proactive: null, watchdog: null, reconnect: null };
    this._readyResolvers = [];
  }

  get connected() { return this._ready && this._ws && this._ws.readyState === WebSocket.OPEN; }

  /** Optional async hook run before each reconnect (e.g. validate token). */
  set onBeforeReconnect(fn) { this._onBeforeReconnect = fn; }

  async connect() {
    this._closing = false;
    await this._open();
  }

  _open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };

      let ws;
      try {
        ws = new WebSocket(WEBSOCKET_URL, {
          headers: { 'user-agent': USER_AGENT },
          handshakeTimeout: TIMINGS.READY_TIMEOUT,
        });
      } catch (err) {
        done(err);
        return;
      }
      this._ws = ws;
      this._ready = false;

      const readyTimer = setTimeout(() => {
        if (!this._ready) {
          this.error('WebSocket ready handshake timed out');
          try { ws.terminate(); } catch (e) { /* noop */ }
        }
      }, TIMINGS.READY_TIMEOUT);

      ws.on('open', () => {
        // Auth is the first frame.
        this._send({ token: this.client.getAuthToken() });
      });

      ws.on('message', (raw) => {
        this._lastMessageAt = Date.now();
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

        if (msg.type === 'status' && msg.status === 'ready') {
          clearTimeout(readyTimer);
          this._ready = true;
          this._connectionId = msg.connectionId || null;
          this._reconnectAttempts = 0;
          this.log(`WebSocket ready (connection ${this._connectionId})`);
          this._resubscribeAll();
          this._startKeepalive();
          this.onStateChange(true);
          this._flushReady();
          done();
        } else if (msg.type === 'notification' && msg.notification) {
          const n = msg.notification;
          if (n.data && n.modelId != null) {
            try {
              this.onNotification(n.modelName, String(n.modelId), n.data);
            } catch (err) {
              this.error(`notification handler error: ${err.message}`);
            }
          }
        }
      });

      // Protocol-level liveness: pongs (and any server pings) count as activity so the
      // 90s silence watchdog doesn't false-trip on a quiet-but-healthy connection.
      ws.on('pong', () => { this._lastMessageAt = Date.now(); });
      ws.on('ping', () => { this._lastMessageAt = Date.now(); });

      ws.on('error', (err) => {
        this.error(`WebSocket error: ${err.message}`);
        done(err);
      });

      ws.on('close', () => {
        clearTimeout(readyTimer);
        const wasReady = this._ready;
        this._ready = false;
        this._stopKeepalive();
        if (wasReady) this.onStateChange(false);
        if (!settled) done(new Error('WebSocket closed before ready'));
        if (!this._closing) this._scheduleReconnect();
      });
    });
  }

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  subscribe(modelName, modelId) {
    const key = `${modelName}:${modelId}`;
    this._subscriptions.set(key, { modelName, modelId: String(modelId) });
    if (this.connected) {
      this._send({ type: 'subscribe', subscription: { modelName, modelId: String(modelId) } });
    }
  }

  unsubscribe(modelName, modelId) {
    const key = `${modelName}:${modelId}`;
    this._subscriptions.delete(key);
    if (this.connected) {
      this._send({ type: 'unsubscribe', subscription: { modelName, modelId: String(modelId) } });
    }
  }

  _resubscribeAll() {
    for (const { modelName, modelId } of this._subscriptions.values()) {
      this._send({ type: 'subscribe', subscription: { modelName, modelId } });
    }
  }

  // ---- Keepalive --------------------------------------------------------

  _startKeepalive() {
    this._stopKeepalive();
    this._lastMessageAt = Date.now();
    this._timers.proactive = setTimeout(() => {
      this.log('Proactive WebSocket reconnect (55 min)');
      this._forceReconnect();
    }, TIMINGS.WS_PROACTIVE_RECONNECT);

    this._timers.watchdog = setInterval(() => {
      if (Date.now() - this._lastMessageAt >= TIMINGS.WS_SILENCE_LIMIT) {
        this.log('WebSocket silent > 90s — forcing reconnect');
        this._forceReconnect();
      }
    }, TIMINGS.WS_WATCHDOG_TICK);

    this._timers.heartbeat = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        try { this._ws.ping(); } catch (e) { /* close handler will reconnect */ }
      }
    }, TIMINGS.WS_HEARTBEAT);
  }

  _stopKeepalive() {
    if (this._timers.proactive) { clearTimeout(this._timers.proactive); this._timers.proactive = null; }
    if (this._timers.watchdog) { clearInterval(this._timers.watchdog); this._timers.watchdog = null; }
    if (this._timers.heartbeat) { clearInterval(this._timers.heartbeat); this._timers.heartbeat = null; }
  }

  _forceReconnect() {
    if (this._closing) return;
    try {
      if (this._ws) this._ws.terminate();
    } catch (e) { /* the close handler schedules the reconnect */ }
  }

  _scheduleReconnect() {
    if (this._closing || this._timers.reconnect) return;
    const idx = Math.min(this._reconnectAttempts, RECONNECT_BACKOFF.length - 1);
    const delay = RECONNECT_BACKOFF[idx];
    this._reconnectAttempts += 1;
    this.log(`Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts})`);
    this._timers.reconnect = setTimeout(async () => {
      this._timers.reconnect = null;
      if (this._closing) return;
      if (this._onBeforeReconnect) {
        try { await this._onBeforeReconnect(); } catch (err) {
          this.error(`pre-reconnect check failed: ${err.message}`);
          this._scheduleReconnect();
          return;
        }
      }
      this._open().catch((err) => this.error(`reconnect failed: ${err.message}`));
    }, delay);
  }

  _flushReady() {
    const resolvers = this._readyResolvers;
    this._readyResolvers = [];
    for (const r of resolvers) r();
  }

  async close() {
    this._closing = true;
    this._stopKeepalive();
    if (this._timers.reconnect) { clearTimeout(this._timers.reconnect); this._timers.reconnect = null; }
    if (this._ws) {
      try { this._ws.close(); } catch (e) { /* noop */ }
      this._ws = null;
    }
    this._ready = false;
  }
}

module.exports = LevitonSocket;
