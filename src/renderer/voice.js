'use strict';

// Nibo's ears: microphone capture, voice-activity detection (with a little
// pre-roll so first syllables aren't clipped), WAV encoding, and filters for
// echoes of Nibo's own voice and Whisper's "phantom" phrases.
// The pure parts also load in Node for tests.
(function (root) {
  const SAMPLE_RATE = 16000;

  // How far above the background noise counts as talking.
  const SENSITIVITY = {
    low: { margin: 18, min: -40 },
    normal: { margin: 13, min: -48 },
    high: { margin: 9, min: -55 },
  };

  function rmsDb(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return 20 * Math.log10(Math.sqrt(sum / Math.max(1, samples.length)) + 1e-9);
  }

  function concat(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  /**
   * Voice-activity detector. push() a chunk of mono float samples and get
   * events back: { type: 'start', bargeIn }, { type: 'end', samples, speechMs,
   * durationMs }, { type: 'discard' } (too short, or steady noise rather than
   * a voice), plus a { type: 'level', db, threshold } for every chunk.
   *
   * It listens to the room for a moment first to learn the background noise.
   *
   * While Nibo is speaking, his voice leaks from the speakers into the mic.
   * The detector learns how loud that leak is (barge-in is off for the first
   * moment of each reply while it calibrates) and only treats clearly louder
   * sound as the user talking over him.
   */
  function createDetector({
    sampleRate = SAMPLE_RATE,
    sensitivity = 'normal',
    preRollMs = 400,
    warmupMs = 500,
    steadyMs = 2000,
    startMs = 160,
    bargeStartMs = 320,
    calibrateMs = 700,
    tailMs = 450,
    endSilenceMs = 900,
    minSpeechMs = 300,
    maxMs = 30000,
  } = {}) {
    let sens = SENSITIVITY[sensitivity] || SENSITIVITY.normal;
    let floor = -60;
    let warmup = warmupMs;
    let warmLevels = [];
    let levels = []; // dB of each chunk in the current utterance
    let niboSpeaking = false;
    let bleedPeak = -90;
    let calibrating = 0;
    let tail = 0;
    let inSpeech = false;
    let bargeIn = false;
    let loudMs = 0;
    let silenceMs = 0;
    let speechMs = 0;
    let utterMs = 0;
    let preRoll = [];
    let preRollMsNow = 0;
    let utter = [];

    const baseThreshold = () => Math.max(floor + sens.margin, sens.min);
    const echoMode = () => niboSpeaking || tail > 0;
    const threshold = () => (echoMode() ? Math.max(baseThreshold(), bleedPeak + 8) : baseThreshold());

    function finish(events) {
      const samples = concat(utter);
      if (speechMs >= minSpeechMs) {
        events.push({ type: 'end', samples, speechMs, durationMs: utterMs, bargeIn });
      } else {
        events.push({ type: 'discard' });
      }
      inSpeech = false;
      utter = [];
      levels = [];
      utterMs = 0;
      loudMs = 0;
      silenceMs = 0;
      speechMs = 0;
    }

    return {
      setSensitivity(name) {
        sens = SENSITIVITY[name] || SENSITIVITY.normal;
      },
      setNiboSpeaking(on) {
        if (on && !niboSpeaking) {
          calibrating = calibrateMs;
          bleedPeak = Math.max(bleedPeak, floor);
        }
        if (!on && niboSpeaking) tail = tailMs;
        niboSpeaking = on;
      },
      get floor() {
        return floor;
      },
      get inSpeech() {
        return inSpeech;
      },

      push(chunk) {
        const ms = (chunk.length / sampleRate) * 1000;
        const db = rmsDb(chunk);
        const th = threshold();
        const loud = db > th;
        const events = [{ type: 'level', db, threshold: th }];

        if (warmup > 0) {
          // Learn the room before listening for speech.
          warmup -= ms;
          warmLevels.push(db);
          const sorted = [...warmLevels].sort((a, b) => a - b);
          floor = Math.min(-25, sorted[Math.floor(sorted.length / 2)]);
          return events;
        }

        if (tail > 0) tail = Math.max(0, tail - ms);
        if (!echoMode()) bleedPeak = Math.max(-90, bleedPeak - 0.5); // forget old leaks slowly

        if (!inSpeech) {
          if (echoMode()) {
            // Learn how loud Nibo's own voice is in the mic.
            if (calibrating > 0) {
              calibrating -= ms;
              bleedPeak = Math.max(bleedPeak, db);
            } else if (!loud) {
              bleedPeak = Math.max(bleedPeak - 0.05, db);
            }
          } else if (db < floor) {
            floor = floor * 0.7 + db * 0.3;
          } else if (!loud) {
            floor = Math.min(-25, floor * 0.995 + db * 0.005);
          }

          preRoll.push(chunk);
          preRollMsNow += ms;
          while (preRoll.length > 1 && preRollMsNow - (preRoll[0].length / sampleRate) * 1000 >= preRollMs) {
            preRollMsNow -= (preRoll.shift().length / sampleRate) * 1000;
          }

          const canStart = !(echoMode() && calibrating > 0);
          loudMs = loud && canStart ? loudMs + ms : 0;
          if (loudMs >= (echoMode() ? bargeStartMs : startMs)) {
            inSpeech = true;
            bargeIn = echoMode();
            utter = preRoll;
            utterMs = preRollMsNow;
            speechMs = loudMs;
            silenceMs = 0;
            preRoll = [];
            preRollMsNow = 0;
            events.push({ type: 'start', bargeIn });
          }
          return events;
        }

        utter.push(chunk);
        utterMs += ms;
        levels.push(db);
        if (db > th - 4) {
          silenceMs = 0;
          speechMs += ms;
        } else {
          silenceMs += ms;
        }

        // Voices rise and fall; a fan or hum stays flat. Treat steady sound as
        // the new background instead of something to transcribe.
        const recent = levels.slice(-Math.ceil(steadyMs / ms));
        if (recent.length * ms >= steadyMs) {
          const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
          const spread = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length);
          if (spread < 1.5) {
            floor = Math.min(-25, mean);
            speechMs = 0;
            finish(events);
            return events;
          }
        }

        if (silenceMs >= endSilenceMs || utterMs >= maxMs) finish(events);
        return events;
      },
    };
  }

  /** 16-bit mono PCM WAV. Returns a Uint8Array. */
  function encodeWav(samples, sampleRate = SAMPLE_RATE) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buffer);
  }

  function normalizeWords(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  // Things Whisper likes to "hear" in noise or near-silence.
  const PHANTOMS = new Set([
    'you',
    'thank you',
    'thanks',
    'thanks for watching',
    'thank you for watching',
    'thank you so much for watching',
    'bye',
    'okay',
    'oh',
    'hmm',
    'subtitles by the amara org community',
  ]);

  function isPhantom(text, { speechMs = 0 } = {}) {
    const words = normalizeWords(text);
    if (!words.length) return true;
    const phrase = words.join(' ');
    if (phrase.includes('the cute bunny assistant')) return true; // the transcription prompt echoed back
    return speechMs < 1500 && PHANTOMS.has(phrase);
  }

  // Did the mic just hear Nibo's own words?
  function isEcho(transcript, spoken) {
    const words = normalizeWords(transcript);
    if (words.length < 2) return false; // short commands like "stop" always count
    const said = new Set(normalizeWords(spoken));
    if (!said.size) return false;
    const overlap = words.filter((w) => said.has(w)).length / words.length;
    return overlap >= 0.7;
  }

  // ---------- browser side: the microphone ----------

  class Ears {
    /** handlers: { onStart(bargeIn), onUtterance({ wav, speechMs, durationMs, bargeIn }), onLevel(db), onDiscard() } */
    constructor(handlers) {
      this.handlers = handlers;
      this.detector = null;
      this.stream = null;
      this.ctx = null;
      this.proc = null;
    }

    async open(sensitivity = 'normal') {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.proc = this.ctx.createScriptProcessor(1024, 1, 1);
      this.detector = createDetector({ sampleRate: this.ctx.sampleRate, sensitivity });
      this.proc.onaudioprocess = (e) => {
        const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
        for (const ev of this.detector.push(chunk)) this.dispatch(ev);
      };
      source.connect(this.proc);
      this.proc.connect(this.ctx.destination); // silent; keeps the processor running
    }

    dispatch(ev) {
      const h = this.handlers;
      if (ev.type === 'level' && h.onLevel) h.onLevel(ev.db, ev.threshold);
      else if (ev.type === 'start' && h.onStart) h.onStart(ev.bargeIn);
      else if (ev.type === 'discard' && h.onDiscard) h.onDiscard();
      else if (ev.type === 'end' && h.onUtterance) {
        h.onUtterance({
          wav: encodeWav(ev.samples, this.ctx.sampleRate),
          speechMs: ev.speechMs,
          durationMs: ev.durationMs,
          bargeIn: ev.bargeIn,
        });
      }
    }

    setNiboSpeaking(on) {
      if (this.detector) this.detector.setNiboSpeaking(on);
    }

    setSensitivity(name) {
      if (this.detector) this.detector.setSensitivity(name);
    }

    close() {
      if (this.proc) {
        this.proc.onaudioprocess = null;
        this.proc.disconnect();
      }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.ctx) this.ctx.close().catch(() => {});
      this.proc = this.stream = this.ctx = this.detector = null;
    }
  }

  const api = { SAMPLE_RATE, createDetector, encodeWav, rmsDb, normalizeWords, isPhantom, isEcho, Ears };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NiboVoice = api;
})(typeof window !== 'undefined' ? window : globalThis);
