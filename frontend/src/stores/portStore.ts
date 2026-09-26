import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import type { Berth, BerthStatus } from '../types/berth';
import {
  isEffectiveCall,
  type CallCorrectionInput,
  type CallDraft,
  type PortCall,
} from '../types/call';
import { buildBerthRecords } from '../db/berth';
import { reconcileBerths, type ReconcileError } from '../utils/callReconcile';

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

export interface CallChainEntry {
  call: PortCall;
  kind: '原记录' | '更正记录' | '当前记录';
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

  const callsSorted = computed(() => sortByTimeDesc(calls.value));

  /** 参与在港状态与统计的有效流水（已更正、已撤销的记录不计入） */
  const effectiveCalls = computed(() => callsSorted.value.filter(isEffectiveCall));

  function sortByTimeDesc(list: PortCall[]): PortCall[] {
    return [...list].sort(
      (a, b) =>
        new Date(b.time).getTime() - new Date(a.time).getTime() ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  function portById(id: string): FishingPort | undefined {
    return ports.value.find((p) => p.id === id);
  }

  function berthsOf(portId: string): Berth[] {
    return berths.value.filter((b) => b.portId === portId).sort((a, b) => a.berthNo.localeCompare(b.berthNo));
  }

  function callById(id: string): PortCall | undefined {
    return calls.value.find((c) => c.id === id);
  }

  /** 某艘船的有效进出港记录（时间线、统计用） */
  function callsOfVessel(vesselId: string): PortCall[] {
    return effectiveCalls.value.filter((c) => c.vesselId === vesselId);
  }

  /**
   * 以当前全部有效流水为事实来源重算泊位状态，并把失败原因写回流水。
   * 重算只在登记 / 更正 / 撤销后触发，绝不覆盖维修泊位或他船占用。
   */
  async function reconcileAndPersist(): Promise<ReconcileError[]> {
    const result = reconcileBerths(effectiveCalls.value, berths.value);
    const errorByCall = new Map(result.errors.map((e) => [e.callId, e.message]));

    const nextCalls = calls.value.map((c) => {
      const message = errorByCall.get(c.id) ?? null;
      if ((c.recomputeError ?? null) === message) return c;
      return { ...c, recomputeError: message };
    });

    await db.transaction('rw', db.berths, db.calls, async () => {
      await db.berths.bulkPut(toPlain(result.berths));
      const dirty = nextCalls.filter((c, i) => c !== calls.value[i]);
      if (dirty.length) await db.calls.bulkPut(toPlain(dirty));
    });

    berths.value = result.berths;
    calls.value = nextCalls;
    return result.errors;
  }

  function resetFilter(): void {
    filter.value = emptyPortFilter();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [p, b, c] = await Promise.all([db.ports.toArray(), db.berths.toArray(), db.calls.toArray()]);
      ports.value = p;
      berths.value = b;
      calls.value = c;
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
   * 登记一条进出港记录，并以全部有效流水重算泊位占用状态，
   * 保证进港占用、出港释放，且不会挤掉别的船。
   */
  async function registerCall(draft: CallDraft, vesselName: string, portId: string): Promise<PortCall> {
    const call: PortCall = {
      id: uid('c'),
      vesselId: draft.vesselId,
      vesselName,
      type: draft.type,
      time: draft.time ? new Date(draft.time).toISOString() : new Date().toISOString(),
      berthNo: draft.berthNo,
      portId,
      iceKg: Number(draft.iceKg) || 0,
      fuelL: Number(draft.fuelL) || 0,
      unloadKg: Number(draft.unloadKg) || 0,
      visaStatus: draft.visaStatus,
      createdAt: new Date().toISOString(),
      lifecycle: '正常',
      correctedById: null,
      correctedFromId: null,
      correctedAt: null,
      voidReason: null,
      voidAt: null,
      recomputeError: null,
    };
    await db.calls.put(toPlain(call));
    calls.value = [...calls.value, call];
    await reconcileAndPersist();
    // reconcileAndPersist 会把泊位同步失败原因写回记录，返回写回后的最新对象
    return callById(call.id) ?? call;
  }

  /**
   * 更正未签证（待签证 / 免签）记录：可改渔船、时间、泊位和补给数量。
   * 原记录保留并标记为「已更正」，接出一条新记录继续生效。
   */
  async function correctCall(callId: string, input: CallCorrectionInput, vesselName: string): Promise<PortCall> {
    const original = callById(callId);
    if (!original) throw new Error('原记录不存在');
    if (!isEffectiveCall(original)) throw new Error('该记录已处理，不能再次更正');
    if (original.visaStatus === '已签证') throw new Error('已签证记录不能更正，请先撤销');

    const now = new Date().toISOString();
    const next: PortCall = {
      ...original,
      id: uid('c'),
      vesselId: input.vesselId,
      vesselName,
      time: input.time ? new Date(input.time).toISOString() : now,
      berthNo: input.berthNo,
      portId: input.portId,
      iceKg: Number(input.iceKg) || 0,
      fuelL: Number(input.fuelL) || 0,
      unloadKg: Number(input.unloadKg) || 0,
      createdAt: now,
      lifecycle: '正常',
      correctedById: null,
      correctedFromId: original.id,
      correctedAt: now,
      voidReason: null,
      voidAt: null,
      recomputeError: null,
    };
    const marked: PortCall = {
      ...original,
      lifecycle: '已更正',
      correctedById: next.id,
      correctedAt: now,
      recomputeError: null,
    };

    await db.transaction('rw', db.calls, async () => {
      await db.calls.put(toPlain(marked));
      await db.calls.put(toPlain(next));
    });
    calls.value = calls.value.map((c) => (c.id === original.id ? marked : c));
    calls.value = [...calls.value, next];
    await reconcileAndPersist();
    return callById(next.id) ?? next;
  }

  /** 撤销记录：必须填写原因；记录保留，但不再计入在港状态与统计。 */
  async function voidCall(callId: string, reason: string): Promise<void> {
    const hit = callById(callId);
    if (!hit) throw new Error('记录不存在');
    if (!isEffectiveCall(hit)) throw new Error('该记录已处理，不能再次撤销');
    const trimmed = reason.trim();
    if (!trimmed) throw new Error('请填写撤销原因');

    const now = new Date().toISOString();
    const next: PortCall = {
      ...hit,
      lifecycle: '已撤销',
      voidReason: trimmed,
      voidAt: now,
      recomputeError: null,
    };
    await db.calls.put(toPlain(next));
    calls.value = calls.value.map((c) => (c.id === callId ? next : c));
    await reconcileAndPersist();
  }

  /**
   * 处理链：沿更正关系回溯到最早一条，再正序返回，标注各节点身份。
   * 已撤销的节点同样保留在链中可回看。
   */
  function callChain(callId: string): CallChainEntry[] {
    const start = callById(callId);
    if (!start) return [];
    const nodes: PortCall[] = [];
    const guard = new Set<string>();

    // 沿 correctedFromId 回溯到最早一条原记录
    let cursor: PortCall | undefined = start;
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      nodes.unshift(cursor);
      cursor = cursor.correctedFromId ? callById(cursor.correctedFromId) : undefined;
    }
    // 从入口节点沿 correctedById 接续后续更正（多次更正时每节只指向紧邻的新记录）
    cursor = start.correctedById ? callById(start.correctedById) : undefined;
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      nodes.push(cursor);
      cursor = cursor.correctedById ? callById(cursor.correctedById) : undefined;
    }

    return sortByTimeAsc(nodes).map((call, index) => ({
      call,
      kind: index === nodes.length - 1 ? '当前记录' : index === 0 ? '原记录' : '更正记录',
    }));
  }

  function sortByTimeAsc(list: PortCall[]): PortCall[] {
    return [...list].sort(
      (a, b) =>
        new Date(a.time).getTime() - new Date(b.time).getTime() ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  return {
    ports,
    berths,
    calls,
    loading,
    filter,
    filteredPorts,
    callsSorted,
    effectiveCalls,
    portById,
    berthsOf,
    callById,
    callsOfVessel,
    callChain,
    reconcileAndPersist,
    resetFilter,
    loadAll,
    createPort,
    addBerth,
    setBerthStatus,
    updatePort,
    registerCall,
    correctCall,
    voidCall,
  };
});
