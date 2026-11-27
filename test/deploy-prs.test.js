import { test } from "node:test";
import assert from "node:assert/strict";
import { deployPrs, showOf, CELEBRATE_WINDOW_MS, SHOW_LEAD_MS } from "../worker/deploy-prs.js";

const NOW = 1_800_000_000_000;
const pr = (n, login = "dev" + n) => ({ login, n });

test("first run: nothing is celebrated and every merged PR is seen", () => {
  const { celebrate, stored } = deployPrs(undefined, [pr(1), pr(2)], "v1", NOW, NOW);
  assert.deepEqual(celebrate, []);
  assert.deepEqual(stored, { v: "v1", seen: [1, 2] });
});

test("first run with a first-seen time already written by a connection: still nothing is celebrated", () => {
  const { celebrate, stored } = deployPrs(undefined, [pr(1)], "v1", NOW - 3000, NOW);
  assert.deepEqual(celebrate, []);
  assert.deepEqual(stored.seen, [1]);
});

test("same version: nothing changes", () => {
  const before = { v: "v1", seen: [1] };
  const { celebrate, stored } = deployPrs(before, [pr(1), pr(2)], "v1", NOW, NOW);
  assert.deepEqual(celebrate, []);
  assert.deepEqual(stored, before);
});

test("new version with 2 new PRs: both are celebrated and seen", () => {
  const { celebrate, stored } = deployPrs({ v: "v1", seen: [1] }, [pr(3), pr(1), pr(2)], "v2", NOW, NOW);
  assert.deepEqual(celebrate, [3, 2]);
  assert.deepEqual(stored, { v: "v2", seen: [1, 3, 2] });
});

test("the connection wrote the first-seen time just before the read: it still celebrates", () => {
  const { celebrate } = deployPrs({ v: "v1", seen: [] }, [pr(7)], "v2", NOW - 5000, NOW);
  assert.deepEqual(celebrate, [7]);
});

test("new version read after the window: nothing is celebrated, the PRs are seen", () => {
  const late = NOW - CELEBRATE_WINDOW_MS - 1;
  const { celebrate, stored } = deployPrs({ v: "v1", seen: [1] }, [pr(1), pr(2)], "v2", late, NOW);
  assert.deepEqual(celebrate, []);
  assert.deepEqual(stored, { v: "v2", seen: [1, 2] });
});

test("bad entries are dropped, duplicates kept once, and only PR numbers come out (no login: ADR 014)", () => {
  const merged = [
    pr(5, "MathzBrk"),
    pr(5, "MathzBrk"),
    pr(6, "bad login!"),
    pr(7, "x".repeat(40)),
    { login: "ok", n: 1.5 },
    { login: "ok", n: -2 },
    { login: 42, n: 8 },
    null,
  ];
  const { celebrate, stored } = deployPrs({ v: "v1", seen: [] }, merged, "v2", NOW, NOW);
  assert.deepEqual(celebrate, [5]);
  assert.deepEqual(stored.seen, [5]);
});

test("new version with no new PRs: nothing is celebrated and the version moves on", () => {
  const { celebrate, stored } = deployPrs({ v: "v1", seen: [1] }, [pr(1)], "v2", NOW, NOW);
  assert.deepEqual(celebrate, []);
  assert.deepEqual(stored, { v: "v2", seen: [1] });
});

test("a broken stored value counts as a first run", () => {
  const { celebrate, stored } = deployPrs({ v: 3, seen: "x" }, [pr(1)], "v2", NOW, NOW);
  assert.deepEqual(celebrate, []);
  assert.deepEqual(stored, { v: "v2", seen: [1] });
});

test("showOf caps the show at 5 PRs and counts the rest", () => {
  for (const [count, len, more] of [[1, 1, 0], [5, 5, 0], [6, 5, 1], [60, 5, 55]]) {
    const all = Array.from({ length: count }, (_, i) => i + 1);
    const show = showOf(all, NOW);
    assert.equal(show.at, NOW + SHOW_LEAD_MS);
    assert.equal(show.prs.length, len);
    assert.equal(show.more, more);
    assert.deepEqual(show.prs, all.slice(0, 5));
  }
});
