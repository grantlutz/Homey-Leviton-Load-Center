'use strict';

const {
  API_BASE_URL, USER_AGENT, HTTP,
} = require('./constants');

/**
 * Errors carry a `code` so callers can branch on 2FA / auth conditions.
 */
class LevitonError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LevitonError';
    this.code = code;
  }
}
const ERR = {
  TWO_FACTOR: 'two_factor_required',
  INVALID_CODE: 'invalid_code',
  TOKEN_EXPIRED: 'token_expired',
  AUTH: 'auth_error',
  CONNECTION: 'connection_error',
};

/**
 * Thin REST client for the My Leviton cloud. Stateless w.r.t. Homey; owns only the
 * auth token + user object. One instance is shared app-wide.
 */
class LevitonClient {
  constructor({ log = () => {}, error = () => {} } = {}) {
    this.log = log;
    this.error = error;
    this._token = null;
    this._userId = null;
    this._user = null;
  }

  get token() { return this._token; }
  get userId() { return this._userId; }
  get user() { return this._user; }
  get isAuthenticated() { return !!this._token; }

  /** Restore a previously stored session without hitting the network. */
  restoreSession({ token, userId, user }) {
    this._token = token;
    this._userId = userId;
    this._user = user || {};
  }

  /** The exact token envelope the WebSocket auth frame needs. */
  getAuthToken(ttl, created) {
    return {
      id: this._token,
      ttl: ttl ?? (this._user && this._user.ttl) ?? null,
      scopes: null,
      created: created ?? (this._user && this._user.created) ?? null,
      userId: this._userId,
      user: this._user || {},
      rememberMe: false,
    };
  }

