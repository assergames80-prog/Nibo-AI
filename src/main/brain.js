'use strict';

// Nibo's big brain: chat answers streamed from the Groq API.

const {
  Groq,
  APIError,
  APIConnectionError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} = require('groq-sdk');

const DEFAULT_MODEL = 'openai/gpt-oss-20b';
// Fast chat models to try if the configured one disappears from Groq.
const PREFERRED_MODELS = [
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-120b',
];
const NON_CHAT_MODEL = /whisper|tts|guard|playai|orpheus|distil|safeguard|embed/i;
const MAX_HISTORY = 16;

const SYSTEM_PROMPT = `You are Nibo, a tiny, cute, lavender-colored bunny who floats on the user's computer desktop as their AI assistant, in the spirit of classic desktop buddies.

Personality: warm, cheerful, playful and a little silly. You love carrots, puns and doing binkies (happy bunny jumps). Underneath the fluff you are genuinely smart and helpful.

How to reply:
- Your words appear in a small speech bubble, so keep replies short: usually 1-3 sentences, under about 70 words. Only go longer when the user explicitly asks for detail, and even then stay compact.
- Plain text only. No markdown headings, tables, or bold text. Use simple "-" bullet lines only when listing steps. Use a code block only if the user asks for code.
- Use at most one or two emoji per reply, and vary how you start replies.
- Be accurate. If you are unsure, or the question needs live information (news, weather, prices, scores), say so briefly and suggest the "Search the web" option in your menu.
- In chat you cannot click, open apps, browse, or change files, so never claim you did. You can tidy up folders, though: if the user wants their files organized, tell them to say "organize my desktop" (or downloads), or to pick "Organize my files" from your right-click menu. You always show them the plan first and nothing moves until they approve it.
- Stay kind and family-friendly.`;

function reasoningParams(model) {
  if (/gpt-oss/i.test(model)) return { reasoning_effort: 'low', include_reasoning: false };
  if (/qwen3/i.test(model)) return { reasoning_effort: 'none' };
  return {};
}

function isChatModel(id) {
  return typeof id === 'string' && !NON_CHAT_MODEL.test(id);
}

function choosePreferred(ids) {
  const available = ids.filter(isChatModel);
  return PREFERRED_MODELS.find((m) => available.includes(m)) || available[0] || null;
}

function looksLikeModelProblem(err) {
  if (err instanceof NotFoundError) return true;
  return err instanceof BadRequestError && /model/i.test(String(err.message));
}

function errorKind(err) {
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) return 'auth';
  if (err instanceof RateLimitError) return 'rate';
  if (err instanceof APIConnectionError) return 'network';
  if (err instanceof InternalServerError) return 'server';
  return 'other';
}

function friendlyError(err) {
  if (err instanceof APIUserAbortError) return null;
  if (err instanceof AuthenticationError) {
    return "Hmm, my key doesn't fit the lock! 🔑 Please check your Groq API key in Settings.";
  }
  if (err instanceof PermissionDeniedError) {
    return "Groq says I'm not allowed to do that with this key. 🚫 Check your Groq account settings.";
  }
  if (err instanceof RateLimitError) {
    return "Whoa, I'm out of breath — too many questions too fast! 😮‍💨 Try again in a moment.";
  }
  if (err instanceof APIConnectionError) {
    return "I can't reach my brain burrow on the internet. Are we online? 🌐";
  }
  if (err instanceof InternalServerError) {
    return 'The Groq servers are taking a nap. 💤 Try again soon!';
  }
  if (err instanceof APIError) {
    return `Oops, my ears got tangled (error ${err.status ?? '?'}). Try again? 🐰`;
  }
  return 'Oops, my ears got tangled. Try again? 🐰';
}

class Brain {
  /**
   * opts.getApiKey(): string|null
   * opts.getModel(): string|null
   * opts.setModel(id): void   - remembers an automatically chosen replacement model
   * opts.createClient(apiKey): Groq   - injectable for tests
   */
  constructor(opts) {
    this.getApiKey = opts.getApiKey;
    this.getModel = opts.getModel || (() => DEFAULT_MODEL);
    this.setModel = opts.setModel || (() => {});
    this.createClient = opts.createClient || ((apiKey) => new Groq({ apiKey, maxRetries: 1, timeout: 45_000 }));
    this.history = [];
  }

