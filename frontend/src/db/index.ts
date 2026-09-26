import Dexie, { type Table } from 'dexie';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { Berth } from '../types/berth';
import { buildBerthRecords } from './berth';
import { reconcileBerths } from '../utils/callReconcile';

/**
 * gbfishport-db：库名固定为 gbfishport-db
 * v1 建 ports / vessels；v2 新增 calls 表与 vesselId 索引；v3 新增 berths 表并按泊位数生成初始记录；
 * v4 为进出港流水补上所属渔港 portId 与更正 / 撤销生命周期字段，并按有效流水重算泊位状态。
 */
export class FishPortDatabase extends Dexie {
  ports!: Table<FishingPort, string>;
  vessels!: Table<FishingVessel, string>;
  calls!: Table<PortCall, string>;
  berths!: Table<Berth, string>;

  constructor() {
    super('gbfishport-db');

    this.version(1).stores({
      ports: 'id, name, level, shelterLevel',
      vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
    });

    this.version(2)
      .stores({
        calls: 'id, vesselId, type, time',
      })
      .upgrade(async (tx) => {
        // v2 迁移：新增 calls 表与 vesselId 索引，回填历史记录的冗余字段
        await tx
          .table<PortCall, string>('calls')
          .toCollection()
          .modify((call) => {
            if (!call.vesselName) call.vesselName = '';
            if (!call.visaStatus) call.visaStatus = '待签证';
          });
      });

    this.version(3)
      .stores({
        berths: 'id, portId, berthNo, status, vesselId',
      })
      .upgrade(async (tx) => {
        // v3 迁移：新增 berths 表，并按每个渔港登记的泊位数生成初始泊位记录
        const ports = await tx.table<FishingPort, string>('ports').toArray();
        const berthTable = tx.table<Berth, string>('berths');
        for (const port of ports) {
          const existing = await berthTable.where('portId').equals(port.id).count();
          if (existing === 0) {
            await berthTable.bulkPut(buildBerthRecords(port));
          }
        }
      });

    this.version(4)
      .stores({
        calls: 'id, vesselId, type, time, lifecycle, correctedById',
      })
      .upgrade(async (tx) => {
        // v4 迁移：回填更正 / 撤销字段，并为历史流水补记所属渔港（用当前泊位占用兜底）
        const [calls, ports, berths] = await Promise.all([
          tx.table<PortCall, string>('calls').toArray(),
          tx.table<FishingPort, string>('ports').toArray(),
          tx.table<Berth, string>('berths').toArray(),
        ]);

        // 泊位号在各渔港之间会重复（多个渔港都有 B01），仅当全局唯一时才作为兜底依据
        const berthNoOwners = new Map<string, Set<string>>();
        for (const berth of berths) {
          const owners = berthNoOwners.get(berth.berthNo) ?? new Set<string>();
          owners.add(berth.portId);
          berthNoOwners.set(berth.berthNo, owners);
        }
        const uniquePortByBerthNo = new Map<string, string>();
        for (const [berthNo, owners] of berthNoOwners) {
          if (owners.size === 1) uniquePortByBerthNo.set(berthNo, [...owners][0]);
        }

        const vesselHomePort = new Map<string, string>();
        const vessels = await tx.table<FishingVessel, string>('vessels').toArray();
        for (const v of vessels) vesselHomePort.set(v.name, v.homePort);

        for (const call of calls) {
          if (!call.lifecycle) call.lifecycle = '正常';
          if (call.correctedById === undefined) call.correctedById = null;
          if (call.correctedFromId === undefined) call.correctedFromId = null;
          if (call.correctedAt === undefined) call.correctedAt = null;
          if (call.voidReason === undefined) call.voidReason = null;
          if (call.voidAt === undefined) call.voidAt = null;
          if (call.recomputeError === undefined) call.recomputeError = null;
          if (!call.portId) {
            // 优先按当前由同一渔船占用的泊位解析，其次用全局唯一泊位号，最后按船籍港名匹配渔港
            const occupiedPort = berths.find((b) => b.berthNo === call.berthNo && b.vesselId === call.vesselId)?.portId;
            const homePortName = vesselHomePort.get(call.vesselName);
            const homePort = ports.find((p) => p.name.includes(homePortName ?? ''))?.id;
            call.portId = occupiedPort ?? uniquePortByBerthNo.get(call.berthNo) ?? homePort ?? '';
          }
        }

        // 以有效流水重算泊位状态：修复旧版靠反向流水修正导致的在港状态偏差，
        // 维修泊位保留人工状态、他船占用不会被挤掉；失败原因写回对应记录
        const reconcile = reconcileBerths(calls, berths);
        const errorByCall = new Map(reconcile.errors.map((e) => [e.callId, e.message]));
        for (const call of calls) {
          call.recomputeError = errorByCall.get(call.id) ?? null;
        }

        await tx.table<PortCall, string>('calls').bulkPut(calls);
        await tx.table<Berth, string>('berths').bulkPut(reconcile.berths);
      });
  }
}

export const db = new FishPortDatabase();
