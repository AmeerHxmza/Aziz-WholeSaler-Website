import assert from 'node:assert/strict';
import test from 'node:test';
import {
  amount,
  averageCost,
  businessDate,
  dateRange,
  lineAmount,
  quantity,
  roundMoney,
  roundQuantity
} from '../src/lib/calculations';

test('money is rounded symmetrically to paisa', () => {
  assert.equal(roundMoney(10.005), 10.01);
  assert.equal(roundMoney(-10.005), -10.01);
  assert.equal(amount('10.25'), 10.25);
  assert.throws(() => amount('10.251'), /2 decimal places/);
});

test('line amounts preserve the supported half-paisa rule', () => {
  assert.equal(lineAmount(0.5, 20.15), 10.08);
  assert.equal(lineAmount(0.25, 20.15), 5.04);
  assert.equal(lineAmount(3, 7.13), 21.39);
  assert.equal(lineAmount(1, 0.005), 0.01);
});

test('quantity precision and boundaries match the desktop rules', () => {
  assert.equal(quantity('1.250'), 1.25);
  assert.equal(roundQuantity(1.23456), 1.235);
  assert.throws(() => quantity('0'), /valid quantity/);
  assert.throws(() => quantity('0.0001'), /3 decimal places/);
  assert.equal(quantity('0', true), 0);
});

test('moving weighted-average cost retains six decimal places', () => {
  assert.equal(averageCost(10, 100, 10, 120), 110);
  assert.equal(averageCost(1, 7.13, 1, 7.14), 7.135);
});

test('business dates reject impossible dates and reversed ranges', () => {
  assert.equal(businessDate('2026-09-08'), '2026-09-08');
  assert.throws(() => businessDate('2026-02-30'), /valid date/);
  assert.throws(() => dateRange('2026-09-09', '2026-09-08'), /on or before/);
});
