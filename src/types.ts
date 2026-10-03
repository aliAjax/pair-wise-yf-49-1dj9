export type Party = "原告" | "被告" | "审判庭";
export type Role = "书记员" | "法官";
export type EvidenceStatus = "待展示" | "展示中" | "已展示" | "已跳过";
export type SessionPhase = "开庭" | "举证" | "质证" | "休庭" | "结束";

/** 控制权租约：证据目录只认租约，租约随心跳续期、超时回滚 */
export interface Lease {
  leaseId: string;
  deviceId: string;
  role: Role;
  /** 接管序号：候补按序号接管，序号大者优先 */
  seq: number;
  /** 修订号：每次提交操作递增，重放时按修订号判定新旧 */
  revision: number;
  heartbeatAt: string;
  expiresAt: string;
  status: "有效" | "已回滚";
}

/** 待合并操作类型 */
export type PendingOpType = "reorder" | "select" | "show" | "complete" | "toggleSensitive";
export type PendingOpStatus = "待合并" | "已合并" | "已跳过";

/** 待合并区中的一条操作记录 */
export interface PendingOp {
  opId: string;
  /** 操作入队序号：单调递增，重放时按此排序，避免时间戳同毫秒导致顺序错乱 */
  seq: number;
  /** 操作产生时所依据的租约编号 */
  leaseId: string;
  /** 操作产生时的修订号（旧端据此重放） */
  revision: number;
  type: PendingOpType;
  payload: unknown;
  createdAt: string;
  status: PendingOpStatus;
  skipReason?: string;
}

export interface Evidence {
  id: string;
  exhibitNo: string;
  title: string;
  type: "书证" | "物证" | "电子数据" | "证人";
  duration: number;
  presenter: Party;
  sensitive: boolean;
  status: EvidenceStatus;
  note: string;
}

export interface Objection {
  id: string;
  evidenceId: string;
  ground: string;
  explanation: string;
  status: "待裁定" | "支持" | "驳回";
  createdAt: string;
}

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Party | "书记员" | "法官";
  action: string;
  detail: string;
}

export interface SessionState {
  phase: SessionPhase;
  currentEvidenceId: string | null;
  timerSeconds: number;
  operatorMode: "庭审控制" | "公开屏预览";
}
