import { test } from "node:test";
import assert from "node:assert/strict";
import { planRounds, showState, seededRandom, ROUND_MS, MAX_ROUNDS, DIM_MS } from "../src/fireworks-plan.js";

const prs = (count) => Array.from({ length: count }, (_, i) => i + 1);
const AT = 1_800_000_000_000;

test("one round per PR, and a last round for the others", () => {
  assert.equal(planRounds(prs(1), 0).length, 1);
  assert.equal(planRounds(prs(5), 0).length, 5);
  const six = planRounds(prs(5), 1);
  assert.equal(six.length, 6);
  assert.equal(six[5].label, "+ 1 more");
  const many = planRounds(prs(5), 395);
  assert.equal(many.length, MAX_ROUNDS + 1);
  assert.equal(many[5].label, "+ 395 more");
});

test("the label is the PR number only (no login: ADR 014)", () => {
  assert.equal(planRounds([65], 0)[0].label, "PR #65");
});

test("never more than MAX_ROUNDS PR rounds, even if more are sent", () => {
  assert.equal(planRounds(prs(9), 0).length, MAX_ROUNDS);
});

test("bad input gives no rounds", () => {
  assert.deepEqual(planRounds(null, 0), []);
  assert.deepEqual(planRounds([], 0), []);
  assert.equal(planRounds([], 3).length, 1); // only "+ 3 more"
});

test("rounds follow each other by the room's clock", () => {
  const rounds = planRounds(prs(3), 0);
  assert.deepEqual(showState(rounds, AT, AT), { running: true, round: 0, t: 0, dim: 1 });
  const mid = showState(rounds, AT, AT + ROUND_MS * 1.5);
  assert.equal(mid.round, 1);
  assert.ok(Math.abs(mid.t - 0.5) < 1e-9);
  const last = showState(rounds, AT, AT + ROUND_MS * 3 - 1);
  assert.equal(last.round, 2);
  assert.ok(last.running);
});

test("not running before it starts or after it ends", () => {
  const rounds = planRounds(prs(2), 0);
  assert.equal(showState(rounds, AT, AT - 1).running, false);
  assert.equal(showState(rounds, AT, AT + ROUND_MS * 2).running, false);
  assert.equal(showState([], AT, AT).running, false);
  assert.equal(showState(rounds, AT, AT + ROUND_MS * 2 + DIM_MS).dim, 0);
});

test("the light dims before the first round and comes back after the last", () => {
  const rounds = planRounds(prs(1), 0);
  assert.equal(showState(rounds, AT, AT - DIM_MS - 1).dim, 0);
  assert.ok(Math.abs(showState(rounds, AT, AT - DIM_MS / 2).dim - 0.5) < 1e-9);
  assert.equal(showState(rounds, AT, AT + ROUND_MS / 2).dim, 1);
  assert.ok(Math.abs(showState(rounds, AT, AT + ROUND_MS + DIM_MS / 2).dim - 0.5) < 1e-9);
});

test("the same seed gives the same sequence, another seed another one", () => {
  const a = seededRandom(65), b = seededRandom(65), c = seededRandom(66);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()], seqC = [c(), c(), c()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const x of seqA) assert.ok(x >= 0 && x < 1);
});

test("each round has its own seed", () => {
  const rounds = planRounds(prs(3), 2);
  assert.equal(new Set(rounds.map((r) => r.seed)).size, rounds.length);
});
