'use strict';

// Understands *when* something should happen, in the words people use:
// "in 20 minutes", "in an hour and a half", "at 6pm", "tomorrow at 9",
// "friday at 5:30 pm", "on the 15th", "next week". Plain logic, no Electron,
// so it can be tested with a made-up clock.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_AHEAD_MS = 400 * DAY;

// ---------- numbers and units ----------

const WORD_VALUES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUMBER_WORD =
  '(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?|' +
  'thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|eleven|twelve|zero|ten|nine|eight|seven|six|five|four|three|two|one)';
const HOUR_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const COUNT = `(?:\\d+(?:[.,]\\d+)?|${NUMBER_WORD}|a\\s+couple(?:\\s+of)?|couple(?:\\s+of)?|a\\s+few|few|an?)`;
const UNIT = '(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)';

function numberOf(token) {
  const t = String(token).toLowerCase().trim();
  if (/^\d/.test(t)) return parseFloat(t.replace(',', '.'));
  if (/^an?$/.test(t)) return 1;
  if (/couple/.test(t)) return 2;
  if (/few/.test(t)) return 3;
  return t.split(/[\s-]+/).reduce((sum, w) => sum + (WORD_VALUES[w] ?? 0), 0);
}

function unitValue(word) {
  const w = String(word).toLowerCase();
  if (w === 'm' || /^mi/.test(w)) return { ms: MINUTE };
  if (/^mo/.test(w)) return { months: 1 };
  if (/^s/.test(w)) return { ms: SECOND };
  if (/^h/.test(w)) return { ms: HOUR };
  if (/^d/.test(w)) return { ms: DAY };
  if (/^w/.test(w)) return { ms: 7 * DAY };
  if (/^y/.test(w)) return { months: 12 };
  return {};
}

// ---------- durations: "20 minutes", "an hour and a half", "1h30" ----------

const RE_HALF = new RegExp(`(?:an?\\s+)?half(?:\\s+of)?(?:\\s+an?)?[\\s-]+(${UNIT})\\b`, 'iy');
const RE_QUARTER = new RegExp(`(?:an?\\s+)?(three\\s+)?quarters?(?:\\s+of)?(?:\\s+an?)?[\\s-]+(${UNIT})\\b`, 'iy');
const RE_HM = /(\d+)h(\d{1,2})(?![\p{L}\p{N}:])/iuy;
const RE_LETTER = /(\d+(?:[.,]\d+)?)([smhdw])(?![\p{L}\p{N}])/iuy;
const RE_COUNT_UNIT = new RegExp(
  `(${COUNT})(\\s+and\\s+(?:a\\s+)?half)?[\\s-]*(${UNIT})\\b(\\s+and\\s+(?:a\\s+)?half\\b)?`,
  'iy',
);
const SEPARATOR = /\s*(?:,|&|\+|\band\b|\bplus\b)?\s*/y;

function matchAt(re, str, index) {
  re.lastIndex = index;
  return re.exec(str);
}

function piece(end, amount, unit) {
  const u = unitValue(unit);
  return { end, ms: (u.ms || 0) * amount, months: (u.months || 0) * amount };
}

function readPiece(str, i) {
  let m = matchAt(RE_HALF, str, i);
  if (m) return piece(RE_HALF.lastIndex, 0.5, m[1]);
  m = matchAt(RE_QUARTER, str, i);
  if (m) return piece(RE_QUARTER.lastIndex, m[1] ? 0.75 : 0.25, m[2]);
  m = matchAt(RE_HM, str, i);
  if (m) return { end: RE_HM.lastIndex, ms: Number(m[1]) * HOUR + Number(m[2]) * MINUTE, months: 0 };
  m = matchAt(RE_LETTER, str, i);
  if (m) return piece(RE_LETTER.lastIndex, numberOf(m[1]), m[2]);
  m = matchAt(RE_COUNT_UNIT, str, i);
  if (m) return piece(RE_COUNT_UNIT.lastIndex, numberOf(m[1]) + (m[2] || m[4] ? 0.5 : 0), m[3]);
  return null;
}

/** Reads "1 hour and 30 minutes" starting exactly at `from`. */
function scanDuration(str, from) {
  const first = readPiece(str, from);
  if (!first) return null;
  let { end, ms, months } = first;
  for (;;) {
    const sep = matchAt(SEPARATOR, str, end);
    const next = readPiece(str, end + (sep ? sep[0].length : 0));
    if (!next) break;
    end = next.end;
    ms += next.ms;
    months += next.months;
  }
  return { end, ms, months };
}

