import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { Evidence, Objection, SessionPhase, SessionState, TimelineEntry } from "../types";

const seedEvidence: Evidence[] = [
  { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定" },
  { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩" },
  { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45" }
];
const seedSession: SessionState = { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制" };

interface State {
  initialized: boolean;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: { id: string; label: string; time: string; evidence: Evidence[]; phase: SessionPhase; currentEvidenceId: string | null }[];
  session: SessionState;
  online: boolean;
}

const initialState: State = {
  initialized: false,
  evidence: seedEvidence,
  objections: [{ id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString() }],
  timeline: [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
  snapshots: [], session: seedSession, online: true
};

function addEntry(state: State, actor: TimelineEntry["actor"], action: string, detail: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, detail });
}

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<Evidence[]>) { if (!state.initialized) { state.evidence = action.payload.length ? action.payload : seedEvidence; state.initialized = true; } },
    setOnline(state, action: PayloadAction<boolean>) { state.online = action.payload; },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    reorder(state, action: PayloadAction<Evidence[]>) { state.evidence = action.payload; addEntry(state, "书记员", "调整证据顺序", "已更新举证顺序"); },
    selectEvidence(state, action: PayloadAction<string>) { const item = state.evidence.find((entry) => entry.id === action.payload); if (!item) return; state.session.currentEvidenceId = item.id; state.session.timerSeconds = item.duration * 60; addEntry(state, item.presenter, "切换展示证据", `${item.exhibitNo} ${item.title}`); },
    showEvidence(state) { const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId); if (!item) return; item.status = "展示中"; state.session.phase = "质证"; addEntry(state, item.presenter, "开始展示", item.title); },
    completeEvidence(state) { const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId); if (!item) return; item.status = "已展示"; const next = state.evidence.find((entry) => entry.status === "待展示"); state.session.currentEvidenceId = next?.id ?? null; state.session.timerSeconds = (next?.duration ?? 0) * 60; state.session.phase = next ? "举证" : "休庭"; addEntry(state, "审判庭", "完成质证", item.title); },
    toggleSensitive(state, action: PayloadAction<string>) { const item = state.evidence.find((entry) => entry.id === action.payload); if (!item) return; item.sensitive = !item.sensitive; addEntry(state, "审判庭", item.sensitive ? "隐藏敏感内容" : "恢复公开内容", item.title); },
    addObjection(state, action: PayloadAction<{ evidenceId: string; ground: string; explanation: string }>) { const item = state.evidence.find((entry) => entry.id === action.payload.evidenceId); state.objections.unshift({ ...action.payload, id: crypto.randomUUID(), status: "待裁定", createdAt: new Date().toISOString() }); state.session.phase = "质证"; addEntry(state, item?.presenter ?? "审判庭", "提出异议", `${item?.exhibitNo ?? ""} ${action.payload.ground}`); },
    resolveObjection(state, action: PayloadAction<{ id: string; status: "支持" | "驳回" }>) { const objection = state.objections.find((entry) => entry.id === action.payload.id); if (!objection) return; objection.status = action.payload.status; const item = state.evidence.find((entry) => entry.id === objection.evidenceId); if (action.payload.status === "支持" && item) { item.status = "已跳过"; addEntry(state, "审判庭", "异议成立", `${item.exhibitNo} 暂不展示`); } else { addEntry(state, "审判庭", "异议驳回", item?.title ?? "继续质证"); } },
    snapshot(state, action: PayloadAction<string>) { state.snapshots.unshift({ id: crypto.randomUUID(), label: action.payload, time: new Date().toISOString(), evidence: structuredClone(state.evidence), phase: state.session.phase, currentEvidenceId: state.session.currentEvidenceId }); state.snapshots = state.snapshots.slice(0, 10); },
    restore(state, action: PayloadAction<string>) { const snapshot = state.snapshots.find((entry) => entry.id === action.payload); if (!snapshot) return; state.evidence = structuredClone(snapshot.evidence); state.session.phase = snapshot.phase; state.session.currentEvidenceId = snapshot.currentEvidenceId; addEntry(state, "审判庭", "恢复庭审快照", snapshot.label); },
    tick(state) { if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1; },
    setPhase(state, action: PayloadAction<SessionPhase>) { state.session.phase = action.payload; addEntry(state, "审判庭", "切换庭审阶段", action.payload); }
  }
});

export const { initialize, setOnline, setMode, reorder, selectEvidence, showEvidence, completeEvidence, toggleSensitive, addObjection, resolveObjection, snapshot, restore, tick, setPhase } = slice.actions;
export default slice.reducer;
