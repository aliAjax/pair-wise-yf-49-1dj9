import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  CatalogOp,
  CatalogOpType,
  DeviceInfo,
  Evidence,
  Lease,
  MergeLogEntry,
  Objection,
  Role,
  SessionPhase,
  SessionState,
  TimelineEntry,
  WaitEntry
} from "../types";
import { LEASE_TTL_MS, acquire, heartbeat, isPublic, nextHolder, nowTs, orderOpsForReplay, recalcTimerForPending, sweep } from "./leaseEngine";

const seedEvidence: Evidence[] = [
  { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定" },
  { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩" },
  { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45" }
];
const seedSession: SessionState = { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制" };

export interface CourtState {
  initialized: boolean;
  devices: DeviceInfo[];
  activeDeviceId: string;
  lease: Lease | null;
  waitlist: WaitEntry[];
  /** 旧端断网期间的操作：停在待合并区 */
  pendingOps: CatalogOp[];
  /** 合并审计：重放、跳过、租约变更 */
  mergeLog: MergeLogEntry[];
  /** 目录修订号：每次落地的目录操作递增 */
  catalogRevision: number;
  /** 顺序修订号：重放旧 reorder 时用于冲突判定 */
  orderRevision: number;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: { id: string; label: string; time: string; evidence: Evidence[]; phase: SessionPhase; currentEvidenceId: string | null }[];
  session: SessionState;
}

/** 持久化文档形态（与 localStorage 中结构一致） */
export type CourtDoc = Omit<CourtState, "initialized">;

function seedDevices(): DeviceInfo[] {
  return [
    { id: "d1", label: "书记员席位", role: "书记员", online: true, believedEpoch: 1 },
    { id: "d2", label: "法官席位", role: "法官", online: true, believedEpoch: null }
  ];
}

function seedState(): CourtState {
  return {
    initialized: false,
    devices: seedDevices(),
    activeDeviceId: "d1",
    lease: { holderId: "d1", epoch: 1, baseRevision: 0, seq: 0, heartbeatAt: nowTs(), ttlMs: LEASE_TTL_MS },
    waitlist: [],
    pendingOps: [],
    mergeLog: [{ id: crypto.randomUUID(), time: new Date().toISOString(), kind: "lease", deviceId: "d1", action: "默认控制权", detail: "书记员席位按角色领取控制权租约" }],
    catalogRevision: 0,
    orderRevision: 0,
    evidence: seedEvidence,
    objections: [{ id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString() }],
    timeline: [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
    snapshots: [],
    session: seedSession
  };
}

const initialState: CourtState = seedState();

function addEntry(state: CourtState, actor: TimelineEntry["actor"], action: string, detail: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, detail });
}

function addMerge(state: CourtState, kind: MergeLogEntry["kind"], action: string, detail: string, deviceId?: string) {
  state.mergeLog.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), kind, action, detail, deviceId });
  state.mergeLog = state.mergeLog.slice(0, 50);
}

function onlineIds(state: CourtState): Set<string> {
  return new Set(state.devices.filter((device) => device.online).map((device) => device.id));
}

const OP_LABEL: Record<CatalogOpType, string> = {
  reorder: "调整证据顺序",
  select: "切换展示证据",
  show: "开始展示",
  complete: "完成质证",
  setSensitive: "设置敏感遮罩"
};

function opLabel(op: { type: CatalogOpType; evidenceId?: string; value?: boolean }, evidence: Evidence[]): string {
  if (op.type === "reorder") return "调整证据顺序";
  const item = evidence.find((entry) => entry.id === op.evidenceId);
  const name = item ? `${item.exhibitNo} ${item.title}` : "证据";
  if (op.type === "setSensitive") return `${op.value ? "开启" : "关闭"}敏感遮罩 · ${name}`;
  return `${OP_LABEL[op.type]} · ${name}`;
}

/**
 * 把一条目录操作落到证据目录。live=当前持有租约的实时操作；replay=旧端回网重放。
 * 重放带幂等/冲突门禁，实时操作已由 submitOp 的租约门禁保证权威。
 */
