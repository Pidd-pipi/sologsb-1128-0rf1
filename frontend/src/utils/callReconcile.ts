import type { Berth } from '../types/berth';
import type { PortCall } from '../types/call';
import { isEffectiveCall } from '../types/call';

export interface ReconcileError {
  callId: string;
  message: string;
}

export interface ReconcileResult {
  berths: Berth[];
  errors: ReconcileError[];
}

/**
 * 以有效进出港流水为唯一事实来源，回放重算全部泊位状态。
 *
 * 规则：
 * - 维修泊位由人工置位，回放期间保持维修、不参与占用；
 * - 有效记录按时间升序回放：进港占用、出港释放；
 * - 只有空闲泊位能被占用；泊位已被其他船占用时，该条记录登记失败原因，
 *   绝不挤掉别的船；同一艘船重复进港 / 重复出港按幂等处理；
 * - 历史记录缺少 portId 时，仅在泊位号全局唯一的情况下兜底解析。
 */
export function reconcileBerths(effectiveCalls: PortCall[], current: Berth[]): ReconcileResult {
  const work = new Map<string, Berth>();
  for (const berth of current) {
    work.set(berth.id, {
      ...berth,
      // 维修泊位保留人工状态，其余泊位先全部释放，再由流水重新占用
      ...(berth.status === '维修'
        ? {}
        : {
            status: '空闲' as const,
            vesselId: null,
            vesselName: null,
            berthAt: null,
            leaveAt: null,
          }),
    });
  }

  const byBerthNo = new Map<string, Berth[]>();
  for (const berth of work.values()) {
    const list = byBerthNo.get(berth.berthNo) ?? [];
    list.push(berth);
    byBerthNo.set(berth.berthNo, list);
  }

  const errors: ReconcileError[] = [];

  const ordered = effectiveCalls
    .filter(isEffectiveCall)
    .slice()
    .sort(
      (a, b) =>
        new Date(a.time).getTime() - new Date(b.time).getTime() ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
        a.id.localeCompare(b.id),
    );

  for (const call of ordered) {
    let berth: Berth | undefined;
    if (call.portId) berth = work.get(`${call.portId}-${call.berthNo}`);
    if (!berth) {
      const candidates = byBerthNo.get(call.berthNo) ?? [];
      if (candidates.length === 1) berth = candidates[0];
    }

    if (!berth) {
      errors.push({
        callId: call.id,
        message: `找不到泊位 ${call.berthNo}（所属渔港无法确定），该记录未同步在港状态`,
      });
      continue;
    }
    if (berth.status === '维修') {
      errors.push({ callId: call.id, message: `泊位 ${berth.berthNo} 处于维修状态，该记录未同步在港状态` });
      continue;
    }

    if (call.type === '进港') {
      if (berth.status === '占用') {
        if (berth.vesselId === call.vesselId) continue; // 同船重复进港，幂等
        errors.push({
          callId: call.id,
          message: `泊位 ${berth.berthNo} 已被${berth.vesselName ?? '其他船舶'}占用，已保留其在港状态、未覆盖`,
        });
        continue;
      }
      work.set(berth.id, {
        ...berth,
        status: '占用',
        vesselId: call.vesselId,
        vesselName: call.vesselName,
        berthAt: call.time,
        leaveAt: null,
      });
      continue;
    }

    // 出港
    if (berth.status === '占用') {
      if (berth.vesselId !== call.vesselId) {
        errors.push({
          callId: call.id,
          message: `泊位 ${berth.berthNo} 当前由${berth.vesselName ?? '其他船舶'}占用，该出港记录未释放泊位`,
        });
        continue;
      }
      work.set(berth.id, {
        ...berth,
        status: '空闲',
        vesselId: null,
        vesselName: null,
        berthAt: null,
        leaveAt: call.time,
      });
    } else if (!berth.leaveAt) {
      // 泊位已空闲：幂等补记离泊时间
      work.set(berth.id, { ...berth, leaveAt: call.time });
    }
  }

  return { berths: [...work.values()], errors };
}
