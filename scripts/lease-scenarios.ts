/* 租约协议场景自测：覆盖领取、心跳失败回滚、候补按序号接管、待合并/重放规则 */
import assert from "node:assert";
import { acquire, heartbeat, isPublic, leaseAlive, LEASE_TTL_MS, nextHolder, orderOpsForReplay, recalcTimerForPending, release, sweep } from "../src/store/leaseEngine";
import type { CatalogOp, Evidence } from "../src/types";

let t = 1_000_000;
const T = () => t;
const pass = (name: string) => console.log(`PASS ${name}`);

// 1. 按角色领取：无租约直接领取；他人持有时进入候补，不覆盖
let s = acquire({ deviceId: "clerk", lease: null, waitlist: [], catalogRevision: 0, now: T() });
assert.equal(s.acquired, true);
assert.equal(s.lease!.epoch, 1);
assert.equal(s.lease!.holderId, "clerk");
s = acquire({ deviceId: "judge", lease: s.lease, waitlist: s.waitlist, catalogRevision: 0, now: T() });
assert.equal(s.acquired, false);
assert.equal(s.position, 1);
assert.equal(s.lease!.holderId, "clerk");
pass("领取：空缺席位直接领取，占用时按序号候补，不覆盖现租约");

// 2. 心跳续租
const renewed = heartbeat({ ...s.lease!, heartbeatAt: T() }, "clerk", T() + 1000);
assert.equal(renewed!.heartbeatAt, T() + 1000);
assert.equal(heartbeat(renewed, "judge", T() + 2000)!.heartbeatAt, T() + 1000);
pass("心跳：只有持有者能刷新");

// 3. 心跳失败回滚 + 候补按序号接管
const expiredLease = { ...renewed!, heartbeatAt: T() };
assert.equal(leaseAlive(expiredLease, T() + LEASE_TTL_MS), true);
assert.equal(leaseAlive(expiredLease, T() + LEASE_TTL_MS + 1), false);
const online = new Set(["clerk", "judge"]);
let swept = sweep({ lease: expiredLease, waitlist: s.waitlist, onlineIds: online, catalogRevision: 3, now: T() + LEASE_TTL_MS + 1 });
assert.equal(swept.rolledBack, true);
assert.equal(swept.takeoverId, "judge");
assert.equal(swept.lease!.epoch, 2);
assert.equal(swept.lease!.baseRevision, 3);
assert.equal(swept.waitlist.length, 0);
pass("心跳失败：TTL 后回滚旧租约，候补首位接管，epoch 递增并锚定修订号");

// 4. 候补按序号：离线候补跳过，由在线的下一位接管
const wl = [{ deviceId: "judge", seq: 1, requestedAt: 1 }, { deviceId: "judge2", seq: 2, requestedAt: 2 }];
const picked = nextHolder(wl, new Set(["judge2"]), T());
assert.equal(picked!.deviceId, "judge2");
pass("候补接管：队首离线时顺延到下一个在线候补");

// 5. 主动释放也按序号接管
let rel = release({ lease: swept.lease, waitlist: [{ deviceId: "clerk", seq: 1, requestedAt: 1 }], onlineIds: new Set(["clerk", "judge"]), catalogRevision: 5, now: T() + 9000 });
assert.equal(rel.takeoverId, "clerk");
assert.equal(rel.lease!.epoch, 3);
rel = release({ lease: rel.lease, waitlist: [], onlineIds: new Set(["clerk"]), catalogRevision: 5, now: T() + 10000 });
assert.equal(rel.lease, null);
pass("释放：回滚旧租约并让候补接管；无候补时租约空缺");

// 6. 重放排序：旧 epoch 先；同 epoch 按修订号；同证据遮罩开启先于展示
const op = (patch: Partial<CatalogOp>): CatalogOp => ({
  id: patch.id ?? Math.random().toString(36).slice(2),
  type: patch.type ?? "show",
  evidenceId: patch.evidenceId ?? "e1",
  originDeviceId: "d",
  originEpoch: patch.originEpoch ?? 1,
  revision: patch.revision ?? 1,
  baseRevision: 0,
  baseOrderRevision: 0,
  createdAt: 1,
  ...patch
});
const ordered = orderOpsForReplay([
  op({ id: "a", type: "show", originEpoch: 2, revision: 1 }),
  op({ id: "b", type: "setSensitive", value: true, originEpoch: 2, revision: 1 }),
  op({ id: "c", type: "show", originEpoch: 1, revision: 2 }),
  op({ id: "d", type: "reorder", originEpoch: 1, revision: 1 }),
  op({ id: "e", type: "setSensitive", value: false, originEpoch: 2, revision: 1 })
]).map((o) => o.id);
assert.deepEqual(ordered, ["d", "c", "b", "e", "a"]);
pass("重放排序：epoch 优先，同 epoch 按修订号，同证据遮罩开启先于展示");

// 7. 已公开判定
const mk = (status: Evidence["status"]): Evidence => ({ id: "e", exhibitNo: "x", title: "t", type: "书证", duration: 1, presenter: "原告", sensitive: false, status, note: "" });
assert.equal(isPublic(mk("展示中")), true);
assert.equal(isPublic(mk("已展示")), true);
assert.equal(isPublic(mk("待展示")), false);
pass("公开判定：展示中/已展示视为已经公开");

// 8. 顺序改动后未展示项计时立即重算
const evidence: Evidence[] = [
  { ...mk("待展示"), id: "a", duration: 8 },
  { ...mk("展示中"), id: "b", duration: 12 },
  { ...mk("待展示"), id: "c", duration: 10 }
];
assert.equal(recalcTimerForPending(evidence, "a", 480), 480); // 当前为待展示：按新 duration 重算
assert.equal(recalcTimerForPending(evidence, "b", 321), 321); // 展示中：保留剩余计时
assert.equal(recalcTimerForPending(evidence, null, 100), 100);
pass("计时重算：未展示项随顺序重算，展示中项计时不受影响");

console.log("ALL LEASE ENGINE SCENARIOS PASSED");
