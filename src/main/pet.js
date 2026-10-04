'use strict';

// Nibo's tummy and mood. Pure functions so they are easy to test.

const MINUTE = 60 * 1000;
const MAX_CATCHUP_MINUTES = 24 * 60;

const FULLNESS_LOSS_PER_MIN = 1 / 3; // empty after ~5 hours
const HAPPINESS_LOSS_PER_MIN = 1 / 10;
const HUNGRY_HAPPINESS_LOSS_PER_MIN = 1 / 4;

const HUNGRY_BELOW = 25;
const STUFFED_AT = 95;

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function createPet(now = Date.now()) {
  return { fullness: 70, happiness: 70, carrotsEaten: 0, updatedAt: now };
}

function normalize(pet, now = Date.now()) {
  const base = createPet(now);
  if (!pet || typeof pet !== 'object') return base;
  return {
    fullness: Number.isFinite(pet.fullness) ? clamp(pet.fullness) : base.fullness,
    happiness: Number.isFinite(pet.happiness) ? clamp(pet.happiness) : base.happiness,
    carrotsEaten: Number.isFinite(pet.carrotsEaten) ? Math.max(0, Math.floor(pet.carrotsEaten)) : 0,
    updatedAt: Number.isFinite(pet.updatedAt) ? pet.updatedAt : now,
  };
}

// Advance time: Nibo slowly gets hungry, and a hungry bunny gets grumpy faster.
function tick(pet, now = Date.now()) {
  const p = normalize(pet, now);
  const minutes = Math.min(MAX_CATCHUP_MINUTES, Math.max(0, (now - p.updatedAt) / MINUTE));
  if (minutes <= 0) return { ...p, updatedAt: Math.max(p.updatedAt, now) };

  const fullness = clamp(p.fullness - minutes * FULLNESS_LOSS_PER_MIN);
  const hungry = fullness < HUNGRY_BELOW;
  const happinessLoss = minutes * (hungry ? HUNGRY_HAPPINESS_LOSS_PER_MIN : HAPPINESS_LOSS_PER_MIN);
  // Happiness only drifts down toward a calm baseline unless Nibo is hungry.
  const floor = hungry ? 0 : Math.min(p.happiness, 40);
  const happiness = clamp(Math.max(floor, p.happiness - happinessLoss));

  return { ...p, fullness, happiness, updatedAt: now };
}

function feed(pet, now = Date.now()) {
  const p = tick(pet, now);
  if (p.fullness >= STUFFED_AT) {
    return { pet: { ...p, happiness: clamp(p.happiness + 2) }, result: 'stuffed' };
  }
  return {
    pet: {
      ...p,
      fullness: clamp(p.fullness + 22),
      happiness: clamp(p.happiness + 15),
      carrotsEaten: p.carrotsEaten + 1,
    },
    result: 'yum',
  };
}

// A head pat / poke / nice chat.
function cheer(pet, amount = 4, now = Date.now()) {
  const p = tick(pet, now);
  return { ...p, happiness: clamp(p.happiness + amount) };
}

function moodOf(pet) {
  const p = normalize(pet);
  if (p.fullness < HUNGRY_BELOW) return 'hungry';
  if (p.happiness < 30) return 'sad';
  if (p.happiness >= 70) return 'happy';
  return 'okay';
}

module.exports = {
  HUNGRY_BELOW,
  STUFFED_AT,
  clamp,
  createPet,
  normalize,
  tick,
  feed,
  cheer,
  moodOf,
};
