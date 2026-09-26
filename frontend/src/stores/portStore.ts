import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import type { Berth, BerthStatus } from '../types/berth';
import {
  callState,
  describeCorrection,
  effectiveCalls,
  isCorrectionOpen,
  isEffectiveCall,
  normalizeCall,
  type CallCorrection,
  type CallLog,
  type CallDraft,
  type PortCall,
} from '../types/call';
import { buildBerthRecords } from '../db/berth';

export interface PortInput {
  name: string;
  level: FishingPort['level'];
  longitude: number;
  latitude: number;
  berthCount: number;
  berthDepth: number;
  wharfLength: number;
  shelterLevel: number;
  supply: SupplyCapability;
  manager: string;
}

/** 旧流水缺 portId（v3 及以前）时，按泊位号从泊位表回推渔港 */
function inferPortId(call: PortCall, berthLike: { portId: string; berthNo: string }[]): string {
  if (call.portId) return call.portId;
  const hits = new Set(berthLike.filter((b) => b.berthNo === call.berthNo).map((b) => b.portId));
  return hits.size === 1 ? [...hits][0] : '';
}

/** 解析流水指向的泊位 id（旧数据 portId 缺失时按泊位号兜底：同名泊位唯一才命中） */
function resolveBerthId(call: PortCall, berthList: Berth[]): string | null {
  if (call.portId) return `${call.portId}-${call.berthNo}`;
  const hits = berthList.filter((b) => b.berthNo === call.berthNo);
  return hits.length === 1 ? hits[0].id : null;
}
function latestEffectiveByTime(calls: PortCall[]): PortCall | null {
  if (!calls.length) return null;
  return [...calls].sort((a, b) => {
    const byTime = new Date(b.time).getTime() - new Date(a.time).getTime();
    if (byTime !== 0) return byTime;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  })[0];
}

