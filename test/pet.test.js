'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pet = require('../src/main/pet');

const MIN = 60 * 1000;

test('a new pet starts content', () => {
  const p = pet.createPet(0);
  assert.equal(pet.moodOf(p), 'happy');
  assert.equal(p.carrotsEaten, 0);
});

test('Nibo gets hungry over time', () => {
  const p = pet.createPet(0);
  const later = pet.tick(p, 4 * 60 * MIN);
  assert.ok(later.fullness < pet.HUNGRY_BELOW, `fullness ${later.fullness}`);
  assert.equal(pet.moodOf(later), 'hungry');
});

test('time catch-up is capped and never goes negative', () => {
  const p = pet.tick(pet.createPet(0), 30 * 24 * 60 * MIN);
  assert.equal(p.fullness, 0);
  assert.ok(p.happiness >= 0);
});

test('feeding fills the tummy and cheers Nibo up', () => {
  const hungry = { fullness: 10, happiness: 20, carrotsEaten: 0, updatedAt: 0 };
  const { pet: fed, result } = pet.feed(hungry, 0);
  assert.equal(result, 'yum');
  assert.equal(fed.fullness, 32);
  assert.equal(fed.happiness, 35);
  assert.equal(fed.carrotsEaten, 1);
});

test('a stuffed bunny refuses more carrots', () => {
  const full = { fullness: 99, happiness: 50, carrotsEaten: 3, updatedAt: 0 };
  const { pet: after, result } = pet.feed(full, 0);
  assert.equal(result, 'stuffed');
  assert.equal(after.carrotsEaten, 3);
  assert.equal(after.fullness, 99);
});

test('garbage saved state is repaired', () => {
  const p = pet.normalize({ fullness: 'lots', happiness: 500, carrotsEaten: -4 }, 123);
  assert.equal(p.fullness, 70);
  assert.equal(p.happiness, 100);
  assert.equal(p.carrotsEaten, 0);
  assert.equal(p.updatedAt, 123);
});
