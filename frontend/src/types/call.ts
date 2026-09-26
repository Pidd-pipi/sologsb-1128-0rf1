/** 进出港类型 */
export type CallType = '进港' | '出港';

export const CALL_TYPES: CallType[] = ['进港', '出港'];

/** 签证状态 */
export type VisaStatus = '已签证' | '待签证' | '免签';

export const VISA_STATUSES: VisaStatus[] = ['已签证', '待签证', '免签'];

/** 记录生命周期：正常 / 已被更正（原记录留档）/ 已撤销（留档但不参与统计与在港状态） */
export type CallLifecycle = '正常' | '已更正' | '已撤销';

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
  /** 所属渔港 id（v4 起写入；历史记录迁移时回填，回填不到时按在港状态兜底解析） */
  portId?: string;
  /** 加冰 kg */
  iceKg: number;
  /** 加油 L */
  fuelL: number;
  /** 卸货量 kg */
  unloadKg: number;
  /** 签证状态 */
  visaStatus: VisaStatus;
  createdAt: string;
  /** 生命周期状态，缺省视为「正常」（兼容旧数据） */
  lifecycle?: CallLifecycle;
  /** 更正后接出的新记录 id（原记录留作已更正） */
  correctedById?: string | null;
  /** 被更正的原记录 id（新记录接上原记录） */
  correctedFromId?: string | null;
  correctedAt?: string | null;
  /** 撤销原因 */
  voidReason?: string | null;
  voidAt?: string | null;
  /** 按本船最近有效记录重算泊位时未能生效的原因，如泊位被他船占用 */
  recomputeError?: string | null;
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

/** 更正登记表单：未签证记录可改渔船、时间、泊位和补给数量（类型不可改） */
export interface CallCorrectionInput {
  vesselId: string;
  time: string;
  berthNo: string;
  portId: string;
  iceKg: number;
  fuelL: number;
  unloadKg: number;
}

/** 是否为参与在港状态与统计的有效记录 */
export function isEffectiveCall(call: PortCall): boolean {
  return (call.lifecycle ?? '正常') === '正常';
}
