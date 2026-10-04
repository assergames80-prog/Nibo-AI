'use strict';

// Tiny JSON settings store. The API key is encrypted with the OS keychain
// (Electron safeStorage / Windows DPAPI) whenever that is available.

const fs = require('fs');
const path = require('path');
const { SEARCH_ENGINES } = require('./offline');

const DEFAULT_SETTINGS = {
  model: 'openai/gpt-oss-20b',
  searchEngine: 'google',
  voice: false,
  boil: true,
  firstRun: true,
  position: null,
  pet: null,
};

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

  setApiKey(key) {
    const trimmed = String(key || '').trim();
    if (!trimmed) {
      delete this.data.apiKey;
      this.save();
      return;
    }
    if (this.cipher && this.cipher.isAvailable()) {
      this.data.apiKey = { enc: 'safe', value: this.cipher.encrypt(trimmed).toString('base64') };
    } else {
      this.data.apiKey = { enc: 'plain', value: Buffer.from(trimmed, 'utf8').toString('base64') };
    }
    this.save();
  }

  getApiKey() {
    const stored = this.data.apiKey;
    if (stored && typeof stored === 'object' && typeof stored.value === 'string') {
      try {
        const buf = Buffer.from(stored.value, 'base64');
        if (stored.enc === 'safe') {
          if (this.cipher && this.cipher.isAvailable()) return this.cipher.decrypt(buf);
        } else {
          return buf.toString('utf8');
        }
      } catch (err) {
        console.error('[nibo] could not read the saved API key:', err.message);
      }
    }
    return process.env.GROQ_API_KEY || null;
  }

  keySource() {
    if (this.data.apiKey) return 'settings';
    if (process.env.GROQ_API_KEY) return 'env';
    return null;
  }

  keyHint() {
    const key = this.getApiKey();
    if (!key) return null;
    return key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••';
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