  _headers(authenticated) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
    };
    if (authenticated && this._token) headers.authorization = this._token;
    return headers;
  }

  async _request(method, path, {
    params, json, authenticated = true, expectJson = true, extraHeaders,
  } = {}) {
    const url = new URL(API_BASE_URL + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const headers = { ...this._headers(authenticated), ...(extraHeaders || {}) };

    let res;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: json !== undefined ? JSON.stringify(json) : undefined,
        redirect: 'follow',
      });
    } catch (err) {
      throw new LevitonError(`Network error: ${err.message}`, ERR.CONNECTION);
    }

    if (res.ok) {
      if (!expectJson) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    // Error path — map status codes to typed errors.
    let body = null;
    try { body = await res.json(); } catch (e) { /* non-JSON error body */ }
    const apiMessage = body && body.error && body.error.message;

    switch (res.status) {
      case HTTP.TWO_FACTOR_REQUIRED:
        throw new LevitonError('Two-factor authentication required', ERR.TWO_FACTOR);
      case HTTP.INVALID_CODE:
        throw new LevitonError('Invalid two-factor code', ERR.INVALID_CODE);
      case HTTP.UNAUTHORIZED:
        throw new LevitonError(
          apiMessage || 'Unauthorized',
          authenticated ? ERR.TOKEN_EXPIRED : ERR.AUTH,
        );
      default:
        if (res.status >= 500) throw new LevitonError(`Server error ${res.status}`, ERR.CONNECTION);
        throw new LevitonError(apiMessage || `API error ${res.status}`, ERR.AUTH);
    }
  }

  // ---- Auth -------------------------------------------------------------

  async login(email, password, code) {
    const body = { email, password };
    if (code != null && code !== '') body.code = code;
    const data = await this._request('POST', '/Person/login', {
      params: { include: 'user' },
      json: body,
      authenticated: false,
    });
    this._token = data.id;
    this._userId = data.userId;
    this._user = data.user || { id: data.userId, ttl: data.ttl, created: data.created };
    // Keep ttl/created for the WS auth envelope.
    if (data.ttl != null) this._user.ttl = data.ttl;
    if (data.created != null) this._user.created = data.created;
    return { token: this._token, userId: this._userId, user: this._user };
  }

  async logout() {
    if (!this._token) return;
    try {
      await this._request('POST', '/Person/logout', {
        params: { access_token: this._token },
        json: {},
        expectJson: false,
      });
    } catch (e) { /* best-effort */ }
    this._token = null;
    this._userId = null;
    this._user = null;
  }

  // ---- Discovery --------------------------------------------------------

  getPermissions() {
    return this._request('GET', `/Person/${this._userId}/residentialPermissions`);
  }

  async getResidences() {
    const permissions = await this.getPermissions();
    const residences = new Map();
    for (const perm of permissions || []) {
      try {
        if (perm.residentialAccountId) {
          const list = await this._request('GET', `/ResidentialAccounts/${perm.residentialAccountId}/residences`);
          for (const r of list || []) residences.set(String(r.id), r);
        } else if (perm.residenceId) {
          const r = await this._request('GET', `/ResidentialPermissions/${perm.id}/residence`);
          if (r) residences.set(String(r.id), r);
        }
      } catch (err) {
        this.error(`Failed to resolve permission ${perm.id}: ${err.message}`);
      }
    }
    return [...residences.values()];
  }

  getWhems(residenceId) {
    return this._request('GET', `/Residences/${residenceId}/iotWhems`);
  }

  getPanels(residenceId) {
    // Reference client sends the include as a bare header; also pass the LoopBack
    // filter param in case the header form is ignored. Discovery falls back to
    // getPanelBreakers() if breakers aren't inlined either way.
    return this._request('GET', `/Residences/${residenceId}/residentialBreakerPanels`, {
      params: { filter: '{"include":"residentialBreakers"}' },
      extraHeaders: { include: 'residentialBreakers' },
    });
  }

  getWhemBreakers(whemId) {
    return this._request('GET', `/IotWhems/${whemId}/residentialBreakers`);
  }

  getWhemCts(whemId) {
    return this._request('GET', `/IotWhems/${whemId}/iotCts`);
  }

  getPanelBreakers(panelId) {
    return this._request('GET', `/ResidentialBreakerPanels/${panelId}/residentialBreakers`);
  }

  getBreaker(breakerId) {
    return this._request('GET', `/ResidentialBreakers/${breakerId}`);
  }

  /**
   * Full discovery walk: residences -> hubs (whems/panels) -> breakers + cts.
   * Returns a flat, normalized tree used by both pairing and polling.
   */
  async discoverTree() {
    const residences = await this.getResidences();
    const tree = {
      residences: [], whems: [], panels: [], breakers: [], cts: [],
    };
    for (const residence of residences) {
      tree.residences.push(residence);
      const rid = residence.id;

      const whems = (await this.getWhems(rid).catch(() => [])) || [];
      for (const whem of whems) {
        whem.residenceId = whem.residenceId || rid;
        tree.whems.push(whem);
        const breakers = (await this.getWhemBreakers(whem.id).catch(() => [])) || [];
        for (const b of breakers) {
          b.hubId = String(whem.id); b.hubType = 'whem'; b.residenceId = rid;
          tree.breakers.push(b);
        }
        const cts = (await this.getWhemCts(whem.id).catch(() => [])) || [];
        for (const c of cts) {
          c.hubId = String(whem.id); c.residenceId = rid;
          tree.cts.push(c);
        }
      }

      const panels = (await this.getPanels(rid).catch(() => [])) || [];
      for (const panel of panels) {
        panel.residenceId = panel.residenceId || rid;
        tree.panels.push(panel);
        // Panels may already inline breakers via the include header; fall back to a fetch.
        let breakers = Array.isArray(panel.residentialBreakers) ? panel.residentialBreakers : null;
        if (!breakers) breakers = (await this.getPanelBreakers(panel.id).catch(() => [])) || [];
        for (const b of breakers) {
          b.hubId = String(panel.id); b.hubType = 'panel'; b.residenceId = rid;
          tree.breakers.push(b);
        }
      }
    }
    return tree;
  }

  // ---- Control ----------------------------------------------------------

  _patchBreaker(breakerId, json) {
    return this._request('PATCH', `/ResidentialBreakers/${breakerId}`, { json, expectJson: false });
  }

  breakerOn(breakerId) { return this._patchBreaker(breakerId, { remoteOn: true }); }

  breakerOff(breakerId) { return this._patchBreaker(breakerId, { remoteTrip: true }); }

  breakerTrip(breakerId) { return this._patchBreaker(breakerId, { remoteTrip: true }); }

  breakerBlink(breakerId, on = true) { return this._patchBreaker(breakerId, { blinkLED: !!on }); }

  setWhemIdentify(whemId) {
    return this._request('PUT', `/IotWhems/${whemId}`, { json: { identify: 10 }, expectJson: false });
  }

  setWhemBandwidth(whemId, bandwidth) {
    return this._request('PUT', `/IotWhems/${whemId}`, { json: { bandwidth }, expectJson: false });
  }

  setPanelBandwidth(panelId, enabled) {
    return this._request('PUT', `/ResidentialBreakerPanels/${panelId}`, {
      json: { bandwidth: enabled ? 1 : 0 }, expectJson: false,
    });
  }
}

LevitonClient.LevitonError = LevitonError;
LevitonClient.ERR = ERR;
module.exports = LevitonClient;