const LEAD_ANCHOR =
  /\b(in|after|within|for|of|another|timer|countdown)\s+(?:(?:about|around|roughly|approximately|approx|like|exactly|just|only|the\s+next)\s+)?$/i;
const TAIL_RELATIVE = /^(?:['’]?s)?(?:\s+time)?\s+(?:from\s+now|from\s+then|later)\b/i;
const TAIL_TIME = /^['’]?s?\s+time\b/i;
const TAIL_TIMER = /^[\s-]*(?:timer|countdown|count\s*down)\b/i;

/**
 * Finds the delay in a sentence: "in 20 minutes", "10 minutes from now", and
 * for timers "for 5 minutes" / "5 minute timer". With `bare`, a duration
 * without any of those words counts too ("20 minutes").
 */
function findDuration(str, { timer = false, bare = false } = {}) {
  const tokens = /[\p{L}\p{N}]+/gu;
  for (let t; (t = tokens.exec(str)); ) {
    const d = scanDuration(str, t.index);
    if (!d) continue;
    tokens.lastIndex = d.end; // don't look for another duration inside this one
    let start = t.index;
    let end = d.end;
    let how = null;
    const lead = LEAD_ANCHOR.exec(str.slice(0, start));
    if (lead) {
      const word = lead[1].toLowerCase();
      if (['in', 'after', 'within', 'another'].includes(word)) how = 'relative';
      else if (timer) how = 'timer';
      if (how) start = lead.index;
    }
    const tail = TAIL_RELATIVE.exec(str.slice(end));
    if (tail) {
      end += tail[0].length;
      how ||= 'relative';
    } else if (how) {
      const time = TAIL_TIME.exec(str.slice(end));
      if (time) end += time[0].length;
    }
    if (!how && timer && TAIL_TIMER.test(str.slice(end))) how = 'timer';
    if (!how && bare) how = 'bare';
    if (how) return { start, end, how, ms: d.ms, months: d.months };
  }
  return null;
}

// ---------- clock times: "6pm", "18:30", "at 7", "noon", "half past six" ----------

const PRE = '(?:(?:at|on|by|for|around)\\s+)?';
const MERIDIEM = '([ap])\\.?m\\b\\.?';
const meridiem = (letter) => (letter ? (letter.toLowerCase() === 'a' ? 'am' : 'pm') : null);

const CLOCK_PATTERNS = [
  {
    // 6pm, 6:30 pm, at 6 p.m.
    re: new RegExp(`\\b${PRE}(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MERIDIEM}`, 'gi'),
    read: (m) => {
      const h = Number(m[1]);
      const min = Number(m[2] || 0);
      return h >= 1 && h <= 12 && min < 60 ? { h, m: min, mer: meridiem(m[3]) } : null;
    },
  },
  {
    // 18:30, 6:30, 07:30
    re: new RegExp(`\\b${PRE}(\\d{1,2}):(\\d{2})\\b(?!\\s*[ap]\\.?m\\b)`, 'gi'),
    read: (m) => {
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (h > 23 || min > 59) return null;
      return { h, m: min, mer: null, exact: h === 0 || h >= 13 || m[1].length === 2 };
    },
  },
  {
    // 6 o'clock, six o'clock
    re: new RegExp(`\\b${PRE}(\\d{1,2}|${HOUR_WORD})\\s*o['’]?clock\\b(?:\\s+${MERIDIEM})?`, 'gi'),
    read: (m) => {
      const h = numberOf(m[1]);
      return h >= 1 && h <= 12 ? { h, m: 0, mer: meridiem(m[2]) } : null;
    },
  },
  {
    // at 6, around 18
    re: new RegExp(
      `\\b(?:at|by|around)\\s+(\\d{1,2})(?![\\d:.,]|\\s*(?:%|${UNIT}\\b|[ap]\\.?m\\b|o['’]?clock|st\\b|nd\\b|rd\\b|th\\b))`,
      'gi',
    ),
    read: (m) => {
      const h = Number(m[1]);
      if (h < 1 || h > 23) return null;
      return { h, m: 0, mer: null, exact: h >= 13 };
    },
  },
  {
    // noon, midnight
    re: new RegExp(`\\b${PRE}(noon|midday|midnight)\\b`, 'gi'),
    read: (m) => ({ h: /midnight/i.test(m[1]) ? 0 : 12, m: 0, mer: null, exact: true }),
  },
  {
    // half past six, quarter to 5, a quarter past 3 pm
    re: new RegExp(`\\b${PRE}(?:a\\s+)?(half|quarter)\\s+(past|to)\\s+(\\d{1,2}|${HOUR_WORD})\\b(?:\\s+${MERIDIEM})?`, 'gi'),
    read: (m) => {
      let h = numberOf(m[3]);
      if (!(h >= 1 && h <= 12)) return null;
      const quarter = m[1].toLowerCase() === 'quarter';
      let min;
      if (m[2].toLowerCase() === 'past') min = quarter ? 15 : 30;
      else if (quarter) {
        min = 45;
        h = h === 1 ? 12 : h - 1;
      } else return null;
      return { h, m: min, mer: meridiem(m[4]) };
    },
  },
  {
    // at six pm, at six thirty
    re: new RegExp(`\\b(?:at|by|around)\\s+(${HOUR_WORD})(?:\\s+(fifteen|thirty|forty[\\s-]?five))?(?:\\s+${MERIDIEM})?(?![\\p{L}\\p{N}])`, 'giu'),
    read: (m) => {
      if (!m[2] && !m[3]) return null; // a bare "at one" is more often "at one point"
      const min = m[2] ? { fifteen: 15, thirty: 30 }[m[2].toLowerCase()] || 45 : 0;
      return { h: numberOf(m[1]), m: min, mer: meridiem(m[3]) };
    },
  },
];

// "the 3pm meeting" names a meeting; it isn't a time to remind at.
const ARTICLE_BEFORE = /\b(?:the|an?|my|our|his|her|their|your|this|that|every|each)\s+$/i;

function findClock(str) {
  const found = [];
  for (const { re, read } of CLOCK_PATTERNS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(str)); ) {
      const clock = read(m);
      if (!clock) continue;
      const hasPreposition = /^(?:at|on|by|for|around)\b/i.test(m[0]);
      if (!hasPreposition && ARTICLE_BEFORE.test(str.slice(0, m.index))) continue;
      found.push({ ...clock, start: m.index, end: m.index + m[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  return found[0] || null;
}

// ---------- days: "tomorrow", "friday", "next week", "on the 15th" ----------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)';
const PART_OF_DAY = '(?:\\s+(?:in\\s+the\\s+)?(morning|afternoon|evening|night)\\b)?';
const PART_DEFAULT = { morning: [9, 0], afternoon: [15, 0], evening: [18, 0], night: [21, 0] };

const monthIndex = (name) => MONTH_NAMES.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3)));
const weekdayIndex = (name) => WEEKDAYS.findIndex((d) => d.startsWith(name.toLowerCase().slice(0, 3)));

const DAY_PATTERNS = [
  { re: /\bday\s+after\s+tomorrow\b/gi, read: () => ({ kind: 'offset', days: 2 }) },
  {
    re: new RegExp(`\\b(?:tomorrow|tmrw|tmr)\\b${PART_OF_DAY}`, 'gi'),
    read: (m) => ({ kind: 'offset', days: 1, part: m[1] && m[1].toLowerCase() }),
  },
  { re: /\btonight\b/gi, read: () => ({ kind: 'offset', days: 0, part: 'night', tonight: true }) },
  {
    re: /\b(?:this|later\s+this)\s+(morning|afternoon|evening)\b/gi,
    read: (m) => ({ kind: 'offset', days: 0, part: m[1].toLowerCase() }),
  },
  { re: /\bin\s+the\s+(morning|afternoon|evening)\b/gi, read: (m) => ({ kind: 'part', part: m[1].toLowerCase() }) },
  { re: /\bat\s+night\b/gi, read: () => ({ kind: 'part', part: 'night' }) },
  { re: /\b(?:later\s+)?today\b/gi, read: () => ({ kind: 'offset', days: 0, plain: true }) },
  { re: /\bnext\s+week\b/gi, read: () => ({ kind: 'nextweek' }) },
  {
    re: new RegExp(`\\b(?:(on|next|this|coming)\\s+)?(${WEEKDAYS.join('|')})\\b${PART_OF_DAY}`, 'gi'),
    read: (m) => ({ kind: 'weekday', weekday: weekdayIndex(m[2]), word: m[1] && m[1].toLowerCase(), part: m[3] && m[3].toLowerCase() }),
  },
  {
    re: new RegExp(`\\b(on|next)\\s+(sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)\\b${PART_OF_DAY}`, 'gi'),
    read: (m) => ({ kind: 'weekday', weekday: weekdayIndex(m[2]), word: m[1].toLowerCase(), part: m[3] && m[3].toLowerCase() }),
  },
  {
    re: new RegExp(`\\bon\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)\\b(?:\\s+of\\s+${MONTH})?`, 'gi'),
    read: (m) => ({ kind: 'date', day: Number(m[1]), month: m[2] ? monthIndex(m[2]) : undefined }),
  },
  {
    re: new RegExp(`\\bon\\s+${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'),
    read: (m) => ({ kind: 'date', month: monthIndex(m[1]), day: Number(m[2]) }),
  },
  {
    re: new RegExp(`\\bon\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, 'gi'),
    read: (m) => ({ kind: 'date', day: Number(m[1]), month: monthIndex(m[2]) }),
  },
];

function findDay(str) {
  const found = [];
  for (const { re, read } of DAY_PATTERNS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(str)); ) found.push({ ...read(m), start: m.index, end: m.index + m[0].length });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  return found[0] || null;
}

// ---------- putting it together ----------

const withTime = (date, h, m) => {
  const d = new Date(date.getTime());
  d.setHours(h, m, 0, 0);
  return d;
};
const plusDays = (date, n) => {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
};

// The 24-hour hours a clock reading could mean, most likely first.
function hourChoices(clock, part) {
  if (clock.mer) return [(clock.h % 12) + (clock.mer === 'pm' ? 12 : 0)];
  if (clock.exact) return [clock.h];
  const am = clock.h % 12;
  const pm = am + 12;
  if (part === 'morning') return [am];
  if (part === 'afternoon' || part === 'evening') return [pm];
  if (part === 'night') return [clock.h >= 6 && clock.h < 12 ? pm : am];
  if (clock.h === 12) return [pm, am];
  return clock.h <= 6 ? [pm, am] : [am, pm];
}

const earliestAfter = (dates, now) => dates.filter((d) => d > now).sort((a, b) => a - b)[0] || null;

/** A day and/or a clock time -> a Date, or { error }. */
function resolveAbsolute(now, day, clock, hint = null) {
  const part = (day && day.part) || hint;
  const choices = clock ? hourChoices(clock, part) : null;
  const minutes = clock ? clock.m : 0;
  const defaultTime = () => PART_DEFAULT[part] || [9, 0];

  // No day, or just "in the morning": the next time it will be that time.
  if (!day || day.kind === 'part') {
    if (!clock) {
      const [h, m] = defaultTime();
      const today = withTime(now, h, m);
      return today > now ? today : withTime(plusDays(now, 1), h, m);
    }
    return (
      earliestAfter(choices.map((h) => withTime(now, h, minutes)), now) || withTime(plusDays(now, 1), choices[0], minutes)
    );
  }

  const [h, m] = clock ? [choices[0], minutes] : defaultTime();

  if (day.kind === 'offset') {
    let base = plusDays(now, day.days);
    if (day.days === 0) {
      if (day.tonight && clock && choices[0] < 6) base = plusDays(now, 1); // "tonight at 12" is after midnight
      if (clock && !(day.tonight && choices[0] < 6)) {
        const target = earliestAfter(choices.map((c) => withTime(base, c, minutes)), now);
        return target || { error: 'past' };
      }
    }
    const target = withTime(base, h, m);
    return target > now ? target : { error: 'past' };
  }

  if (day.kind === 'weekday') {
    const delta = (day.weekday - now.getDay() + 7) % 7;
    let target = withTime(plusDays(now, delta), h, m);
    if (delta === 0 && (day.word === 'next' || target <= now)) target = plusDays(target, 7);
    return target;
  }

  if (day.kind === 'nextweek') {
    const delta = (1 - now.getDay() + 7) % 7 || 7; // the coming Monday
    return withTime(plusDays(now, delta), h, m);
  }

  if (day.kind === 'date') {
    if (day.month === undefined) {
      for (let k = 0; k < 14; k++) {
        const d = new Date(now.getFullYear(), now.getMonth() + k, day.day, h, m, 0, 0);
        if (d.getDate() === day.day && d > now) return d;
      }
    } else {
      for (let year = now.getFullYear(); year <= now.getFullYear() + 1; year++) {
        const d = new Date(year, day.month, day.day, h, m, 0, 0);
        if (d.getMonth() === day.month && d.getDate() === day.day && d > now) return d;
      }
    }
    return { error: 'baddate' };
  }
  return { error: 'baddate' };
}

/**
 * Finds the time in `text`.
 *   null                         no time in there
 *   { ok: true, due, spans }     `spans` are the [start, end) pieces of `text` that said when
 *   { ok: false, reason, spans } a time that can't be used: 'past' | 'far' | 'zero' | 'baddate'
 * opts.timer: "for 5 minutes" and "5 minute timer" count as delays.
 * opts.bare:  a delay without "in" counts too ("20 minutes").
 * opts.part:  'morning' etc.: which half of the day a plain "at 6:30" most likely means.
 */
function parseWhen(text, now = new Date(), { timer = false, bare = false, part = null } = {}) {
  const str = String(text);

  const dur = findDuration(str, { timer, bare });
  if (dur) {
    const spans = [[dur.start, dur.end]];
    const calendar = dur.months > 0 || (dur.ms >= DAY && dur.ms % DAY === 0);
    const clock = calendar ? findClock(str.slice(0, dur.start) + ' '.repeat(dur.end - dur.start) + str.slice(dur.end)) : null;
    if (!(dur.ms > 0 || dur.months > 0)) return { ok: false, reason: 'zero', spans };

    let due = new Date(now.getTime());
    if (dur.months) {
      const whole = Math.trunc(dur.months);
      due.setMonth(due.getMonth() + whole);
      due = new Date(due.getTime() + (dur.months - whole) * 30 * DAY);
    }
    const days = Math.floor(dur.ms / DAY);
    due.setDate(due.getDate() + days); // whole days keep the clock time, even across daylight saving
    due = new Date(due.getTime() + (dur.ms - days * DAY));
    if (clock) {
      due = withTime(due, hourChoices(clock, null)[0], clock.m);
      spans.push([clock.start, clock.end]);
    }
    if (due - now < SECOND) return { ok: false, reason: due > now ? 'zero' : 'past', spans };
    if (due - now > MAX_AHEAD_MS) return { ok: false, reason: 'far', spans };
    return { ok: true, due, spans, how: dur.how };
  }

  const clock = findClock(str);
  const day = findDay(str);
  if (!clock && !day) return null;
  if (!clock && day.kind === 'offset' && day.plain) return null; // "today" alone doesn't say when
  const spans = [];
  if (clock) spans.push([clock.start, clock.end]);
  if (day) spans.push([day.start, day.end]);

  const due = resolveAbsolute(now, day, clock, part);
  if (due.error) return { ok: false, reason: due.error, spans };
  if (due - now > MAX_AHEAD_MS) return { ok: false, reason: 'far', spans };
  return { ok: true, due, spans, how: 'absolute' };
}

/** `text` without the given [start, end) pieces. */
function cut(text, spans) {
  let out = '';
  let pos = 0;
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (start < pos) {
      pos = Math.max(pos, end);
      continue;
    }
    out += `${text.slice(pos, start)} `;
    pos = end;
  }
  return out + text.slice(pos);
}

// ---------- saying it back ----------

function formatDuration(ms) {
  let s = Math.max(1, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const unit = (n, name) => `${n} ${name}${n === 1 ? '' : 's'}`;
  const parts = [];
  if (d) {
    parts.push(unit(d, 'day'));
    if (h) parts.push(unit(h, 'hour'));
  } else if (h) {
    parts.push(unit(h, 'hour'));
    if (m) parts.push(unit(m, 'minute'));
  } else if (m) {
    parts.push(unit(m, 'minute'));
    if (s && m < 5) parts.push(unit(s, 'second'));
  } else {
    parts.push(unit(s, 'second'));
  }
  return parts.join(' ');
}

const formatClock = (date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "today", "tomorrow", "Friday, Oct 9", "Oct 15", "Mar 3, 2027". */
function formatDay(date, now = new Date()) {
  const diff = Math.round((startOfDay(date) - startOfDay(now)) / DAY);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff < 7) return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const opts = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString([], opts);
}

/** "in 20 minutes (3:42 PM)", "today at 9:00 PM", "tomorrow at 9:00 AM". */
function describeDue(due, now = new Date()) {
  const diff = due - now;
  if (diff < 2 * MINUTE) return `in ${formatDuration(diff)}`;
  if (diff < 6 * HOUR) return `in ${formatDuration(diff)} (${formatClock(due)})`;
  return `${formatDay(due, now)} at ${formatClock(due)}`;
}

module.exports = {
  DAY,
  HOUR,
  MAX_AHEAD_MS,
  MINUTE,
  SECOND,
  cut,
  describeDue,
  findClock,
  findDay,
  findDuration,
  formatClock,
  formatDay,
  formatDuration,
  numberOf,
  parseWhen,
  scanDuration,
};
