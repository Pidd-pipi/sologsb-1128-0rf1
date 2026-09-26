import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db } from '../src/db';
import { SEED_PORTS, SEED_VESSELS, SEED_CALLS } from '../src/db/seed';
import { buildBerthRecords } from '../src/db/berth';
import { toPlain } from '../src/utils/format';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败：${msg}`);
}

async function main(): Promise<void> {
  // 1) 用独立 Dexie 实例按 v3 结构写入旧数据（calls 不带 state / portId / logs）
  await db.delete();
  const oldDb = new Dexie('gbfishport-db');
  oldDb.version(3).stores({
    ports: 'id, name, level, shelterLevel',
    vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
    calls: 'id, vesselId, type, time',
    berths: 'id, portId, berthNo, status, vesselId',
  });
  await oldDb.table('ports').bulkPut(toPlain(SEED_PORTS));
  await oldDb.table('vessels').bulkPut(toPlain(SEED_VESSELS));
  // 剥掉新字段，模拟 v3 流水；同时去掉 portId 模拟历史数据
  const legacyCalls = SEED_CALLS.map(({ portId: _portId, state: _s, correctsId: _c1, correctedById: _c2, cancelReason: _r, canceledAt: _a, logs: _l, ...rest }) => rest);
  // c-3004 改用全局唯一泊位号 B08（仅 p-1002 有 8 个泊位），用于验证唯一泊位回推
  const c3004Index = legacyCalls.findIndex((c) => c.id === 'c-3004');
  legacyCalls[c3004Index] = { ...legacyCalls[c3004Index], berthNo: 'B08' };
  await oldDb.table('calls').bulkPut(toPlain(legacyCalls));
  for (const port of SEED_PORTS) {
    await oldDb.table('berths').bulkPut(toPlain(buildBerthRecords(port)));
  }
  await oldDb.close();

  // 2) 用当前应用的 db 打开 → 触发 v4 upgrade
  await db.open();
  const calls = await db.calls.toArray();
  assert(calls.length === SEED_CALLS.length, `流水条数应不变（实际 ${calls.length}）`);
  for (const call of calls) {
    assert(call.state === '有效', `${call.id} 应回填 state=有效`);
    assert(call.correctsId === null && call.correctedById === null, `${call.id} 应回填链指针`);
    assert(call.cancelReason === null && call.canceledAt === null, `${call.id} 应回填撤销字段`);
    assert(Array.isArray(call.logs) && call.logs.length === 0, `${call.id} 应回填空 logs`);
  }
  // 唯一泊位号回推
  const c3004 = calls.find((c) => c.id === 'c-3004')!;
  assert(c3004.portId === 'p-1002', `c-3004/B08 应回推到 p-1002，实际 ${c3004.portId ?? '空'}`);
  // B01/B02 同名泊位跨港不唯一，回推留空，运行时按上下文解析
  const c3001 = calls.find((c) => c.id === 'c-3001')!;
  assert(!c3001.portId, `c-3001/B01 同名泊位不唯一应留空，实际 ${c3001.portId}`);

  // 3) 迁移后索引可用：按 state 索引查询
  const indexed = await db.calls.where('state').equals('有效').toArray();
  assert(indexed.length === calls.length, 'state 索引应可查');

  await db.close();
  console.log('✓ v3 → v4 迁移通过：旧记录回填 state/链字段/空日志，portId 按泊位回推，索引可用');
}

void main();
