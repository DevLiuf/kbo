const test = require("node:test");
const assert = require("node:assert/strict");
const { planCollection, collectIfDue } = require("../scripts/auto-collect-pregame");
const game = (id, time, extra = {}) => ({ G_DT: "20261003", G_ID: id, G_TM: time, GAME_STATE_SC: "1", SR_ID: "0", CANCEL_SC_ID: "0", CANCEL_SC_NM: "정상경기", ...extra });

test("official start times create only six pregame slots and shared starts do not duplicate requests", () => {
  const plan = planCollection([game("a", "14:00"), game("b", "14:00"), game("c", "14:10")], new Date("2026-10-03T03:00:00+09:00"));
  assert.deepEqual(plan.slots, ["04:30", "04:35", "04:40", "04:45", "04:50", "04:55", "05:00", "05:05"].map((time) => `2026-10-03T${time}:00.000Z`));
  assert.deepEqual(plan.dueGameIds, []);
});

test("late planning and rescheduled starts never recreate past slots", () => {
  const now = new Date("2026-10-03T13:42:00+09:00");
  const plan = planCollection([game("a", "14:00"), game("b", "14:30")], now);
  assert.deepEqual(plan.dueGameIds, ["a"]);
  assert.equal(plan.slots[0], "2026-10-03T04:45:00.000Z");
  const changed = planCollection([game("a", "14:30")], now);
  assert.deepEqual(changed.dueGameIds, []);
  assert.deepEqual(changed.slots, ["05:00", "05:05", "05:10", "05:15", "05:20", "05:25"].map((time) => `2026-10-03T${time}:00.000Z`));
});

test("started, finished, cancelled, postseason and empty schedules never cause collection", () => {
  const plan = planCollection([game("a", "14:00", { GAME_STATE_SC: "2" }), game("b", "14:00", { GAME_STATE_SC: "3" }), game("c", "14:00", { CANCEL_SC_NM: "우천취소" }), game("d", "14:00", { SR_ID: "1" }), game("e", "13:30")], new Date("2026-10-03T13:30:00+09:00"));
  assert.deepEqual(plan.windows, []);
  assert.deepEqual(plan.slots, []);
  assert.equal(planCollection([], new Date("2026-10-02T15:01:00Z")).date, "20261003");
  assert.throws(() => planCollection([game("bad", "미정")], new Date("2026-10-03T03:00:00+09:00")), /invalid game time/);
  assert.throws(() => planCollection([game("bad", "14:00", { G_DT: "20261002" })], new Date("2026-10-03T03:00:00+09:00")), /mismatch/);
});

test("the final clock check rejects early and late launches, including a crossed start during registration", async () => {
  const plan = planCollection([game("a", "14:00")], new Date("2026-10-03T13:29:00+09:00"));
  let count = 0;
  const run = async () => { count += 1; };
  for (const [time, expected] of [["13:29:59", false], ["13:30:00", true], ["13:59:59", true], ["14:00:00", false]]) {
    assert.equal(await collectIfDue(plan, { clock: () => new Date(`2026-10-03T${time}+09:00`), run }), expected);
  }
  assert.equal(count, 2);
});
