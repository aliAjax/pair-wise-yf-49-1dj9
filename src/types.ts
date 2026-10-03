export type Party = "原告" | "被告" | "审判庭";
export type EvidenceStatus = "待展示" | "展示中" | "已展示" | "已跳过";
export type SessionPhase = "开庭" | "举证" | "质证" | "休庭" | "结束";

/** 控制台角色：证据目录只认按角色领取的控制权租约 */
export type Role = "书记员" | "法官";

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
  actor: Party | Role;
  action: string;
  detail: string;
}

export interface SessionState {
  phase: SessionPhase;
  currentEvidenceId: string | null;
  timerSeconds: number;
  operatorMode: "庭审控制" | "公开屏预览";
}

/** 参与同一场庭审的控制端设备 */
export interface DeviceInfo {
  id: string;
  label: string;
  role: Role;
  online: boolean;
  /** 断网那一刻本设备自认的租约代号，回网后用于判断是否为旧租约 */
  believedEpoch: number | null;
}

/** 控制权租约：证据目录的唯一权威凭证 */
export interface Lease {
  holderId: string;
  /** 租约代号：每次领取、接管都递增；旧端回网时据此识别新旧租约 */
  epoch: number;
  /** 领取时基于的目录修订号 */
  baseRevision: number;
  /** 租约内操作序号（修订号） */
  seq: number;
  heartbeatAt: number;
  ttlMs: number;
}

export interface WaitEntry {
  deviceId: string;
  /** 候补序号，按序号接管 */
  seq: number;
  requestedAt: number;
}

export type CatalogOpType = "reorder" | "select" | "show" | "complete" | "setSensitive";

/** 目录操作：旧端断网期间停在待合并区，回网后重放 */
export interface CatalogOp {
  id: string;
  type: CatalogOpType;
  evidenceId?: string;
  /** reorder：完整的目标证据 id 顺序 */
  order?: string[];
  /** setSensitive：目标遮罩状态（重放安全，不用 toggle） */
  value?: boolean;
  originDeviceId: string;
  originEpoch: number;
  /** 租约内修订号 */
  revision: number;
  /** 操作所基于的目录修订号/顺序修订号，重放时做冲突判定 */
  baseRevision: number;
  baseOrderRevision: number;
  createdAt: number;
}

export interface MergeLogEntry {
  id: string;
  time: string;
  kind: "merged" | "skipped" | "lease";
  deviceId?: string;
  action: string;
  detail: string;
}