function applyOp(state: CourtState, op: CatalogOp, source: "live" | "replay"): { applied: boolean; reason?: string } {
  const item = op.evidenceId ? state.evidence.find((entry) => entry.id === op.evidenceId) : undefined;
  const current = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId);

  if (op.type === "reorder" && op.order) {
    // 回网重放：旧顺序基于的顺序修订号已过期（新控制端已改过顺序）则跳过，不覆盖新顺序
    if (source === "replay" && op.baseOrderRevision !== state.orderRevision) {
      return { applied: false, reason: "证据顺序已被更新的控制租约修改，旧顺序操作跳过" };
    }
    const byId = new Map(state.evidence.map((entry) => [entry.id, entry]));
    const next: Evidence[] = [];
    for (const id of op.order) {
      const found = byId.get(id);
      if (found) {
        next.push(found);
        byId.delete(id);
      }
    }
    byId.forEach((entry) => next.push(entry));
    state.evidence = next;
    state.orderRevision += 1;
    // 证据顺序改动后，未展示项计时立即重算
    state.session.timerSeconds = recalcTimerForPending(state.evidence, state.session.currentEvidenceId, state.session.timerSeconds);
  } else if (op.type === "select") {
    if (!item) return { applied: false, reason: "证据不存在" };
    if (source === "replay" && isPublic(item)) return { applied: false, reason: "该证据已经公开，旧的选中操作跳过" };
    state.session.currentEvidenceId = item.id;
    state.session.timerSeconds = item.duration * 60;
  } else if (op.type === "show") {
    const target = item ?? current;
    if (!target) return { applied: false, reason: "证据不存在" };
    // 同一证据已经公开就跳过旧操作（幂等）
    if (isPublic(target)) return { applied: false, reason: "该证据已经公开，旧的展示操作跳过" };
    target.status = "展示中";
    state.session.currentEvidenceId = target.id;
    state.session.phase = "质证";
  } else if (op.type === "complete") {
    const target = item ?? current;
    if (!target) return { applied: false, reason: "证据不存在" };
    if (isPublic(target)) return { applied: false, reason: "该证据已经公开，旧的完成操作跳过" };
    target.status = "已展示";
    const next = state.evidence.find((entry) => entry.status === "待展示");
    state.session.currentEvidenceId = next?.id ?? null;
    state.session.timerSeconds = (next?.duration ?? 0) * 60;
    state.session.phase = next ? "举证" : "休庭";
  } else if (op.type === "setSensitive") {
    if (!item) return { applied: false, reason: "证据不存在" };
    if (source === "replay" && isPublic(item)) {
      // 已经公开的证据不再回改遮罩，避免旧端把公开内容的遮罩误关掉
      return { applied: false, reason: "该证据已经公开，旧遮罩操作跳过" };
    }
    item.sensitive = op.value === true;
  }

  state.catalogRevision += 1;
  return { applied: true };
}

export type SubmitOpInput =
  | { type: "reorder"; order: string[] }
  | { type: "select" | "show" | "complete"; evidenceId?: string }
  | { type: "setSensitive"; evidenceId: string; value: boolean };

/** 旧端回网：按租约代号和修订号重放它停在待合并区的操作 */
function flushPending(state: CourtState, device: DeviceInfo) {
  const mine = state.pendingOps.filter((op) => op.originDeviceId === device.id);
  if (!mine.length) {
    device.believedEpoch = null;
    return;
  }
  const epochNote = device.believedEpoch !== null && state.lease && device.believedEpoch < state.lease.epoch
    ? `（来自已回滚的旧租约 epoch ${device.believedEpoch}，当前 epoch ${state.lease.epoch}）`
    : "";
  for (const op of orderOpsForReplay(mine)) {
    const label = opLabel(op, state.evidence);
    const result = applyOp(state, op, "replay");
    if (result.applied) {
      addMerge(state, "merged", label, `回网重放合并 · 租约 epoch ${op.originEpoch} · 修订号 ${op.revision}${epochNote}`, device.id);
      addEntry(state, device.role, "回网重放", `${label}（租约${op.originEpoch} / 修订${op.revision}）`);
    } else {
      addMerge(state, "skipped", label, result.reason ?? "操作跳过", device.id);
      addEntry(state, device.role, "旧操作跳过", `${label}：${result.reason}`);
    }
  }
  state.pendingOps = state.pendingOps.filter((op) => op.originDeviceId !== device.id);
  device.believedEpoch = null;
}

