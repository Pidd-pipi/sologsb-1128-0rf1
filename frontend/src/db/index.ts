import Dexie, { type Table } from 'dexie';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { Berth } from '../types/berth';
import { buildBerthRecords } from './berth';

/**
 * gbfishport-db：库名固定为 gbfishport-db
 * v1 建 ports / vessels；v2 新增 calls 表与 vesselId 索引；v3 新增 berths 表并按泊位数生成初始记录；
 * v4 为 calls 增加更正 / 撤销字段（state、处理链指针、撤销原因与操作日志）与 portId 索引，旧记录回填为「有效」。
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
        // state / portId 进入索引，便于按有效记录与渔港筛选
        calls: 'id, vesselId, type, time, state, portId',
      })
      .upgrade(async (tx) => {
        // v4 迁移：旧记录一律回填为「有效」，补齐处理链字段；portId 按泊位号从 berths 回推
        const berths = await tx.table<Berth, string>('berths').toArray();
        // 同名泊位跨港不唯一时无法判定归属，留空由运行时按上下文解析
        const candidates = new Map<string, Set<string>>();
        for (const berth of berths) {
          const set = candidates.get(berth.berthNo) ?? new Set<string>();
          set.add(berth.portId);
          candidates.set(berth.berthNo, set);
        }
        const uniquePortByNo = new Map<string, string>();
        for (const [berthNo, portIds] of candidates) {
          if (portIds.size === 1) uniquePortByNo.set(berthNo, [...portIds][0]);
        }
        await tx
          .table<PortCall, string>('calls')
          .toCollection()
          .modify((call) => {
            if (!call.state) call.state = '有效';
            if (call.correctsId === undefined) call.correctsId = null;
            if (call.correctedById === undefined) call.correctedById = null;
            if (call.cancelReason === undefined) call.cancelReason = null;
            if (call.canceledAt === undefined) call.canceledAt = null;
            if (!Array.isArray(call.logs)) call.logs = [];
            if (!call.portId) {
              const guessed = uniquePortByNo.get(call.berthNo);
              if (guessed) call.portId = guessed;
            }
          });
      });
  }
}

export const db = new FishPortDatabase();
