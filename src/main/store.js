'use strict';

// Tiny JSON settings store. API keys are encrypted with the OS keychain
// (Electron safeStorage / Windows DPAPI) whenever that is available.

const fs = require('fs');
const path = require('path');
const { SEARCH_ENGINES } = require('./offline');

const DEFAULT_SETTINGS = {
  model: 'openai/gpt-oss-20b',
  searchEngine: 'google',
  voice: false,
  boil: true,
  autoSearch: true,
  bargeIn: true,
  micSensitivity: 'normal',
  recentApps: [],
  checkUpdates: true,
  lastAnnouncedUpdate: '',
  dismissedUpdate: '',
  firstRun: true,
  position: null,
  pet: null,
};

// Secrets Nibo can keep, and the environment variable each one falls back to.
const SECRETS = {
  groq: { field: 'apiKey', env: 'GROQ_API_KEY' },
  tavily: { field: 'tavilyKey', env: 'TAVILY_API_KEY' },
};

const MIC_SENSITIVITIES = ['low', 'normal', 'high'];

class Store {
  /**
   * filePath: where to keep the JSON.
   * cipher: { isAvailable(): bool, encrypt(str): Buffer, decrypt(Buffer): str }
   */
  constructor(filePath, cipher) {
    this.filePath = filePath;
    this.cipher = cipher;
    this.data = { ...DEFAULT_SETTINGS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (raw && typeof raw === 'object') this.data = { ...DEFAULT_SETTINGS, ...raw };
    } catch {
      // first run or unreadable file: keep defaults
    }
    if (!Object.hasOwn(SEARCH_ENGINES, this.data.searchEngine)) this.data.searchEngine = 'google';
    if (!MIC_SENSITIVITIES.includes(this.data.micSensitivity)) this.data.micSensitivity = 'normal';
    for (const key of ['lastAnnouncedUpdate', 'dismissedUpdate']) {
      if (typeof this.data[key] !== 'string' || this.data[key].length > 40) this.data[key] = '';
    }
    const recent = Array.isArray(this.data.recentApps) ? this.data.recentApps : [];
    this.data.recentApps = recent.filter((n) => typeof n === 'string' && n.trim() && n.length <= 200).slice(0, 6);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[nibo] could not save settings:', err.message);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

  setSecret(name, value) {
    const { field } = SECRETS[name];
    const trimmed = String(value || '').trim();
    if (!trimmed) {
      delete this.data[field];
    } else if (this.cipher && this.cipher.isAvailable()) {
      this.data[field] = { enc: 'safe', value: this.cipher.encrypt(trimmed).toString('base64') };
    } else {
      this.data[field] = { enc: 'plain', value: Buffer.from(trimmed, 'utf8').toString('base64') };
    }
    this.save();
  }

  getSecret(name) {
    const { field, env } = SECRETS[name];
    const stored = this.data[field];
    if (stored && typeof stored === 'object' && typeof stored.value === 'string') {
      try {
        const buf = Buffer.from(stored.value, 'base64');
        if (stored.enc === 'safe') {
          if (this.cipher && this.cipher.isAvailable()) return this.cipher.decrypt(buf);
        } else {
          return buf.toString('utf8');
        }
      } catch (err) {
        console.error(`[nibo] could not read the saved ${name} key:`, err.message);
      }
    }
    return process.env[env] || null;
  }

  secretSource(name) {
    const { field, env } = SECRETS[name];
    if (this.data[field]) return 'settings';
    if (process.env[env]) return 'env';
    return null;
  }

  secretHint(name) {
    const key = this.getSecret(name);
    if (!key) return null;
    return key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••';
  }

  // The Groq key (kept under its original names).
  setApiKey(key) {
    this.setSecret('groq', key);
  }

  getApiKey() {
    return this.getSecret('groq');
  }

  keySource() {
    return this.secretSource('groq');
  }

  keyHint() {
    return this.secretHint('groq');
  }
}

module.exports = { Store, DEFAULT_SETTINGS, MIC_SENSITIVITIES };
