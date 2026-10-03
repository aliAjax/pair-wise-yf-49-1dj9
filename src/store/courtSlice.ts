import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { Evidence, Lease, Objection, PendingOp, PendingOpType, Role, SessionPhase, SessionState, TimelineEntry } from "../types";
import type { PersistedState } from "./api";

/** 租约有效期：心跳超时后旧租约回滚，候补按序号接管 */
const LEASE_TTL_MS = 30_000;

const seedEvidence: Evidence[] = [
  { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定" },
  { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩" },
  { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45" }
];
const seedSession: SessionState = { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制" };

interface Snapshot { id: string; label: string; time: string; evidence: Evidence[]; phase: SessionPhase; currentEvidenceId: string | null }

interface State {
  initialized: boolean;
  /** 本设备编号：租约按设备领取，旧数据升级时重新生成 */
  deviceId: string;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: Snapshot[];
  session: SessionState;
  online: boolean;
  /** 当前控制权租约：仅持有有效租约的设备才能改动证据目录 */
  lease: Lease | null;
  /** 已回滚租约历史：候补接管时按其中最大序号递增 */
  leaseHistory: Lease[];
  /** 待合并区：旧端操作停留于此，回网后按租约与修订号重放 */
  pendingOps: PendingOp[];
}

const initialState: State = {
  initialized: false,
  deviceId: crypto.randomUUID(),
  evidence: seedEvidence,
  objections: [{ id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString() }],
  timeline: [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
  snapshots: [], session: seedSession, online: true,
  lease: null, leaseHistory: [], pendingOps: []
};

function nowISO() { return new Date().toISOString(); }

/** 待合并操作入队序号：单调递增，保证重放顺序确定 */
let pendingOpSeq = 0;

function addEntry(state: State, actor: TimelineEntry["actor"], action: string, detail: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: nowISO(), actor, action, detail });
}

/** 本设备是否持有有效租约 */
function leaseActive(state: State): boolean {
  return !!state.lease && state.lease.status === "有效" && state.lease.deviceId === state.deviceId && new Date(state.lease.expiresAt).getTime() > Date.now();
}

/** 操作的中文描述，用于待合并区展示 */
export function describeOp(op: PendingOp): string {
  switch (op.type) {
    case "reorder": return "调整证据顺序";
    case "select": return `选中证据 ${String(op.payload ?? "")}`;
    case "show": return "开始展示";
    case "complete": return "完成并切换下一条";
    case "toggleSensitive": {
      const p = op.payload as { id: string; sensitive: boolean } | null;
      return p?.sensitive ? "开启敏感遮罩" : "关闭敏感遮罩";
    }
  }
}

/** 将操作实际应用到证据目录 */
function applyOp(state: State, op: PendingOp) {
  switch (op.type) {
    case "reorder":
      state.evidence = (op.payload as Evidence[]).map((entry) => ({ ...entry }));
      // 证据顺序改动后，未展示项计时立即重算
      const current = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId);
      if (current && current.status === "待展示") state.session.timerSeconds = current.duration * 60;
      break;
    case "select": {
      const id = op.payload as string;
      const item = state.evidence.find((entry) => entry.id === id);
      if (item) { state.session.currentEvidenceId = item.id; state.session.timerSeconds = item.duration * 60; }
      break;
    }
    case "show": {
      const id = op.payload as string | null;
      const item = state.evidence.find((entry) => entry.id === id);
      if (item) { item.status = "展示中"; state.session.phase = "质证"; }
      break;
    }
    case "complete": {
      const id = op.payload as string | null;
      const item = state.evidence.find((entry) => entry.id === id);
      if (!item) break;
      item.status = "已展示";
      const next = state.evidence.find((entry) => entry.status === "待展示");
      state.session.currentEvidenceId = next?.id ?? null;
      state.session.timerSeconds = (next?.duration ?? 0) * 60;
      state.session.phase = next ? "举证" : "休庭";
      break;
    }
    case "toggleSensitive": {
      const p = op.payload as { id: string; sensitive: boolean };
      const item = state.evidence.find((entry) => entry.id === p.id);
      if (item) item.sensitive = p.sensitive;
      break;
    }
  }
}

/**
 * 证据目录操作统一入口：
 * - 本设备持有有效租约：直接应用，修订号递增，操作记入待合并区（已合并）；
 * - 否则操作停在待合并区，不覆盖新控制端的目录顺序、展示状态与遮罩。
 */
function commitOrQueue(state: State, meta: { type: PendingOpType; payload: unknown; desc: string; actor?: TimelineEntry["actor"] }, apply: () => void) {
  if (leaseActive(state) && state.lease) {
    apply();
    state.lease.revision += 1;
    state.pendingOps.unshift({ opId: crypto.randomUUID(), seq: ++pendingOpSeq, leaseId: state.lease.leaseId, revision: state.lease.revision, type: meta.type, payload: meta.payload, createdAt: nowISO(), status: "已合并" });
  } else {
    // 旧端依据自己最后已知的租约修订号排队，回网后按租约与修订号重放
    const knownRevisions = [state.lease?.revision ?? 0, ...state.leaseHistory.filter((l) => l.deviceId === state.deviceId).map((l) => l.revision)];
    const baseRev = Math.max(...knownRevisions);
    const queued = state.pendingOps.filter((o) => o.status === "待合并").length;
    state.pendingOps.unshift({ opId: crypto.randomUUID(), seq: ++pendingOpSeq, leaseId: state.lease?.leaseId ?? "无租约", revision: baseRev + queued + 1, type: meta.type, payload: meta.payload, createdAt: nowISO(), status: "待合并" });
    addEntry(state, "书记员", "操作进入待合并区", `${meta.desc}：当前设备未持有有效租约，回网后按租约与修订号重放`);
  }
}

/**
 * 重放待合并区：
 * 1. 旧租约操作：同一证据已经公开（展示中/已展示）则跳过；修订号落后则跳过；
 * 2. 本租约操作：修订号已不大于当前修订号说明本地已生效，标记合并；
 * 3. 遮罩开启要先于展示生效：应用展示操作前，先把同证据待合并的遮罩开启操作落地。
 */
function replayPending(state: State) {
  const current = state.lease;
  const pending = state.pendingOps
    .filter((o) => o.status === "待合并")
    .sort((a, b) => a.seq - b.seq);
  for (const op of pending) {
    const p = op.payload as { id?: string } | string | null;
    const evidenceId = typeof p === "string" ? p : p?.id;
    const target = state.evidence.find((e) => e.id === (op.type === "show" || op.type === "complete" ? (op.payload as string | null) : evidenceId));
    const stale = !current || op.leaseId !== current.leaseId;
    if (stale) {
      // 同一证据已经公开就跳过旧操作
      if ((op.type === "show" || op.type === "complete" || op.type === "select") && target && (target.status === "展示中" || target.status === "已展示")) {
        op.status = "已跳过"; op.skipReason = "证据已公开，旧操作跳过";
        addEntry(state, "书记员", "待合并操作已跳过", `${describeOp(op)}：${target.exhibitNo} 已公开`);
        continue;
      }
      // 按租约和修订号重放：修订号落后说明已被新控制端覆盖
      if (op.revision <= (current?.revision ?? 0)) {
        op.status = "已跳过"; op.skipReason = "修订号已落后于当前租约";
        addEntry(state, "书记员", "待合并操作已跳过", `${describeOp(op)}：修订号 ${op.revision} 已落后`);
        continue;
      }
    } else if (current && op.revision <= current.revision) {
      op.status = "已合并";
      continue;
    }
    // 遮罩开启要先于展示生效：先落地同证据的遮罩开启操作
    if (op.type === "show" && target) {
      for (const earlier of pending) {
        if (earlier.seq >= op.seq) break;
        if (earlier.type !== "toggleSensitive") continue;
        const ep = earlier.payload as { id: string; sensitive: boolean };
        if (ep.id === target.id && ep.sensitive) {
          const item = state.evidence.find((e) => e.id === target.id);
          if (item && !item.sensitive) {
            item.sensitive = true;
            earlier.status = "已合并";
            earlier.skipReason = undefined;
            addEntry(state, "书记员", "重放优先开启遮罩", `${target.exhibitNo} 敏感遮罩先于展示生效`);
          }
        }
      }
    }
    applyOp(state, op);
    op.status = "已合并";
    if (current) current.revision = op.revision;
    addEntry(state, "书记员", "重放合并操作", describeOp(op));
  }
}

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    /** 从本地快照恢复；旧数据缺少租约和角色时，由当前书记员补上默认控制权 */
    hydrate(state, action: PayloadAction<PersistedState | null>) {
      const p = action.payload;
      if (p) {
        if (p.deviceId) state.deviceId = p.deviceId;
        if (Array.isArray(p.evidence) && p.evidence.length) state.evidence = p.evidence;
        if (Array.isArray(p.objections)) state.objections = p.objections;
        if (Array.isArray(p.timeline)) state.timeline = p.timeline;
        if (Array.isArray(p.snapshots)) state.snapshots = p.snapshots;
        if (p.session) state.session = p.session;
        if (Array.isArray(p.leaseHistory)) state.leaseHistory = p.leaseHistory;
        if (Array.isArray(p.pendingOps)) {
          state.pendingOps = p.pendingOps;
          // 同步入队序号，避免刷新后新操作与历史操作序号冲突
          pendingOpSeq = Math.max(pendingOpSeq, ...p.pendingOps.map((o) => o.seq ?? 0));
        }
        state.lease = p.lease ?? null;
      }
      if (!state.lease) {
        state.lease = {
          leaseId: crypto.randomUUID(), deviceId: state.deviceId, role: "书记员", seq: 1, revision: 0,
          heartbeatAt: nowISO(), expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(), status: "有效"
        };
        addEntry(state, "书记员", "检测到旧版数据", "已升级并补发书记员控制权租约（序号 1）");
      }
      state.initialized = true;
    },
    setOnline(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
      if (action.payload) {
        addEntry(state, "书记员", "网络恢复", "开始按租约与修订号重放待合并操作");
        replayPending(state);
      }
    },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    reorder(state, action: PayloadAction<Evidence[]>) {
      commitOrQueue(state, { type: "reorder", payload: action.payload, desc: "调整证据顺序" }, () => {
        state.evidence = action.payload;
        addEntry(state, "书记员", "调整证据顺序", "已更新举证顺序，未展示项计时立即重算");
      });
    },
    selectEvidence(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      commitOrQueue(state, { type: "select", payload: action.payload, desc: `选中证据 ${item.exhibitNo}` }, () => {
        state.session.currentEvidenceId = item.id;
        state.session.timerSeconds = item.duration * 60;
        addEntry(state, item.presenter, "切换展示证据", `${item.exhibitNo} ${item.title}`);
      });
    },
    showEvidence(state) {
      const id = state.session.currentEvidenceId;
      const item = state.evidence.find((entry) => entry.id === id);
      if (!item) return;
      commitOrQueue(state, { type: "show", payload: id, desc: "开始展示" }, () => {
        item.status = "展示中";
        state.session.phase = "质证";
        addEntry(state, item.presenter, "开始展示", item.title);
      });
    },
    completeEvidence(state) {
      const id = state.session.currentEvidenceId;
      const item = state.evidence.find((entry) => entry.id === id);
      if (!item) return;
      commitOrQueue(state, { type: "complete", payload: id, desc: "完成并切换下一条" }, () => {
        item.status = "已展示";
        const next = state.evidence.find((entry) => entry.status === "待展示");
        state.session.currentEvidenceId = next?.id ?? null;
        state.session.timerSeconds = (next?.duration ?? 0) * 60;
        state.session.phase = next ? "举证" : "休庭";
        addEntry(state, "审判庭", "完成质证", item.title);
      });
    },
    toggleSensitive(state, action: PayloadAction<{ id: string; sensitive: boolean }>) {
      const item = state.evidence.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      commitOrQueue(state, { type: "toggleSensitive", payload: action.payload, desc: action.payload.sensitive ? "开启敏感遮罩" : "关闭敏感遮罩" }, () => {
        item.sensitive = action.payload.sensitive;
        addEntry(state, "审判庭", action.payload.sensitive ? "隐藏敏感内容" : "恢复公开内容", item.title);
      });
    },
    addObjection(state, action: PayloadAction<{ evidenceId: string; ground: string; explanation: string }>) {
      const item = state.evidence.find((entry) => entry.id === action.payload.evidenceId);
      state.objections.unshift({ ...action.payload, id: crypto.randomUUID(), status: "待裁定", createdAt: nowISO() });
      state.session.phase = "质证";
      addEntry(state, item?.presenter ?? "审判庭", "提出异议", `${item?.exhibitNo ?? ""} ${action.payload.ground}`);
    },
    resolveObjection(state, action: PayloadAction<{ id: string; status: "支持" | "驳回" }>) {
      const objection = state.objections.find((entry) => entry.id === action.payload.id);
      if (!objection) return;
      objection.status = action.payload.status;
      const item = state.evidence.find((entry) => entry.id === objection.evidenceId);
      if (action.payload.status === "支持" && item) { item.status = "已跳过"; addEntry(state, "审判庭", "异议成立", `${item.exhibitNo} 暂不展示`); } else { addEntry(state, "审判庭", "异议驳回", item?.title ?? "继续质证"); }
    },
    snapshot(state, action: PayloadAction<string>) { state.snapshots.unshift({ id: crypto.randomUUID(), label: action.payload, time: nowISO(), evidence: structuredClone(state.evidence), phase: state.session.phase, currentEvidenceId: state.session.currentEvidenceId }); state.snapshots = state.snapshots.slice(0, 10); },
    restore(state, action: PayloadAction<string>) {
      const snapshot = state.snapshots.find((entry) => entry.id === action.payload);
      if (!snapshot) return;
      state.evidence = structuredClone(snapshot.evidence);
      state.session.phase = snapshot.phase;
      state.session.currentEvidenceId = snapshot.currentEvidenceId;
      addEntry(state, "审判庭", "恢复庭审快照", snapshot.label);
    },
    tick(state) {
      if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1;
      // 心跳失败：租约超时未续约则回滚，候补可按序号接管
      if (state.lease && state.lease.status === "有效" && new Date(state.lease.expiresAt).getTime() <= Date.now()) {
        state.leaseHistory.push(state.lease);
        addEntry(state, "书记员", "心跳失败，租约已回滚", `${state.lease.role}租约（序号 ${state.lease.seq}）超时未续约，待候补按序号接管`);
        state.lease = null;
      }
    },
    setPhase(state, action: PayloadAction<SessionPhase>) { state.session.phase = action.payload; addEntry(state, "审判庭", "切换庭审阶段", action.payload); },
    /** 设备按角色领取控制权租约；有效租约被拒接管，超时/回滚后候补按序号+1接管 */
    claimLease(state, action: PayloadAction<Role>) {
      const role = action.payload;
      const now = Date.now();
      if (state.lease && state.lease.status === "有效" && new Date(state.lease.expiresAt).getTime() > now) {
        if (state.lease.deviceId === state.deviceId) {
          state.lease.role = role;
          state.lease.heartbeatAt = nowISO();
          state.lease.expiresAt = new Date(now + LEASE_TTL_MS).toISOString();
          addEntry(state, role, "领取控制权租约", `${role} 续约，序号 ${state.lease.seq}`);
        } else {
          addEntry(state, role, "租约仍有效，拒绝接管", `当前 ${state.lease.role} 租约（序号 ${state.lease.seq}）心跳未超时`);
        }
        return;
      }
      const seq = Math.max(0, ...state.leaseHistory.map((l) => l.seq), state.lease?.seq ?? 0) + 1;
      const revision = Math.max(0, ...state.leaseHistory.map((l) => l.revision), state.lease?.revision ?? 0);
      state.lease = { leaseId: crypto.randomUUID(), deviceId: state.deviceId, role, seq, revision, heartbeatAt: nowISO(), expiresAt: new Date(now + LEASE_TTL_MS).toISOString(), status: "有效" };
      addEntry(state, role, "领取控制权租约", `${role} 接管证据目录控制权，序号 ${seq}，修订号 ${revision}`);
    },
    /** 心跳续约；租约已超时则回滚 */
    heartbeat(state) {
      if (!state.lease) { addEntry(state, "书记员", "心跳失败", "当前无有效租约，请先领取"); return; }
      if (state.lease.deviceId !== state.deviceId) { addEntry(state, "书记员", "心跳被拒绝", `租约属于 ${state.lease.role} 设备，本设备无权续约`); return; }
      const now = Date.now();
      if (new Date(state.lease.expiresAt).getTime() <= now) {
        state.leaseHistory.push(state.lease);
        addEntry(state, "书记员", "心跳失败，租约已回滚", `${state.lease.role}租约（序号 ${state.lease.seq}）超时未续约`);
        state.lease = null;
        return;
      }
      state.lease.heartbeatAt = nowISO();
      state.lease.expiresAt = new Date(now + LEASE_TTL_MS).toISOString();
      addEntry(state, state.lease.role, "心跳续约", `${state.lease.role}租约（序号 ${state.lease.seq}）已续约`);
    },
    /** 演示用：模拟租约心跳超时回滚 */
    expireLease(state) {
      if (!state.lease) return;
      state.leaseHistory.push(state.lease);
      addEntry(state, "书记员", "模拟租约超时", `${state.lease.role}租约（序号 ${state.lease.seq}）已回滚，候补可按序号接管`);
      state.lease = null;
    },
    /** 手动重放待合并区 */
    replay(state) {
      addEntry(state, "书记员", "手动重放", "开始按租约与修订号重放待合并操作");
      replayPending(state);
    }
  }
});

export const {
  hydrate, setOnline, setMode, reorder, selectEvidence, showEvidence, completeEvidence, toggleSensitive,
  addObjection, resolveObjection, snapshot, restore, tick, setPhase, claimLease, heartbeat, expireLease, replay
} = slice.actions;
export default slice.reducer;
