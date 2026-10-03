import type { CatalogOp, Evidence, Lease, WaitEntry } from "../types";

/** 租约心跳有效期：超过该时长没有心跳即判定心跳失败 */
export const LEASE_TTL_MS = 5000;
/** 公开状态：已经公开的证据，旧操作一律跳过 */
const PUBLIC_STATUS: ReadonlySet<Evidence["status"]> = new Set(["展示中", "已展示"]);

export function nowTs(): number {
  return Date.now();
}

export function leaseAlive(lease: Lease | null, now = nowTs()): boolean {
  return !!lease && now - lease.heartbeatAt <= lease.ttlMs;
}

/**
 * 候补按序号接管：租约空缺时，候补队列最靠前的在线设备获得新租约。
 * 返回 null 表示没有可接管者。
 */
export function nextHolder(waitlist: WaitEntry[], onlineIds: ReadonlySet<string>, now = nowTs()): WaitEntry | null {
  return waitlist.filter((entry) => onlineIds.has(entry.deviceId)).sort((a, b) => a.seq - b.seq)[0] ?? null;
}

/**
 * 设备领取控制权：
 * - 当前无有效租约：直接领取（升级补默认控制权也走这里）
 * - 自己是当前持有者：刷新心跳（续租）
 * - 已有其他持有者：按序号进入候补队列，不覆盖现有租约
 */
export function acquire(params: {
  deviceId: string;
  lease: Lease | null;
  waitlist: WaitEntry[];
  catalogRevision: number;
  now?: number;
}): { lease: Lease | null; waitlist: WaitEntry[]; acquired: boolean; position: number } {
  const now = params.now ?? nowTs();
  const alive = leaseAlive(params.lease, now);
  if (alive && params.lease!.holderId === params.deviceId) {
    return {
      lease: { ...params.lease!, heartbeatAt: now },
      waitlist: params.waitlist,
      acquired: true,
      position: 0
    };
  }
  if (!alive) {
    return {
      lease: { holderId: params.deviceId, epoch: (params.lease?.epoch ?? 0) + 1, baseRevision: params.catalogRevision, seq: 0, heartbeatAt: now, ttlMs: LEASE_TTL_MS },
      waitlist: params.waitlist.filter((entry) => entry.deviceId !== params.deviceId),
      acquired: true,
      position: 0
    };
  }
  if (params.waitlist.some((entry) => entry.deviceId === params.deviceId)) {
    const sorted = [...params.waitlist].sort((a, b) => a.seq - b.seq);
    return { lease: params.lease, waitlist: params.waitlist, acquired: false, position: sorted.findIndex((entry) => entry.deviceId === params.deviceId) + 1 };
  }
  const seq = params.waitlist.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
  const entry: WaitEntry = { deviceId: params.deviceId, seq, requestedAt: now };
  const waitlist = [...params.waitlist, entry].sort((a, b) => a.seq - b.seq);
  return { lease: params.lease, waitlist, acquired: false, position: waitlist.findIndex((item) => item.deviceId === params.deviceId) + 1 };
}

/** 主动释放：回滚旧租约，由候补队列首位在线者接管（epoch 递增） */
export function release(params: {
  lease: Lease | null;
  waitlist: WaitEntry[];
  onlineIds: ReadonlySet<string>;
  catalogRevision: number;
  now?: number;
}): { lease: Lease | null; waitlist: WaitEntry[]; takeoverId: string | null } {
  const now = params.now ?? nowTs();
  const promoted = nextHolder(params.waitlist, params.onlineIds, now);
  if (promoted) {
    return {
      lease: { holderId: promoted.deviceId, epoch: (params.lease?.epoch ?? 0) + 1, baseRevision: params.catalogRevision, seq: 0, heartbeatAt: now, ttlMs: LEASE_TTL_MS },
      waitlist: params.waitlist.filter((entry) => entry.deviceId !== promoted.deviceId),
      takeoverId: promoted.deviceId
    };
  }
  return { lease: null, waitlist: params.waitlist, takeoverId: null };
}

/**
 * 心跳巡检：心跳失败（TTL 超时）后回滚旧租约，候补按序号接管。
 */
export function sweep(params: {
  lease: Lease | null;
  waitlist: WaitEntry[];
  onlineIds: ReadonlySet<string>;
  catalogRevision: number;
  now?: number;
}): { lease: Lease | null;
  waitlist: WaitEntry[];
  rolledBack: boolean;
  takeoverId: string | null } {
  const now = params.now ?? nowTs();
  if (leaseAlive(params.lease, now)) {
    return { lease: params.lease, waitlist: params.waitlist, rolledBack: false, takeoverId: null };
  }
  if (!params.lease) {
    return { lease: null, waitlist: params.waitlist, rolledBack: false, takeoverId: null };
  }
  const result = release({ ...params, now });
  return { ...result, rolledBack: true };
}

/** 心跳：只有当前持有者可以刷新 */
export function heartbeat(lease: Lease | null, deviceId: string, now = nowTs()): Lease | null {
  if (lease && lease.holderId === deviceId) return { ...lease, heartbeatAt: now };
  return lease;
}

/**
 * 回网重放排序：
 * 1. 先按租约代号 epoch（旧租约的操作整体先于新租约）
 * 2. 同租约内按修订号（seq/revision）
 * 3. 同一证据：遮罩开启（setSensitive=true）先于展示（show）生效，
 *    避免"先公开后补遮罩"
 */
export function orderOpsForReplay(ops: CatalogOp[]): CatalogOp[] {
  const rank = (op: CatalogOp): number => {
    if (op.type === "setSensitive" && op.value === true) return 0;
    if (op.type === "setSensitive") return 1;
    if (op.type === "show") return 2;
    return 3;
  };
  return [...ops].sort((a, b) => a.originEpoch - b.originEpoch || a.revision - b.revision || rank(a) - rank(b));
}

export function isPublic(item: Evidence | undefined): boolean {
  return !!item && PUBLIC_STATUS.has(item.status);
}

/** 顺序变化后对"未展示项"立即重算计时：展示中/已展示/已跳过的证据计时不受影响 */
export function recalcTimerForPending(evidence: Evidence[], currentId: string | null, currentTimer: number): number {
  const current = evidence.find((item) => item.id === currentId);
  if (current && current.status === "待展示") return current.duration * 60;
  return currentTimer;
}