  hasKey() {
    return Boolean(this.getApiKey());
  }

  reset() {
    this.history = [];
  }

  remember(userText, assistantText) {
    this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: assistantText });
    while (this.history.length > MAX_HISTORY) this.history.splice(0, 2);
  }

  buildMessages(text, status) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history];
    if (status) {
      const tummy = Math.round(status.fullness ?? 70);
      messages.push({
        role: 'system',
        content:
          `Status: Nibo's mood is "${status.mood || 'okay'}" and his tummy is ${tummy}% full. ` +
          `The user's local time is ${status.localTime || new Date().toLocaleString()}. ` +
          'Only mention hunger if it is relevant or if Nibo is very hungry.',
      });
    }
    messages.push({ role: 'user', content: text });
    return messages;
  }

  async streamOnce(client, model, messages, { onDelta, signal, extras }) {
    const stream = await client.chat.completions.create(
      {
        model,
        messages,
        stream: true,
        temperature: 0.8,
        max_completion_tokens: 1024,
        ...extras,
      },
      { signal },
    );
    let full = '';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        if (onDelta) onDelta(delta);
      }
    }
    return full;
  }

  /**
   * Ask Nibo something. Streams text through onDelta and resolves with
   * { ok: true, text } or { ok: false, error, aborted? }.
   */
  async ask(text, { status, onDelta, signal } = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) return { ok: false, error: 'no-key' };

    const client = this.createClient(apiKey);
    const messages = this.buildMessages(text, status);
    let model = this.getModel() || DEFAULT_MODEL;
    let extras = reasoningParams(model);
    let streamed = false;
    const relay = (d) => {
      streamed = true;
      if (onDelta) onDelta(d);
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const full = (await this.streamOnce(client, model, messages, { onDelta: relay, signal, extras })).trim();
        // The SDK ends the stream quietly (no throw) when it is aborted.
        if (signal?.aborted) return { ok: false, aborted: true };
        const answer = full || "*twitches nose* ...I'm not sure what to say! 🐰";
        this.remember(text, answer);
        return { ok: true, text: answer, model };
      } catch (err) {
        if (err instanceof APIUserAbortError || signal?.aborted) return { ok: false, aborted: true };
        // Retrying after partial output would show the user a garbled bubble.
        if (streamed) return { ok: false, error: friendlyError(err), kind: errorKind(err) };

        if (looksLikeModelProblem(err)) {
          // Some models reject the reasoning knobs; try once without them.
          if (Object.keys(extras).length > 0 && /reasoning/i.test(String(err.message))) {
            extras = {};
            continue;
          }
          const replacement = await this.pickReplacementModel(client, model);
          if (replacement) {
            model = replacement;
            extras = reasoningParams(model);
            this.setModel(model);
            continue;
          }
        }
        return { ok: false, error: friendlyError(err), kind: errorKind(err) };
      }
    }
    return { ok: false, error: friendlyError(null), kind: 'other' };
  }

  async pickReplacementModel(client, current) {
    try {
      const ids = await listModelIds(client);
      const choice = choosePreferred(ids.filter((id) => id !== current));
      return choice;
    } catch {
      return null;
    }
  }
}

async function listModelIds(client) {
  const page = await client.models.list();
  const data = Array.isArray(page?.data) ? page.data : [];
  return data
    .filter((m) => m && m.active !== false && isChatModel(m.id))
    .map((m) => m.id)
    .sort((a, b) => a.localeCompare(b));
}

// Used by the Settings window to validate a key and fill the model picker.
async function testKey(apiKey, createClient) {
  const client = (createClient || ((k) => new Groq({ apiKey: k, maxRetries: 0, timeout: 20_000 })))(apiKey);
  try {
    const models = await listModelIds(client);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

module.exports = {
  Brain,
  DEFAULT_MODEL,
  PREFERRED_MODELS,
  SYSTEM_PROMPT,
  choosePreferred,
  errorKind,
  friendlyError,
  isChatModel,
  reasoningParams,
  testKey,
};