export const usePortStore = defineStore('port', () => {
  const ports = ref<FishingPort[]>([]);
  const berths = ref<Berth[]>([]);
  const calls = ref<PortCall[]>([]);
  const loading = ref(false);
  const filter = ref<PortFilter>(emptyPortFilter());

  const filteredPorts = computed(() => {
    const f = filter.value;
    const keyword = f.keyword.trim();
    return ports.value.filter((p) => {
      if (f.level && p.level !== f.level) return false;
      if (f.minShelterLevel !== null && p.shelterLevel < f.minShelterLevel) return false;
      if (keyword && !p.name.includes(keyword) && !p.manager.includes(keyword)) return false;
      return true;
    });
  });

  const callsSorted = computed(() =>
    [...calls.value].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()),
  );

  /** 有效流水（排除已更正、已撤销）：统计与在港状态只认这份 */
  const effectiveCallsSorted = computed(() =>
    [...effectiveCalls(calls.value)].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()),
  );

  function portById(id: string): FishingPort | undefined {
    return ports.value.find((p) => p.id === id);
  }

  function berthsOf(portId: string): Berth[] {
    return berths.value.filter((b) => b.portId === portId).sort((a, b) => a.berthNo.localeCompare(b.berthNo));
  }

  function callsOfVessel(vesselId: string): PortCall[] {
    // 渔船档案只看有效流水，已更正 / 已撤销记录在登记页处理链中回看
    return effectiveCallsSorted.value.filter((c) => c.vesselId === vesselId);
  }

  function callById(id: string): PortCall | undefined {
    return calls.value.find((c) => c.id === id);
  }

  function resetFilter(): void {
    filter.value = emptyPortFilter();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [p, b, rawCalls] = await Promise.all([db.ports.toArray(), db.berths.toArray(), db.calls.toArray()]);
      ports.value = p;
      berths.value = b;
      // 旧数据打开后照常使用：补齐更正 / 撤销字段缺省值，并为缺 portId 的历史流水回推渔港
      calls.value = rawCalls.map((call) => {
        const normalized = normalizeCall(call);
        return { ...normalized, portId: inferPortId(normalized, b) };
      });
    } finally {
      loading.value = false;
    }
  }

  async function createPort(input: PortInput): Promise<FishingPort> {
    const port: FishingPort = {
      id: uid('p'),
      name: input.name.trim(),
      level: input.level,
      longitude: Number(input.longitude),
      latitude: Number(input.latitude),
      berthCount: Number(input.berthCount),
      berthDepth: Number(input.berthDepth),
      wharfLength: Number(input.wharfLength),
      shelterLevel: Number(input.shelterLevel),
      supply: { ...input.supply },
      manager: input.manager.trim(),
      createdAt: new Date().toISOString(),
    };
    // 写库前脱代理，避免 DataCloneError
    await db.ports.put(toPlain(port));
    const records = buildBerthRecords(port, []);
    await db.berths.bulkPut(toPlain(records));
    ports.value = [...ports.value, port];
    berths.value = [...berths.value, ...records];
    return port;
  }

  async function addBerth(portId: string, berthNo: string, designDepth: number): Promise<Berth | null> {
    const port = portById(portId);
    if (!port) return null;
    const no = berthNo.trim().toUpperCase();
    if (!no) return null;
    if (berthsOf(portId).some((b) => b.berthNo === no)) return null;
    const berth: Berth = {
      id: `${portId}-${no}`,
      portId,
      berthNo: no,
      vesselId: null,
      vesselName: null,
      berthAt: null,
      leaveAt: null,
      status: '空闲',
      designDepth: Number(designDepth) || port.berthDepth,
    };
    await db.berths.put(toPlain(berth));
    berths.value = [...berths.value, berth];
    const nextCount = berthsOf(portId).length;
    await updatePort(portId, { berthCount: nextCount });
    return berth;
  }

  async function setBerthStatus(berthId: string, status: BerthStatus): Promise<void> {
    const hit = berths.value.find((b) => b.id === berthId);
    if (!hit) return;
    const next: Berth = {
      ...hit,
      status,
      vesselId: status === '占用' ? hit.vesselId : null,
      vesselName: status === '占用' ? hit.vesselName : null,
      berthAt: status === '占用' ? hit.berthAt ?? new Date().toISOString() : hit.berthAt,
      leaveAt: status === '空闲' ? new Date().toISOString() : null,
    };
    await db.berths.put(toPlain(next));
    berths.value = berths.value.map((b) => (b.id === berthId ? next : b));
  }

  async function updatePort(portId: string, patch: Partial<FishingPort>): Promise<void> {
    const hit = portById(portId);
    if (!hit) return;
    const next: FishingPort = { ...hit, ...patch };
    await db.ports.put(toPlain(next));
    ports.value = ports.value.map((p) => (p.id === portId ? next : p));
  }

  /**
   * 按有效进出港流水重算泊位状态。
   *
   * 只处理受影响的泊位：更正 / 撤销涉及的船舶与所有指向目标泊位的流水都参与计算；
   * 每个泊位取「本泊位时间最近的一条有效流水」推导占用 / 空闲，
   * 维修泊位在没有任何有效流水时保持维修，绝不按当前在港船去挤掉别的船。
   *
   * 必须在 db.transaction 回调内调用（db.calls / db.berths 自动走当前事务）。
   *
   * @param affectedVesselIds 船舶发生变化（更正换船等）的旧 / 新船 id
   * @param extraBerthKeys 需要强制重算的 (portId, berthNo) 集合
   */
  async function recomputeBerths(
    affectedVesselIds: Set<string>,
    extraBerthKeys: Set<string>,
  ): Promise<void> {
    const [allCalls, allBerths] = await Promise.all([db.calls.toArray(), db.berths.toArray()]);
    const effective = effectiveCalls(allCalls);

    const targets = new Set<string>();
    for (const call of effective) {
      const key = `${call.portId ?? ''}|${call.berthNo}`;
      if (affectedVesselIds.has(call.vesselId) || extraBerthKeys.has(key)) {
        const berthId = resolveBerthId(call, allBerths);
        if (berthId) targets.add(berthId);
      }
    }
    // 目标泊位即使已无有效流水也要重算（释放）
    for (const key of extraBerthKeys) {
      const [portId, berthNo] = key.split('|');
      if (portId) targets.add(`${portId}-${berthNo}`);
    }

    const nextBerths = [...allBerths];
    const persist: Berth[] = [];

    for (const berthId of targets) {
      const index = nextBerths.findIndex((b) => b.id === berthId);
      if (index < 0) continue;
      const current = nextBerths[index];

      const onThisBerth = effective.filter((c) => resolveBerthId(c, allBerths) === berthId);
      const latest = latestEffectiveByTime(onThisBerth);

      let next: Berth;
      if (!latest) {
        if (current.status === '维修') {
          // 维修位且无任何有效流水：保留人工维修标记
          next = current;
        } else {
          next = {
            ...current,
            status: '空闲',
            vesselId: null,
            vesselName: null,
            berthAt: null,
            leaveAt: current.leaveAt ?? new Date().toISOString(),
          };
        }
      } else if (latest.type === '进港') {
        next = {
          ...current,
          status: '占用',
          vesselId: latest.vesselId,
          vesselName: latest.vesselName,
          berthAt: latest.time,
          leaveAt: null,
        };
      } else {
        next = {
          ...current,
          status: '空闲',
          vesselId: null,
          vesselName: null,
          berthAt: null,
          leaveAt: latest.time,
        };
      }

      if (next !== current) {
        nextBerths[index] = next;
        persist.push(next);
      }
    }

    if (persist.length) {
      await db.berths.bulkPut(toPlain(persist));
      berths.value = nextBerths;
    }
  }

  /** 把一次失败尝试（被拒更正 / 撤销）追加到处理链，登记页可回看失败原因 */
  async function appendFailureLog(
    callId: string,
    action: '更正失败' | '撤销失败',
    detail: string,
  ): Promise<void> {
    const hit = await db.calls.get(callId);
    if (!hit) return;
    const log: CallLog = { at: new Date().toISOString(), action, detail };
    const next: PortCall = normalizeCall({ ...hit, logs: [...(hit.logs ?? []), log] });
    await db.calls.put(toPlain(next));
    calls.value = calls.value.map((c) => (c.id === callId ? next : c));
  }

  /**
   * 登记一条进出港记录，并同步泊位占用状态（进港 → 占用，出港 → 释放）。
   */
  async function registerCall(draft: CallDraft, vesselName: string, portId: string): Promise<PortCall> {
    // 出港必须是本船当前占用的泊位，避免把别的船挤下泊位
    const berth = berths.value.find((b) => b.portId === portId && b.berthNo === draft.berthNo);
    if (berth?.status === '维修') {
      throw new Error(`泊位 ${draft.berthNo} 正在维修，暂不能登记进出港`);
    }
    if (
      berth &&
      berth.status === '占用' &&
      berth.vesselId &&
      berth.vesselId !== draft.vesselId
    ) {
      // 进港 / 出港都不能落到别的船占用的泊位（UI 已过滤，这里是最后一道守卫）
      throw new Error(
        draft.type === '进港'
          ? `泊位 ${draft.berthNo} 当前由 ${berth.vesselName ?? '其他渔船'} 占用，不能重复安排进港`
          : `泊位 ${draft.berthNo} 当前由 ${berth.vesselName ?? '其他渔船'} 占用，不能为其他渔船登记出港`,
      );
    }

    const call: PortCall = {
      id: uid('c'),
      vesselId: draft.vesselId,
      vesselName,
      type: draft.type,
      time: draft.time ? new Date(draft.time).toISOString() : new Date().toISOString(),
      portId,
      berthNo: draft.berthNo,
      iceKg: Number(draft.iceKg) || 0,
      fuelL: Number(draft.fuelL) || 0,
      unloadKg: Number(draft.unloadKg) || 0,
      visaStatus: draft.visaStatus,
      createdAt: new Date().toISOString(),
      state: '有效',
      correctsId: null,
      correctedById: null,
      cancelReason: null,
      canceledAt: null,
      logs: [],
    };
    await db.calls.put(toPlain(call));
    calls.value = [...calls.value, call];

    if (berth) {
      const next: Berth =
        draft.type === '进港'
          ? {
              ...berth,
              status: '占用',
              vesselId: draft.vesselId,
              vesselName,
              berthAt: call.time,
              leaveAt: null,
            }
          : {
              ...berth,
              status: '空闲',
              vesselId: null,
              vesselName: null,
              berthAt: null,
              leaveAt: call.time,
            };
      await db.berths.put(toPlain(next));
      berths.value = berths.value.map((b) => (b.id === berth.id ? next : b));
    }
    return call;
  }

  /**
   * 更正一条未签证记录：可改渔船、时间、泊位、补给数量。
   * 原记录留档为「已更正」，新记录接续在处理链上，并按有效流水重算相关泊位。
   * 目标泊位被别的船占用 / 维修中时拒绝操作，并把失败原因写入原记录处理链。
   */
  async function correctCall(callId: string, input: CallCorrection): Promise<PortCall> {
    const targetVessel = (await db.vessels.get(input.vesselId)) ?? null;
    if (!targetVessel) {
      await appendFailureLog(callId, '更正失败', '所选渔船不存在');
      throw new Error('请选择有效的渔船');
    }

    try {
      return await db.transaction('rw', db.calls, db.berths, async () => {
        const source = await db.calls.get(callId);
        if (!source) throw new Error('原记录不存在或已被删除');
        if (!isCorrectionOpen(source)) {
          const reason =
            callState(source) === '已撤销'
              ? '记录已撤销，不能更正'
              : callState(source) === '已更正'
                ? '该记录已被更正，请在接续出的新记录上操作'
                : '已签证记录不能更正，如需作废请使用撤销';
          throw new Error(reason);
        }

        const targetBerth = await db.berths.get(`${input.portId}-${input.berthNo}`);
        if (!targetBerth) throw new Error('所选泊位不存在');
        if (targetBerth.status === '维修') {
          throw new Error(`泊位 ${input.berthNo} 正在维修，不能更正到该泊位`);
        }
        // 不能挤掉别的船：占用位只在「就是原记录所在泊位、占用者也是原记录的船」时放行
        // （船名录错、只换船不换位的场景；重算后占用自然交给新船）
        const sourcePortId = source.portId || inferPortId(source, berths.value);
        const isSourceBerth = sourcePortId === input.portId && source.berthNo === input.berthNo;
        if (
          targetBerth.status === '占用' &&
          targetBerth.vesselId &&
          !(isSourceBerth && targetBerth.vesselId === source.vesselId) &&
          targetBerth.vesselId !== input.vesselId
        ) {
          throw new Error(
            `泊位 ${input.berthNo} 当前由 ${targetBerth.vesselName ?? '其他渔船'} 占用，不能更正为 ${targetVessel.name}`,
          );
        }

        const now = new Date().toISOString();
        const corrected: PortCall = normalizeCall({
          ...source,
          state: '已更正',
          correctedById: '', // 先占位，新记录 id 生成后回填
          logs: [
            ...(source.logs ?? []),
            { at: now, action: '更正', detail: input.note?.trim() || undefined },
          ],
        });

        const newId = uid('c');
        const fresh: PortCall = normalizeCall({
          ...source,
          id: newId,
          vesselId: targetVessel.id,
          vesselName: targetVessel.name,
          time: input.time ? new Date(input.time).toISOString() : source.time,
          portId: input.portId,
          berthNo: input.berthNo,
          iceKg: Number(input.iceKg) || 0,
          fuelL: Number(input.fuelL) || 0,
          unloadKg: Number(input.unloadKg) || 0,
          // 类型与签证状态沿用原记录
          type: source.type,
          visaStatus: source.visaStatus,
          createdAt: now,
          state: '有效',
          correctsId: source.id,
          correctedById: null,
          cancelReason: null,
          canceledAt: null,
          logs: [],
        });
        corrected.correctedById = newId;

        // 变更明细回填到原记录的操作日志
        const portName = portById(input.portId)?.name;
        const changeDetail = describeCorrection(normalizeCall(source), fresh, portName);
        const noteText = input.note?.trim();
        corrected.logs = corrected.logs!.map((log) =>
          log.action === '更正' && log.at === now
            ? { ...log, detail: [changeDetail, noteText].filter(Boolean).join('；备注：') }
            : log,
        );

        await db.calls.bulkPut([toPlain(corrected), toPlain(fresh)]);
        calls.value = calls.value.map((c) => (c.id === source.id ? corrected : c));
        calls.value = [...calls.value, fresh];

        // 换船时两条船的泊位都要重算；原泊位与目标泊位都纳入范围
        const vesselIds = new Set([source.vesselId, fresh.vesselId]);
        const berthKeys = new Set([
          `${(source.portId || inferPortId(source, berths.value))}|${source.berthNo}`,
          `${input.portId}|${input.berthNo}`,
        ]);
        await recomputeBerths(vesselIds, berthKeys);

        return fresh;
      });
    } catch (error) {
      // 预检 / 事务失败都要落到处理链，登记页才能回看失败原因
      await appendFailureLog(callId, '更正失败', (error as Error).message);
      throw error;
    }
  }

  /**
   * 撤销一条进出港记录：必须填写原因，记录保留但不再计入在港状态与统计，
   * 随后按该船与该泊位最近一条有效流水重算泊位。
   */
  async function cancelCall(callId: string, reason: string): Promise<PortCall> {
    const trimmed = reason.trim();
    if (!trimmed) {
      await appendFailureLog(callId, '撤销失败', '未填写撤销原因');
      throw new Error('请填写撤销原因');
    }

    try {
      return await db.transaction('rw', db.calls, db.berths, async () => {
        const source = await db.calls.get(callId);
        if (!source) throw new Error('记录不存在或已被删除');
        if (!isEffectiveCall(source)) {
          throw new Error(
            callState(source) === '已撤销' ? '该记录已撤销，无需重复操作' : '已更正的记录不能撤销，请操作接续出的新记录',
          );
        }

        const now = new Date().toISOString();
        const next: PortCall = normalizeCall({
          ...source,
          state: '已撤销',
          cancelReason: trimmed,
          canceledAt: now,
          logs: [...(source.logs ?? []), { at: now, action: '撤销', detail: trimmed }],
        });

        await db.calls.put(toPlain(next));
        calls.value = calls.value.map((c) => (c.id === callId ? next : c));

        const portId = source.portId || inferPortId(source, berths.value);
        await recomputeBerths(new Set([source.vesselId]), new Set([`${portId}|${source.berthNo}`]));

        return next;
      });
    } catch (error) {
      await appendFailureLog(callId, '撤销失败', (error as Error).message);
      throw error;
    }
  }

  return {
    ports,
    berths,
    calls,
    loading,
    filter,
    filteredPorts,
    callsSorted,
    effectiveCallsSorted,
    portById,
    berthsOf,
    callsOfVessel,
    callById,
    resetFilter,
    loadAll,
    createPort,
    addBerth,
    setBerthStatus,
    updatePort,
    registerCall,
    correctCall,
    cancelCall,
  };
});
