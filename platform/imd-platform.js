/**
 * IMD Platform Core Library v1.2
 * Shared auth, subscription, and data layer for all platform pages.
 * Backend: JSONBin.io  |  Session: localStorage
 *
 * CHANGELOG v1.2:
 *   + TRIAL system: 7-day auto-trial on register (General app only)
 *   + Sub.isTrialActive(), Sub.trialDaysLeft(), Sub.allowedApps()
 *   + Guard.check() handles TRIAL status + per-app access checks
 *   + U.fmtDateShort(), U.daysFromNow(), U.escHtml() added
 *   + Auth.register() auto-creates TRIAL subscription
 *   + _normalize() initializes _v if missing
 *
 * CHANGELOG v1.1:
 *   #1 CRITICAL - JSONBin PUT double-wrapped → data.users === undefined
 *   #2 CRITICAL - Config.load() path wrong for all subpages
 *   #3 MEDIUM   - No data normalization (arrays could be undefined)
 *   #4 MEDIUM   - Store.update() no error handling, sync-only
 *   #5 MEDIUM   - Team.invite() threw inside Store.update() callback
 *   #6 LOW      - Sub.submitPayment() skipped missing sub row
 *   #7 LOW      - _normalize() unwraps legacy double-wrapped bins
 */

const IMD = (() => {

  // ── CONSTANTS ──────────────────────────────────────────────
  const SESSION_KEY  = 'imd_session';
  const BIN_KEY      = 'imd_bin_id';
  const APIKEY_KEY   = 'imd_api_key';
  const CACHE_KEY    = 'imd_data_cache';
  const CACHE_TTL    = 30000;
  const JSONBIN_BASE = 'https://api.jsonbin.io/v3/b';
  const TRIAL_DAYS   = 7;
  const TRIAL_APPS   = ['general'];

  let _config = null;

  // ── UTILS ───────────────────────────────────────────────────
  const U = {
    uid: (prefix = 'id') =>
      `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    now: () => new Date().toISOString(),
    fmtCurrency: (n) => 'Rp ' + (n || 0).toLocaleString('id-ID'),
    fmtDate: (iso) => {
      if (!iso) return '-';
      return new Date(iso).toLocaleDateString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    },
    fmtDateShort: (iso) => {
      if (!iso) return '-';
      return new Date(iso).toLocaleDateString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
    },
    daysFromNow: (iso) => {
      if (!iso) return null;
      return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
    },
    timeAgo: (iso) => {
      if (!iso) return '-';
      const d = (Date.now() - new Date(iso).getTime()) / 1000;
      if (d < 60)    return 'baru saja';
      if (d < 3600)  return Math.floor(d / 60) + ' menit lalu';
      if (d < 86400) return Math.floor(d / 3600) + ' jam lalu';
      return Math.floor(d / 86400) + ' hari lalu';
    },
    async sha256(str) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    },
    getParam: (key) => new URLSearchParams(window.location.search).get(key),
    redirect: (url) => { window.location.href = url; },
    escHtml: (str) => {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
    }
  };

  // ── DATA NORMALIZER ─────────────────────────────────────────
  function _normalize(raw) {
    if (!raw || typeof raw !== 'object') raw = {};
    if (raw.record && typeof raw.record === 'object' && !Array.isArray(raw.record)) {
      const r = raw.record;
      const rootOk   = raw._v || Array.isArray(raw.users) || raw.admin;
      const nestedOk = r._v   || Array.isArray(r.users)  || r.admin;
      if (!rootOk && nestedOk) raw = r;
    }
    if (!Array.isArray(raw.users))            raw.users            = [];
    if (!Array.isArray(raw.companies))        raw.companies        = [];
    if (!Array.isArray(raw.subscriptions))    raw.subscriptions    = [];
    if (!Array.isArray(raw.payment_requests)) raw.payment_requests = [];
    if (!Array.isArray(raw.team_members))     raw.team_members     = [];
    if (!raw.admin || typeof raw.admin !== 'object') raw.admin     = {};
    if (!raw._v) raw._v = 1;
    return raw;
  }

  // ── CONFIG ──────────────────────────────────────────────────
  const Config = {
    async load() {
      if (_config) return _config;
      try {
        const depth = (window.location.pathname.match(/\//g) || []).length - 1;
        const prefix = depth === 0 ? '' : '../'.repeat(depth);
        const res = await fetch(prefix + 'data/config.json');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        _config = await res.json();
      } catch (e) {
        console.warn('Config load failed:', e.message, '— using defaults');
        _config = { platform: { subscription_plans: [] }, payment: {}, contact: {} };
      }
      return _config;
    },
    get() { return _config; }
  };

  // ── JSONBIN STORE ───────────────────────────────────────────
  const Store = {
    getBinId()     { return localStorage.getItem(BIN_KEY); },
    getApiKey()    { return localStorage.getItem(APIKEY_KEY); },
    isConfigured() { return !!(this.getBinId() && this.getApiKey()); },
    setCredentials(binId, apiKey) {
      localStorage.setItem(BIN_KEY, binId);
      localStorage.setItem(APIKEY_KEY, apiKey);
    },
    clearCache() { try { sessionStorage.removeItem(CACHE_KEY); } catch (e) {} },

    async _fetch(method, body = null) {
      const binId  = this.getBinId();
      const apiKey = this.getApiKey();
      if (!binId || !apiKey) throw new Error('Platform not configured. Hubungi admin.');
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': apiKey, 'X-Bin-Versioning': 'false' }
      };
      if (body !== null) opts.body = JSON.stringify(body);
      const res = await fetch(`${JSONBIN_BASE}/${binId}`, opts);
      if (!res.ok) {
        const t = await res.text().catch(() => String(res.status));
        throw new Error(`Store error ${res.status}: ${t}`);
      }
      const json = await res.json();
      return json.record !== undefined ? json.record : json;
    },

    async get(force = false) {
      if (!force) {
        try {
          const cached = sessionStorage.getItem(CACHE_KEY);
          if (cached) {
            const { data, ts } = JSON.parse(cached);
            if (Date.now() - ts < CACHE_TTL) return _normalize(data);
          }
        } catch (e) {}
      }
      const raw  = await this._fetch('GET');
      const data = _normalize(raw);
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); } catch (e) {}
      return data;
    },

    async put(data) {
      const normalized = _normalize(data);
      const result     = await this._fetch('PUT', normalized);
      const clean      = _normalize(result);
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data: clean, ts: Date.now() })); } catch (e) {}
      return clean;
    },

    async update(fn) {
      const data = await this.get(true);
      let updated;
      try { updated = await Promise.resolve(fn(data)); }
      catch (e) { this.clearCache(); throw e; }
      return await this.put(updated || data);
    },

    async initialize(adminEmail, adminPwHash) {
      const empty = {
        _v: 1, _initialized: true,
        admin: { email: adminEmail, password_hash: adminPwHash, name: 'Admin' },
        users: [], companies: [], subscriptions: [], payment_requests: [], team_members: []
      };
      return await this.put(empty);
    },

    async createBin(apiKey, name = 'IMD Platform Data') {
      const res = await fetch('https://api.jsonbin.io/v3/b', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': apiKey,
                   'X-Bin-Name': name, 'X-Bin-Private': 'true' },
        body: JSON.stringify({ _v: 1, _initialized: false })
      });
      if (!res.ok) throw new Error('Gagal membuat bin: ' + await res.text());
      return (await res.json()).metadata.id;
    }
  };

  // ── AUTH ────────────────────────────────────────────────────
  const Auth = {
    getSession() {
      try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
      catch { return null; }
    },
    isLoggedIn() {
      const s = this.getSession();
      if (!s) return false;
      if (s.expires && Date.now() > s.expires) { this.logout(); return false; }
      return true;
    },
    saveSession(data) {
      localStorage.setItem(SESSION_KEY,
        JSON.stringify({ ...data, login_time: U.now(), expires: Date.now() + 8 * 3600 * 1000 }));
    },
    logout() { localStorage.removeItem(SESSION_KEY); Store.clearCache(); },

    async register(email, password, companyName) {
      if (!email || !password || !companyName) throw new Error('Semua field wajib diisi.');
      email = email.toLowerCase().trim();
      if (!/\S+@\S+\.\S+/.test(email)) throw new Error('Format email tidak valid.');
      if (password.length < 8) throw new Error('Password minimal 8 karakter.');

      const data = await Store.get(true);
      if (data.users.find(u => u.email === email))
        throw new Error('Email sudah terdaftar. Silakan login.');

      const pwHash    = await U.sha256(password + email);
      const companyId = U.uid('cmp');
      const userId    = U.uid('usr');
      const trialEnd  = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();

      data.users.push({
        id: userId, email, password_hash: pwHash,
        name: companyName, company_id: companyId,
        role: 'owner', created_at: U.now()
      });
      data.companies.push({
        id: companyId, name: companyName,
        owner_email: email, industry: '', created_at: U.now()
      });
      // v1.2: Auto-start 7-day TRIAL subscription
      data.subscriptions.push({
        id: U.uid('sub'), company_id: companyId,
        plan: 'trial', status: 'TRIAL',
        trial_started_at: U.now(), trial_ends_at: trialEnd,
        activated_at: null, expires_at: null
      });
      await Store.put(data);

      this.saveSession({ user_id: userId, email, name: companyName, company_id: companyId, role: 'owner' });
      return { userId, companyId, trial_ends_at: trialEnd };
    },

    async login(email, password) {
      if (!email || !password) throw new Error('Email dan password wajib diisi.');
      email = email.toLowerCase().trim();
      const data = await Store.get(true);
      const user = data.users.find(u => u.email === email);
      if (!user) throw new Error('Email tidak ditemukan.');
      const pwHash = await U.sha256(password + email);
      if (user.password_hash !== pwHash) throw new Error('Password salah.');
      this.saveSession({
        user_id: user.id, email: user.email, name: user.name,
        company_id: user.company_id, role: user.role
      });
      return user;
    },

    async loginAdmin(email, password) {
      if (!email || !password) throw new Error('Email dan password wajib diisi.');
      email = email.toLowerCase().trim();
      const data  = await Store.get(true);
      const admin = data.admin;
      if (!admin || !admin.email) throw new Error('Admin belum dikonfigurasi. Lakukan setup terlebih dahulu.');
      if (admin.email !== email)  throw new Error('Email admin tidak ditemukan.');
      const pwHash = await U.sha256(password + email);
      if (admin.password_hash !== pwHash) throw new Error('Password admin salah.');
      this.saveSession({ user_id: 'admin', email: admin.email, name: admin.name || 'Admin', company_id: null, role: 'admin' });
      return admin;
    }
  };

  // ── SUBSCRIPTION ────────────────────────────────────────────
  const Sub = {
    async getByCompany(companyId, force = false) {
      if (!companyId) return { status: 'NONE' };
      const data = await Store.get(force);
      return data.subscriptions.find(s => s.company_id === companyId) || { status: 'NONE' };
    },

    async isActive(companyId) {
      const sub = await this.getByCompany(companyId, true);
      return sub.status === 'ACTIVE';
    },

    isTrialActive(sub) {
      if (!sub || sub.status !== 'TRIAL' || !sub.trial_ends_at) return false;
      return new Date(sub.trial_ends_at).getTime() > Date.now();
    },

    trialDaysLeft(sub) {
      if (!sub || !sub.trial_ends_at) return 0;
      return Math.max(0, Math.ceil((new Date(sub.trial_ends_at).getTime() - Date.now()) / 86400000));
    },

    allowedApps(sub) {
      if (!sub) return [];
      if (sub.status === 'TRIAL' && this.isTrialActive(sub)) return [...TRIAL_APPS];
      if (sub.status !== 'ACTIVE') return [];
      const plan = Config.get()?.platform?.subscription_plans?.find(p => p.id === sub.plan);
      return plan?.apps || [];
    },

    async submitPayment(companyId, userEmail, companyName, planId, proofUrl, transferNote) {
      const plan = Config.get()?.platform?.subscription_plans?.find(p => p.id === planId);
      if (!plan) throw new Error('Plan tidak valid: ' + planId);
      await Store.update(data => {
        const subIdx = data.subscriptions.findIndex(s => s.company_id === companyId);
        if (subIdx >= 0) {
          data.subscriptions[subIdx].plan       = planId;
          data.subscriptions[subIdx].status     = 'PENDING';
          data.subscriptions[subIdx].pending_at = U.now();
        } else {
          data.subscriptions.push({
            id: U.uid('sub'), company_id: companyId, plan: planId,
            status: 'PENDING', pending_at: U.now(), activated_at: null, expires_at: null
          });
        }
        data.payment_requests.push({
          id: U.uid('pay'), company_id: companyId,
          user_email: userEmail, company_name: companyName,
          plan: planId, plan_name: plan.name, amount: plan.price,
          proof_url: proofUrl, transfer_note: transferNote,
          status: 'PENDING', submitted_at: U.now()
        });
        return data;
      });
    },

    async activate(companyId, planId, verifiedBy) {
      await Store.update(data => {
        let sub = data.subscriptions.find(s => s.company_id === companyId);
        if (!sub) { sub = { id: U.uid('sub'), company_id: companyId }; data.subscriptions.push(sub); }
        sub.plan = planId; sub.status = 'ACTIVE';
        sub.activated_at = U.now(); sub.activated_by = verifiedBy;
        const req = data.payment_requests
          .filter(r => r.company_id === companyId && r.status === 'PENDING')
          .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))[0];
        if (req) { req.status = 'APPROVED'; req.verified_at = U.now(); req.verified_by = verifiedBy; }
        return data;
      });
    },

    async deactivate(companyId) {
      await Store.update(data => {
        const sub = data.subscriptions.find(s => s.company_id === companyId);
        if (sub) { sub.status = 'EXPIRED'; sub.deactivated_at = U.now(); }
        return data;
      });
    }
  };

  // ── TEAM ────────────────────────────────────────────────────
  const Team = {
    ROLES: ['owner', 'accounting', 'inventory', 'viewer'],

    async getMembers(companyId) {
      const data      = await Store.get();
      const memberIds = data.team_members.filter(m => m.company_id === companyId).map(m => m.user_id);
      return data.users.filter(u => memberIds.includes(u.id) || u.company_id === companyId);
    },

    async invite(companyId, email, role, invitedByUserId) {
      email = email.toLowerCase().trim();
      const data = await Store.get(true);
      const user = data.users.find(u => u.email === email);
      if (!user) throw new Error('User tidak ditemukan. Mereka harus register terlebih dahulu.');
      const exists = data.team_members.find(m => m.company_id === companyId && m.user_id === user.id);
      if (exists) throw new Error('User sudah menjadi anggota tim ini.');
      await Store.update(d => {
        d.team_members.push({
          id: U.uid('mem'), company_id: companyId, user_id: user.id,
          role, invited_by: invitedByUserId, joined_at: U.now()
        });
        return d;
      });
    },

    async remove(companyId, userId) {
      await Store.update(data => {
        data.team_members = data.team_members.filter(
          m => !(m.company_id === companyId && m.user_id === userId)
        );
        return data;
      });
    }
  };

  // ── ACCESS GUARD ────────────────────────────────────────────
  const Guard = {
    async check(requireActive = true, appKey = null) {
      if (!Auth.isLoggedIn())    return { ok: false, reason: 'not_logged_in' };
      if (!Store.isConfigured()) return { ok: false, reason: 'not_configured' };
      if (!requireActive)        return { ok: true };

      const session = Auth.getSession();
      if (!session?.company_id)  return { ok: false, reason: 'no_company' };

      const sub  = await Sub.getByCompany(session.company_id, true);
      const apps = Sub.allowedApps(sub);

      if (sub.status === 'TRIAL') {
        if (!Sub.isTrialActive(sub)) return { ok: false, reason: 'trial_expired', sub };
        if (appKey && !apps.includes(appKey))
          return { ok: false, reason: 'plan_mismatch', sub, allowedApps: apps };
        return { ok: true, sub, allowedApps: apps, isTrial: true, trialDaysLeft: Sub.trialDaysLeft(sub) };
      }
      if (sub.status === 'ACTIVE') {
        if (appKey && !apps.includes(appKey))
          return { ok: false, reason: 'plan_mismatch', sub, allowedApps: apps };
        return { ok: true, sub, allowedApps: apps };
      }
      if (sub.status === 'PENDING') return { ok: false, reason: 'pending',         sub };
      if (sub.status === 'EXPIRED') return { ok: false, reason: 'expired',         sub };
      return                               { ok: false, reason: 'no_subscription', sub };
    },

    async enforceLogin(loginUrl = '../auth/login.html') {
      if (!Auth.isLoggedIn()) {
        U.redirect(`${loginUrl}?redirect=${encodeURIComponent(window.location.href)}`);
        return false;
      }
      return true;
    },

    async enforceSubscription(subscribeUrl = '../subscribe/index.html') {
      if (!await this.enforceLogin()) return false;
      const res = await this.check(true);
      if (!res.ok) {
        U.redirect(res.reason === 'pending' ? subscribeUrl + '?status=pending' : subscribeUrl);
        return false;
      }
      return true;
    }
  };

  return { U, Config, Store, Auth, Sub, Team, Guard, TRIAL_DAYS, TRIAL_APPS,
           init: async () => { await Config.load(); } };

})();

if (typeof window !== 'undefined') window.IMD = IMD;
