import { formatDateTime } from '../utils/format';

/** 进出港类型 */
export type CallType = '进港' | '出港';

export const CALL_TYPES: CallType[] = ['进港', '出港'];

/** 签证状态 */
export type VisaStatus = '已签证' | '待签证' | '免签';

export const VISA_STATUSES: VisaStatus[] = ['已签证', '待签证', '免签'];

/** 记录状态：有效 / 已更正（留档，被新记录接续） / 已撤销（留档，不再计入统计与在港状态） */
export type CallState = '有效' | '已更正' | '已撤销';

/** 处理链上的操作日志（更正、撤销及失败尝试都落链） */
export type CallLogAction = '更正' | '撤销' | '更正失败' | '撤销失败';

export interface CallLog {
  /** 操作时间（ISO 字符串） */
  at: string;
  action: CallLogAction;
  /** 操作说明 / 变更内容 / 失败原因 */
  detail?: string;
}

/** 进出港记录 */
export interface PortCall {
  id: string;
  /** 渔船 id */
  vesselId: string;
  /** 渔船名（冗余，便于流水展示） */
  vesselName: string;
  /** 类型：进港 / 出港 */
  type: CallType;
  /** 时间（ISO 字符串） */
  time: string;
  /** 泊位号 */
  berthNo: string;
  /** 加冰 kg */
  iceKg: number;
  /** 加油 L */
  fuelL: number;
  /** 卸货量 kg */
  unloadKg: number;
  /** 签证状态 */
  visaStatus: VisaStatus;
  createdAt: string;
  /** 所属渔港 id（v4 起写入；旧数据缺失时按泊位号回推） */
  portId?: string;
  /** 记录状态，旧数据（v3 及以前）一律视为「有效」 */
  state?: CallState;
  /** 本记录接续自哪条原始记录（更正链指针，旧数据为 null） */
  correctsId?: string | null;
  /** 本记录已被哪条新记录接续（更正链指针，旧数据为 null） */
  correctedById?: string | null;
  /** 撤销原因 */
  cancelReason?: string | null;
  /** 撤销时间（ISO 字符串） */
  canceledAt?: string | null;
  /** 处理链操作日志（含失败原因） */
  logs?: CallLog[];
}

/** 进出港登记表单模型 */
export interface CallDraft {
  vesselId: string;
  type: CallType;
  time: string;
  berthNo: string;
  iceKg: number;
  fuelL: number;
  unloadKg: number;
  visaStatus: VisaStatus;
}

/** 更正提交模型：渔船、时间、泊位、补给数量可改；类型与签证状态沿用原记录 */
export interface CallCorrection {
  vesselId: string;
  time: string;
  portId: string;
  berthNo: string;
  iceKg: number;
  fuelL: number;
  unloadKg: number;
  /** 更正说明（可选，写入处理链） */
  note?: string;
}

export function emptyCallDraft(berthNo = ''): CallDraft {
  return {
    vesselId: '',
    type: '进港',
    time: '',
    berthNo,
    iceKg: 0,
    fuelL: 0,
    unloadKg: 0,
    visaStatus: '待签证',
  };
}

/** 读取记录状态，旧数据缺省视为「有效」 */
export function callState(call: PortCall): CallState {
  return call.state ?? '有效';
}

/** 旧数据打开后照常使用：补齐更正 / 撤销相关字段的缺省值 */
export function normalizeCall(call: PortCall): PortCall {
  return {
    ...call,
    state: callState(call),
    correctsId: call.correctsId ?? null,
    correctedById: call.correctedById ?? null,
    cancelReason: call.cancelReason ?? null,
    canceledAt: call.canceledAt ?? null,
    logs: Array.isArray(call.logs) ? call.logs : [],
  };
}

/** 有效记录：未被更正接续、未被撤销，参与统计与在港状态计算 */
export function isEffectiveCall(call: PortCall): boolean {
  return callState(call) === '有效';
}

export function effectiveCalls(calls: PortCall[]): PortCall[] {
  return calls.filter(isEffectiveCall);
}

/** 只有未签证（待签证 / 免签）的有效记录允许更正 */
export function isCorrectionOpen(call: PortCall): boolean {
  return isEffectiveCall(call) && call.visaStatus !== '已签证';
}

export function isFailureLog(log: CallLog): boolean {
  return log.action === '更正失败' || log.action === '撤销失败';
}

/**
 * 取回更正处理链：从最早的原始记录开始，沿 correctedById 走到当前记录。
 * 已撤销的末条记录同样包含在链中；成环时按访问顺序截断保护。
 */
export function callChain(calls: PortCall[], id: string): PortCall[] {
  const byId = new Map(calls.map((c) => [c.id, c]));
  const start = byId.get(id);
  if (!start) return [];

  let root = start;
  while (root.correctsId && byId.has(root.correctsId)) {
    root = byId.get(root.correctsId)!;
  }

  const chain: PortCall[] = [];
  const seen = new Set<string>();
  let current: PortCall | undefined = root;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.correctedById ? byId.get(current.correctedById) : undefined;
  }
  return chain;
}

/** 生成更正变更说明，只记录实际发生变化的字段 */
export function describeCorrection(before: PortCall, after: PortCall, afterPortName?: string): string {
  const changes: string[] = [];
  if (before.vesselId !== after.vesselId) {
    changes.push(`渔船「${before.vesselName}」→「${after.vesselName}」`);
  }
  if (new Date(before.time).getTime() !== new Date(after.time).getTime()) {
    changes.push(`时间 ${formatDateTime(before.time)} → ${formatDateTime(after.time)}`);
  }
  const beforeBerth = before.berthNo;
  const afterBerth = afterPortName ? `${afterPortName} · ${after.berthNo}` : after.berthNo;
  if (before.berthNo !== after.berthNo || (before.portId ?? '') !== (after.portId ?? '')) {
    changes.push(`泊位 ${beforeBerth} → ${afterBerth}`);
  }
  if (before.iceKg !== after.iceKg) changes.push(`加冰 ${before.iceKg} → ${after.iceKg} kg`);
  if (before.fuelL !== after.fuelL) changes.push(`加油 ${before.fuelL} → ${after.fuelL} L`);
  if (before.unloadKg !== after.unloadKg) changes.push(`卸货 ${before.unloadKg} → ${after.unloadKg} kg`);
  return changes.length ? changes.join('；') : '内容未变化';
}