function freshLease(holderId: string, epoch: number, catalogRevision: number): Lease {
  return { holderId, epoch, baseRevision: catalogRevision, seq: 0, heartbeatAt: nowTs(), ttlMs: LEASE_TTL_MS };
}

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    /** 载入本地文档；旧数据缺少租约和角色时升级：仍能打开，并由当前书记员补默认控制权 */
    hydrate(state, action: PayloadAction<Partial<CourtDoc> | null>) {
      if (state.initialized) return;
      const doc = action.payload;
      if (doc && doc.lease && Array.isArray(doc.devices) && doc.devices.length && doc.waitlist && doc.mergeLog) {
        Object.assign(state, doc, { initialized: true });
        const holder = state.devices.find((device) => device.id === state.lease?.holderId);
        // 同一浏览器重开：在线持有者的心跳顺延，离线旧持有者保持过期以便候补接管
        if (state.lease && holder?.online) state.lease.heartbeatAt = nowTs();
        addMerge(state, "lease", "文档已打开", "租约、角色与修订号随本地快照恢复");
        return;
      }
      const fresh = seedState();
      if (doc && Array.isArray(doc.evidence)) {
        // 旧版数据：仅含证据目录，没有租约/角色
        fresh.evidence = doc.evidence;
        fresh.objections = doc.objections ?? fresh.objections;
        fresh.timeline = doc.timeline ?? fresh.timeline;
        fresh.snapshots = doc.snapshots ?? [];
        fresh.session = { ...fresh.session, ...doc.session };
        fresh.mergeLog = [{
          id: crypto.randomUUID(),
          time: new Date().toISOString(),
          kind: "lease",
          deviceId: "d1",
          action: "旧数据升级",
          detail: "旧数据缺少租约和角色，已由当前书记员补上默认控制权（epoch 1）"
        }];
        addEntry(fresh, "书记员", "控制权补齐", "升级旧版文档：当前书记员按角色领取默认控制权租约");
      }
      Object.assign(state, fresh, { initialized: true });
    },
    setActiveDevice(state, action: PayloadAction<string>) {
      const device = state.devices.find((item) => item.id === action.payload);
      if (device) state.activeDeviceId = device.id;
    },
    setDeviceRole(state, action: PayloadAction<{ id: string; role: Role }>) {
      const device = state.devices.find((item) => item.id === action.payload.id);
      if (device) device.role = action.payload.role;
    },
    setDeviceOnline(state, action: PayloadAction<{ id: string; online: boolean }>) {
      const device = state.devices.find((item) => item.id === action.payload.id);
      if (!device || device.online === action.payload.online) return;
      device.online = action.payload.online;
      if (!action.payload.online) {
        // 断网瞬间：若它是当前持有者，记下自认的租约代号（旧租约）
        if (state.lease?.holderId === device.id) device.believedEpoch = state.lease.epoch;
        addEntry(state, device.role, "网络中断", "心跳停止，操作将停在待合并区");
      } else {
        // 回网：先按租约和修订号重放待合并操作
        const hadPending = state.pendingOps.some((op) => op.originDeviceId === device.id);
        flushPending(state, device);
        addEntry(state, device.role, "网络恢复", hadPending ? "已按租约与修订号重放待合并操作" : "回到协作同步");
        // 重放结束后重新参与控制权：空缺席位直接领取，否则按序号候补
        const result = acquire({ deviceId: device.id, lease: state.lease, waitlist: state.waitlist, catalogRevision: state.catalogRevision });
        state.lease = result.lease;
        state.waitlist = result.waitlist;
        if (result.acquired) {
          device.believedEpoch = result.lease!.epoch;
          addMerge(state, "lease", "重新持有控制权", `${device.label} 领取租约 epoch ${result.lease!.epoch}`, device.id);
        } else {
          addMerge(state, "lease", "进入候补", `${device.label} 回网后候补序号 ${result.position}`, device.id);
        }
      }
    },
    acquireControl(state, action: PayloadAction<string | undefined>) {
      const deviceId = action.payload ?? state.activeDeviceId;
      const device = state.devices.find((item) => item.id === deviceId);
      if (!device || !device.online) return;
      const before = state.lease;
      const result = acquire({ deviceId, lease: state.lease, waitlist: state.waitlist, catalogRevision: state.catalogRevision });
      state.lease = result.lease;
      state.waitlist = result.waitlist;
      if (result.acquired && (!before || before.holderId !== deviceId || before.epoch !== result.lease!.epoch)) {
        device.believedEpoch = result.lease!.epoch;
        addEntry(state, device.role, "领取控制权", `按角色领取证据目录租约 epoch ${result.lease!.epoch}`);
        addMerge(state, "lease", "租约领取", `${device.label} 持有 epoch ${result.lease!.epoch}（基于修订号 ${result.lease!.baseRevision}）`, deviceId);
      }
    },
    releaseControl(state, action: PayloadAction<string | undefined>) {
      const deviceId = action.payload ?? state.activeDeviceId;
      if (state.lease?.holderId !== deviceId) return;
      const device = state.devices.find((item) => item.id === deviceId);
      const result = nextHolder(state.waitlist, onlineIds(state));
      const released = state.lease;
      state.lease = result ? freshLease(result.deviceId, released.epoch + 1, state.catalogRevision) : null;
      state.waitlist = state.waitlist.filter((entry) => entry.deviceId !== (result?.deviceId ?? ""));
      if (device) device.believedEpoch = null;
      const taker = result ? state.devices.find((item) => item.id === result.deviceId) : undefined;
      addEntry(state, device?.role ?? "书记员", "释放控制权", taker ? `候补按序号接管：${taker.label}（epoch ${released.epoch + 1}）` : "租约已回滚，等待领取");
      addMerge(state, "lease", "释放并回滚租约", taker ? `${taker.label} 按候补序号接管 epoch ${released.epoch + 1}` : "无候补，租约空缺", deviceId);
      if (taker) {
        taker.believedEpoch = released.epoch + 1;
        addEntry(state, taker.role, "候补接管", `按序号取得证据目录租约 epoch ${released.epoch + 1}`);
      }
    },
    /**
     * 证据目录操作唯一入口：只认控制权租约。
     * - 在线持有者：实时落地
     * - 断网但自认持有旧租约：操作停在待合并区
     * - 其他（无租约/纯离线/候补）：直接拒绝
     */
    submitOp(state, action: PayloadAction<SubmitOpInput>) {
      const device = state.devices.find((item) => item.id === state.activeDeviceId);
      if (!device) return;
      const input = action.payload;
      const isHolder = state.lease?.holderId === device.id;

      if (!device.online && device.believedEpoch !== null) {
        const sameEpoch = state.pendingOps.filter((op) => op.originEpoch === device.believedEpoch);
        const op: CatalogOp = {
          id: crypto.randomUUID(),
          type: input.type,
          evidenceId: "evidenceId" in input ? input.evidenceId : undefined,
          order: input.type === "reorder" ? input.order : undefined,
          value: input.type === "setSensitive" ? input.value : undefined,
          originDeviceId: device.id,
          originEpoch: device.believedEpoch,
          revision: sameEpoch.length + 1,
          baseRevision: state.catalogRevision,
          baseOrderRevision: state.orderRevision,
          createdAt: nowTs()
        };
        state.pendingOps.push(op);
        addEntry(state, device.role, "操作进入待合并区", `${opLabel(op, state.evidence)}（旧租约${op.originEpoch} / 修订${op.revision}）`);
        return;
      }

      if (!device.online || !isHolder || !state.lease) return; // 门禁：无控制权不允许改目录
      const liveLease = state.lease;
      const revision = liveLease.seq + 1;
      const op: CatalogOp = {
        id: crypto.randomUUID(),
        type: input.type,
        evidenceId: "evidenceId" in input ? input.evidenceId : undefined,
        order: input.type === "reorder" ? input.order : undefined,
        value: input.type === "setSensitive" ? input.value : undefined,
        originDeviceId: device.id,
        originEpoch: liveLease.epoch,
        revision,
        baseRevision: state.catalogRevision,
        baseOrderRevision: state.orderRevision,
        createdAt: nowTs()
      };
      const result = applyOp(state, op, "live");
      if (!result.applied) return;
      liveLease.seq = revision;
      liveLease.baseRevision = state.catalogRevision;
      const label = opLabel(op, state.evidence);
      if (op.type === "reorder") addEntry(state, device.role, "调整证据顺序", "已更新举证顺序，未展示项计时立即重算");
      else if (op.type === "show") addEntry(state, device.role, "开始展示", label.split("·")[1]?.trim() ?? label);
      else if (op.type === "complete") addEntry(state, device.role, "完成质证", label.split("·")[1]?.trim() ?? label);
      else if (op.type === "setSensitive") addEntry(state, device.role, op.value ? "隐藏敏感内容" : "恢复公开内容", label.split("·")[1]?.trim() ?? label);
      else addEntry(state, device.role, OP_LABEL[op.type], label);
    },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    addObjection(state, action: PayloadAction<{ evidenceId: string; ground: string; explanation: string }>) {
      const device = state.devices.find((item) => item.id === state.activeDeviceId);
      const item = state.evidence.find((entry) => entry.id === action.payload.evidenceId);
      state.objections.unshift({ ...action.payload, id: crypto.randomUUID(), status: "待裁定", createdAt: new Date().toISOString() });
      state.session.phase = "质证";
      addEntry(state, device?.role ?? "审判庭", "提出异议", `${item?.exhibitNo ?? ""} ${action.payload.ground}`);
    },
    resolveObjection(state, action: PayloadAction<{ id: string; status: "支持" | "驳回" }>) {
      const device = state.devices.find((item) => item.id === state.activeDeviceId);
      const objection = state.objections.find((entry) => entry.id === action.payload.id);
      if (!objection) return;
      objection.status = action.payload.status;
      const item = state.evidence.find((entry) => entry.id === objection.evidenceId);
      if (action.payload.status === "支持" && item) {
        item.status = "已跳过";
        state.catalogRevision += 1;
        addEntry(state, device?.role ?? "审判庭", "异议成立", `${item.exhibitNo} 暂不展示`);
      } else {
        addEntry(state, device?.role ?? "审判庭", "异议驳回", item?.title ?? "继续质证");
      }
    },
    snapshot(state, action: PayloadAction<string>) {
      state.snapshots.unshift({ id: crypto.randomUUID(), label: action.payload, time: new Date().toISOString(), evidence: structuredClone(state.evidence), phase: state.session.phase, currentEvidenceId: state.session.currentEvidenceId });
      state.snapshots = state.snapshots.slice(0, 10);
    },
    restore(state, action: PayloadAction<string>) {
      const snapshot = state.snapshots.find((entry) => entry.id === action.payload);
      if (!snapshot) return;
      state.evidence = structuredClone(snapshot.evidence);
      state.session.phase = snapshot.phase;
      state.session.currentEvidenceId = snapshot.currentEvidenceId;
      state.catalogRevision += 1;
      state.orderRevision += 1;
      addEntry(state, "审判庭", "恢复庭审快照", snapshot.label);
    },
    tick(state, action: PayloadAction<number | undefined>) {
      const now = action.payload ?? nowTs();
      // 在线持有者每秒续心跳；持有者离线时心跳停止，TTL 后触发回滚
      if (state.lease) {
        const holder = state.devices.find((device) => device.id === state.lease?.holderId);
        if (holder?.online) state.lease = heartbeat(state.lease, holder.id, now);
      }
      const result = sweep({ lease: state.lease, waitlist: state.waitlist, onlineIds: onlineIds(state), catalogRevision: state.catalogRevision, now });
      if (result.rolledBack) {
        const oldHolder = state.devices.find((device) => device.id === state.lease?.holderId);
        state.lease = result.lease;
        state.waitlist = result.waitlist;
        addMerge(state, "lease", "心跳失败，回滚旧租约", result.takeoverId ? `候补按序号接管，新租约 epoch ${result.lease?.epoch}` : "无候补在线，租约空缺");
        addEntry(state, oldHolder?.role ?? "书记员", "租约心跳失败", "旧租约已回滚");
        if (result.takeoverId && result.lease) {
          const taker = state.devices.find((device) => device.id === result.takeoverId);
          if (taker) {
            taker.believedEpoch = result.lease.epoch;
            addEntry(state, taker.role, "候补接管", `按序号取得证据目录租约 epoch ${result.lease.epoch}`);
            addMerge(state, "lease", "候补接管", `${taker.label} 按序号接管 epoch ${result.lease.epoch}`, taker.id);
          }
        }
      }
      if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1;
    },
    setPhase(state, action: PayloadAction<SessionPhase>) {
      const device = state.devices.find((item) => item.id === state.activeDeviceId);
      state.session.phase = action.payload;
      addEntry(state, device?.role ?? "审判庭", "切换庭审阶段", action.payload);
    }
  }
});

export const {
  hydrate,
  setActiveDevice,
  setDeviceRole,
  setDeviceOnline,
  acquireControl,
  releaseControl,
  submitOp,
  setMode,
  addObjection,
  resolveObjection,
  snapshot,
  restore,
  tick,
  setPhase
} = slice.actions;

export default slice.reducer;
