/* 端到端：书记员断网旧端操作 → 心跳失败回滚 → 法官候补接管 → 回网重放合并/跳过 */
import assert from "node:assert";
import { configureStore } from "@reduxjs/toolkit";
import reducer, {
  acquireControl,
  hydrate,
  releaseControl,
  setActiveDevice,
  setDeviceOnline,
  submitOp,
  tick,
  type CourtState
} from "../src/store/courtSlice";

const pass = (name: string) => console.log(`PASS ${name}`);

const store = configureStore({ reducer: { court: reducer } });
const dispatch = store.dispatch;
const get = (): CourtState => store.getState().court;

// 可控时钟：心跳 TTL、回网判定都依赖当前时间
let virtual = Date.now();
const realNow = Date.now;
Date.now = () => virtual;

dispatch(hydrate(null));
const fresh = get();
const clerk = fresh.devices.find((d) => d.role === "书记员")!;
const judge = fresh.devices.find((d) => d.role === "法官")!;
assert.equal(fresh.lease!.holderId, clerk.id);
assert.equal(fresh.lease!.epoch, 1);
pass("初始化：书记员按角色持有默认控制权 epoch 1");

// 法官按序号候补
dispatch(setActiveDevice(judge.id));
dispatch(acquireControl());
assert.equal(get().waitlist[0].deviceId, judge.id);
assert.equal(get().lease!.holderId, clerk.id);

// 书记员断网：旧端操作停在待合并区（改顺序、开遮罩、展示）
dispatch(setActiveDevice(clerk.id));
dispatch(setDeviceOnline({ id: clerk.id, online: false }));
const ids = get().evidence.map((e) => e.id);
dispatch(submitOp({ type: "reorder", order: [...ids.slice(1), ids[0]] }));
dispatch(submitOp({ type: "setSensitive", evidenceId: "e2", value: true }));
dispatch(submitOp({ type: "show", evidenceId: "e1" }));
assert.equal(get().pendingOps.length, 3);
assert.deepEqual(get().evidence.map((e) => e.id), ids, "断网期间目录不被旧端改动");
pass("断网旧端：操作停在待合并区，不覆盖目录");

// 心跳失败：虚拟时间越过 TTL 后回滚旧租约，法官按序号接管
virtual = get().lease!.heartbeatAt + 6000;
dispatch(tick());
assert.ok(get().lease!.holderId === judge.id, `期望法官接管，实际 ${get().lease?.holderId}`);
assert.equal(get().lease!.epoch, 2);
assert.equal(get().waitlist.length, 0);
pass("心跳失败：旧租约回滚，法官候补按序号接管 epoch 2");

// 切到法官席位实时操作：把 e1 直接展示（公开），并改一次证据顺序（抬高 orderRevision）
dispatch(setActiveDevice(judge.id));
virtual += 1000;
dispatch(tick());
dispatch(submitOp({ type: "show", evidenceId: "e1" }));
const evidenceNow = get().evidence;
assert.equal(evidenceNow.find((e) => e.id === "e1")!.status, "展示中");
const reordered = [...evidenceNow.map((e) => e.id)].reverse();
dispatch(submitOp({ type: "reorder", order: reordered }));
assert.equal(get().orderRevision, 1);
assert.equal(get().lease!.epoch, 2);
pass("新控制端：实时展示 e1 并更新证据顺序（修订号递增）");

// 书记员回网：按租约与修订号重放 —— 旧 reorder 冲突跳过；旧 show 因已公开跳过；遮罩合并
dispatch(setDeviceOnline({ id: clerk.id, online: true }));
const after = get();
assert.equal(after.pendingOps.length, 0, "待合并区应清空");
const merged = after.mergeLog.filter((m) => m.kind === "merged").map((m) => m.action);
const skipped = after.mergeLog.filter((m) => m.kind === "skipped").map((m) => m.detail);
assert.ok(merged.some((a) => a.includes("开启敏感遮罩")), `遮罩应合并: ${JSON.stringify(merged)}`);
assert.ok(skipped.some((d) => d.includes("已经公开") && d.includes("展示")), `旧展示应跳过: ${JSON.stringify(skipped)}`);
assert.ok(skipped.some((d) => d.includes("顺序已被更新")), `旧顺序应跳过: ${JSON.stringify(skipped)}`);
assert.equal(after.evidence.find((e) => e.id === "e2")!.sensitive, true);
assert.equal(after.evidence.find((e) => e.id === "e1")!.status, "展示中");
assert.deepEqual(after.evidence.map((e) => e.id), reordered, "新顺序不被旧端覆盖");
pass("回网重放：遮罩合并、旧展示因已公开跳过、旧顺序冲突跳过，目录不被覆盖");

// 重放后书记员不再是持有者，目录操作被门禁拒绝（用一个本会被幂等跳过的操作来隔离门禁层）
const revAfterReplay = get().catalogRevision;
dispatch(submitOp({ type: "show", evidenceId: "missing-evidence" }));
assert.equal(get().catalogRevision, revAfterReplay, "无租约实时操作被门禁拒绝");
assert.equal(get().waitlist.some((w) => w.deviceId === clerk.id), true, "回网后自动进入候补");
pass("重放后门禁：非持有者操作拒绝并自动候补");

// 顺序改动后未展示项计时立即重算（待展示项随新 duration）
dispatch(setActiveDevice(judge.id));
const current = get().evidence.find((e) => e.status === "待展示")!;
dispatch(submitOp({ type: "select", evidenceId: current.id }));
const timerBefore = get().session.timerSeconds;
assert.equal(timerBefore, current.duration * 60);
const order2 = [...get().evidence.map((e) => e.id)];
order2.reverse();
dispatch(submitOp({ type: "reorder", order: order2 }));
assert.equal(get().session.timerSeconds, current.duration * 60, "当前仍是同一条待展示项，计时按其 duration 重算");
pass("顺序改动：未展示项计时立即重算");

// 主动释放：候补书记员接管
dispatch(releaseControl());
assert.equal(get().lease!.holderId, clerk.id);
assert.equal(get().lease!.epoch, 3);
pass("释放：书记员作为候补首位按序号接管 epoch 3");

Date.now = realNow;
console.log("ALL SLICE E2E SCENARIOS PASSED");
