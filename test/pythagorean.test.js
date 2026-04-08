const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculatePythagoreanWinPct,
  DEFAULT_EXPONENT,
} = require("../lib/pythagorean");

test("returns 0.5 when runs scored equals runs allowed", () => {
  const value = calculatePythagoreanWinPct(100, 100, DEFAULT_EXPONENT);
  assert.equal(value, 0.5);
});

test("returns 0 when both runs are zero", () => {
  const value = calculatePythagoreanWinPct(0, 0);
  assert.equal(value, 0);
});

test("returns expected rounded value", () => {
  const value = calculatePythagoreanWinPct(53, 35, 1.83);
  assert.equal(value, 0.681);
});

test("throws on negative runs", () => {
  assert.throws(() => calculatePythagoreanWinPct(-1, 10), /zero or greater/);
});
