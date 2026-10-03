import type { RootState } from "./index";
import { leaseAlive, nowTs } from "./leaseEngine";

export interface LeaseView {
  activeDeviceId: string;
  online: boolean;
  holderId: string | null;
  epoch: number | null;
  alive: boolean;
  isHolder: boolean;
  /** 当前设备能否实时修改证据目录（在线且持有有效租约） */
  canControl: boolean;
  /** 当前设备是否处于"断网旧持有者"状态（操作只进待合并区） */
  offlineHolder: boolean;
  waitPosition: number;
  heartbeatRemainMs: number;
  blockedReason: string | null;
}

export function selectLeaseView(state: RootState, now = nowTs()): LeaseView {
  const court = state.court;
  const device = court.devices.find((item) => item.id === court.activeDeviceId);
  const alive = leaseAlive(court.lease, now);
  const isHolder = !!court.lease && court.lease.holderId === device?.id;
  const offlineHolder = !!device && !device.online && device.believedEpoch !== null && isHolder;
  const position = court.waitlist.findIndex((entry) => entry.deviceId === device?.id) + 1;

  let blockedReason: string | null = null;
  if (!device) blockedReason = "未找到当前设备";
  else if (!device.online && !offlineHolder) blockedReason = "设备离线且无旧租约，操作被禁止";
  else if (!device.online) blockedReason = "网络抖动：操作停在待合并区，回网后按租约和修订号重放";
  else if (!alive) blockedReason = "控制权租约空缺，请按角色领取";
  else if (!isHolder) blockedReason = position > 0 ? `候补序号 ${position}，按序号等待接管` : "未持有控制权租约，请先领取或候补";

  return {
    activeDeviceId: court.activeDeviceId,
    online: !!device?.online,
    holderId: alive ? court.lease!.holderId : court.lease?.holderId ?? null,
    epoch: court.lease?.epoch ?? null,
    alive,
    isHolder,
    canControl: !!device?.online && alive && isHolder,
    offlineHolder,
    waitPosition: position > 0 ? position : 0,
    heartbeatRemainMs: court.lease ? Math.max(0, court.lease.ttlMs - (now - court.lease.heartbeatAt)) : 0,
    blockedReason
  };
}
