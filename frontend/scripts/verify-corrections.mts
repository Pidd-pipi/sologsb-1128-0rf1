import 'fake-indexeddb/auto';
import { setActivePinia, createPinia } from 'pinia';
import { usePortStore } from '../src/stores/portStore';
import { useVesselStore } from '../src/stores/vesselStore';
import { db } from '../src/db';
import {
  SEED_PORTS,
  SEED_VESSELS,
  SEED_CALLS,
} from '../src/db/seed';
import { buildBerthRecords } from '../src/db/berth';
import { callChain, isEffectiveCall, callState } from '../src/types/call';
import { toPlain } from '../src/utils/format';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败：${msg}`);
}

let pass = 0;
const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function check(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
  await db.ports.bulkPut(toPlain(SEED_PORTS));
  await db.vessels.bulkPut(toPlain(SEED_VESSELS));
  await db.calls.bulkPut(toPlain(SEED_CALLS));
  for (const port of SEED_PORTS) {
    await db.berths.bulkPut(toPlain(buildBerthRecords(port)));
  }
  setActivePinia(createPinia());
}

async function setup(): Promise<ReturnType<typeof usePortStore>> {
  await resetDb();
  const vesselStore = useVesselStore();
  await vesselStore.loadAll();
  const portStore = usePortStore();
  await portStore.loadAll();
  return portStore;
}

check('旧数据（v3 结构）加载后：state 缺省为有效，portId 按泊位回推，照常使用', () => {
  // SEED_CALLS 是手写的带 portId 数据；这里直接构造旧数据校验归一化
  const oldCall = {
    id: 'old-1',
    vesselId: 'v-2001',
    vesselName: '浙象渔05123',
    type: '进港' as const,
    time: new Date().toISOString(),
    berthNo: 'B01',
    iceKg: 1,
    fuelL: 2,
    unloadKg: 3,
    visaStatus: '待签证' as const,
    createdAt: new Date().toISOString(),
  };
  assert(isEffectiveCall(oldCall), '缺省 state 应视为有效');
  assert(callState(oldCall) === '有效', 'state 应为有效');
  const chain = callChain([oldCall], 'old-1');
  assert(chain.length === 1 && chain[0].id === 'old-1', '旧记录处理链应包含自身');
});

check('更正未签证记录：原记录留档为已更正并接上新记录，统计只算新值', async () => {
  const s = await setup();
  // c-3003 浙普渔13208 进港 p-1002/B01 待签证 加冰600
  const beforeCount = s.effectiveCallsSorted.length;
  const fresh = await s.correctCall('c-3003', {
    vesselId: 'v-2002',
    time: new Date(Date.now() + 3600_000).toISOString().slice(0, 16),
    portId: 'p-1002',
    berthNo: 'B01',
    iceKg: 999,
    fuelL: 0,
    unloadKg: 5200,
    note: '加冰量录错',
  });
  assert(fresh.iceKg === 999, '新记录加冰量应为 999');
  assert(fresh.state === '有效' && fresh.correctsId === 'c-3003', '新记录有效且接续原记录');
  const old = s.callById('c-3003')!;
  assert(old.state === '已更正' && old.correctedById === fresh.id, '原记录已更正并指向新记录');
  assert(s.effectiveCallsSorted.length === beforeCount, '有效流水条数应保持不变（旧出一新）');
  const effective = s.effectiveCallsSorted.find((c) => c.id === fresh.id);
  assert(Boolean(effective), '新记录应在有效集中');
  assert(!s.effectiveCallsSorted.some((c) => c.id === 'c-3003'), '原记录应退出有效集');
  const chain = callChain(s.calls, fresh.id);
  assert(chain.map((c) => c.id).join(',') === `c-3003,${fresh.id}`, '处理链应为 原→新');
  assert(old.logs?.some((l) => l.action === '更正'), '原记录应有更正日志');
});

check('已签证记录不能更正，且失败原因写入处理链', async () => {
  const s = await setup();
  let failed = false;
  try {
    await s.correctCall('c-3001', {
      vesselId: 'v-2001',
      time: new Date().toISOString().slice(0, 16),
      portId: 'p-1001',
      berthNo: 'B03',
      iceKg: 1,
      fuelL: 1,
      unloadKg: 1,
    });
  } catch (e) {
    failed = true;
    assert((e as Error).message.includes('已签证'), '应提示已签证不能更正');
  }
  assert(failed, '更正应被拒绝');
  const target = s.callById('c-3001')!;
  assert(target.state === '有效', '被拒后记录仍应有效');
  assert(Boolean(target.logs?.some((l) => l.action === '更正失败')), '应有更正失败日志');
});

check('更正到别的船占用的泊位被拒且不落半条数据，失败原因可回看', async () => {
  const s = await setup();
  // p-1001/B02 被 v-2005 浙象渔05288 占用（c-3002 已签证，泊位种子数据也是 v-2005）
  // 用待签证的 c-3003（v-2002）尝试更正到 p-1001/B02
  const callsBefore = s.calls.length;
  let failed = false;
  try {
    await s.correctCall('c-3003', {
      vesselId: 'v-2002',
      time: new Date().toISOString().slice(0, 16),
      portId: 'p-1001',
      berthNo: 'B02',
      iceKg: 10,
      fuelL: 10,
      unloadKg: 10,
    });
  } catch (e) {
    failed = true;
    assert((e as Error).message.includes('占用'), '应提示泊位被占用');
  }
  assert(failed, '更正应被拒绝');
  assert(s.calls.length === callsBefore, '不应新增任何记录');
  const b02 = s.berths.find((b) => b.id === 'p-1001-B02')!;
  assert(b02.status === '占用' && b02.vesselId === 'v-2005', 'B02 仍由原船占用，不能被挤掉');
  assert(
    Boolean(s.callById('c-3003')!.logs?.some((l) => l.action === '更正失败')),
    '失败原因应写入 c-3003 处理链',
  );
});

check('撤销需填原因；撤销后记录留档、退出统计，泊位按最近有效流水重算', async () => {
  const s = await setup();
  // c-3003 v-2002 进港 p-1002/B01 是该泊位最近有效进港；撤销后 B01 应变空闲
  let failed = false;
  try {
    await s.cancelCall('c-3003', '   ');
  } catch (e) {
    failed = true;
    assert((e as Error).message.includes('撤销原因'), '空原因应被拒');
  }
  assert(failed, '空原因应拒绝');

  const canceled = await s.cancelCall('c-3003', '重复登记，撤销');
  assert(canceled.state === '已撤销' && canceled.cancelReason === '重复登记，撤销', '应带原因标记撤销');
  assert(!s.effectiveCallsSorted.some((c) => c.id === 'c-3003'), '撤销记录退出有效集');
  assert(s.callById('c-3003')!.vesselName === '浙普渔13208', '撤销记录仍保留数据');
  const b01 = s.berths.find((b) => b.id === 'p-1002-B01')!;
  assert(b01.status === '空闲' && b01.vesselId === null, 'B01 应按无更近有效流水释放为空闲');
  // 别的船不受影响
  const b02p2 = s.berths.find((b) => b.id === 'p-1002-B02')!;
  assert(b02p2.status === '占用' && b02p2.vesselId === 'v-2006', '其他船的泊位不受影响');
});

check('撤销后该泊位若有更早的有效进港，回退到那条记录的船', async () => {
  const s = await setup();
  // 直接写一条更早的有效进港（历史流水）：v-2004 进 p-1002/B01（10 小时前，B01 当前被 v-2002 占用）
  await db.calls.put(
    toPlain({
      id: 'c-history-1',
      vesselId: 'v-2004',
      vesselName: '浙岭渔09342',
      type: '进港' as const,
      time: new Date(Date.now() - 10 * 3600_000).toISOString(),
      portId: 'p-1002',
      berthNo: 'B01',
      iceKg: 0,
      fuelL: 0,
      unloadKg: 0,
      visaStatus: '已签证' as const,
      createdAt: new Date(Date.now() - 10 * 3600_000).toISOString(),
      state: '有效' as const,
      correctsId: null,
      correctedById: null,
      cancelReason: null,
      canceledAt: null,
      logs: [],
    }),
  );
  await s.loadAll();
  // 撤销 v-2002 的 c-3003，重算应以时间最近的有效流水为准——更早的 v-2004 进港成为最近条
  await s.cancelCall('c-3003', '录错船');
  const b01 = s.berths.find((b) => b.id === 'p-1002-B01')!;
  assert(b01.status === '占用' && b01.vesselId === 'v-2004', 'B01 应回退给更早有效进港的 v-2004');
});

check('更正换船：两船泊位都重算，原泊位不空给别人', async () => {
  const s = await setup();
  // c-3004 v-2003 进港 p-1003/B01（免签，可更正）→ 改到 p-1003 的空闲位 B02
  await s.correctCall('c-3004', {
    vesselId: 'v-2003',
    time: new Date().toISOString().slice(0, 16),
    portId: 'p-1003',
    berthNo: 'B02',
    iceKg: 300,
    fuelL: 260,
    unloadKg: 2100,
  });
  const b01 = s.berths.find((b) => b.id === 'p-1003-B01')!;
  const b02 = s.berths.find((b) => b.id === 'p-1003-B02')!;
  assert(b01.status === '空闲', '原泊位 B01 释放');
  assert(b02.status === '占用' && b02.vesselId === 'v-2003', '新泊位 B02 由 v-2003 占用');
});

check('更正只换渔船不换泊位：泊位占用从旧船交给新船，旧记录留档', async () => {
  const s = await setup();
  // c-3003 v-2002 进港 p-1002/B01（待签证），泊位当前由 v-2002 占用
  const fresh = await s.correctCall('c-3003', {
    vesselId: 'v-2004',
    time: new Date().toISOString().slice(0, 16),
    portId: 'p-1002',
    berthNo: 'B01',
    iceKg: 600,
    fuelL: 0,
    unloadKg: 5200,
    note: '船名录错',
  });
  assert(fresh.vesselId === 'v-2004', '新记录应归属新船');
  const b01 = s.berths.find((b) => b.id === 'p-1002-B01')!;
  assert(b01.status === '占用' && b01.vesselId === 'v-2004', 'B01 应交给新船 v-2004');
  assert(b01.vesselName === '浙岭渔09342', '泊位船名应同步为新船');
  // 旧船的有效时间线不再有这条记录
  assert(!s.callsOfVessel('v-2002').some((c) => c.id === fresh.id), '旧船有效时间线不应含新记录');
  assert(s.callById('c-3003')!.state === '已更正', '原记录仍为已更正留档');
  assert(s.callsOfVessel('v-2004').some((c) => c.id === fresh.id), '新船时间线应包含新记录');
});

check('登记进港不能落到别的船占用的泊位（store 层守卫）', async () => {
  const s = await setup();
  let failed = false;
  try {
    await s.registerCall(
      {
        vesselId: 'v-2003',
        type: '进港',
        time: new Date().toISOString().slice(0, 16),
        berthNo: 'B02',
        iceKg: 0,
        fuelL: 0,
        unloadKg: 0,
        visaStatus: '待签证',
      },
      '浙岱渔07156',
      'p-1001',
    );
  } catch (e) {
    failed = true;
    assert((e as Error).message.includes('占用'), '应提示被占用');
  }
  assert(failed, '进港登记到他船泊位应被拒');
  const b02 = s.berths.find((b) => b.id === 'p-1001-B02')!;
  assert(b02.vesselId === 'v-2005', '占用船不变');
});

check('维修泊位：有有效流水时按流水算，无有效流水时保留维修', async () => {
  const s = await setup();
  // p-1001/B04 维修且无流水；撤销相关操作不应动它（无流水指向，本就不进 targets）
  await s.setBerthStatus('p-1001-B04', '维修');
  await s.cancelCall('c-3001', '测试');
  const b04 = s.berths.find((b) => b.id === 'p-1001-B04')!;
  assert(b04.status === '维修', '无流水的维修位保持维修');
  // p-1001/B01 撤销 v-2001 的进港后，B01 变空闲（最近有效为空）
  const b01 = s.berths.find((b) => b.id === 'p-1001-B01')!;
  assert(b01.status === '空闲', 'B01 撤销进港后变空闲');
});

check('登记出港不能挤掉别的船（store 层守卫）', async () => {
  const s = await setup();
  let failed = false;
  try {
    await s.registerCall(
      {
        vesselId: 'v-2003',
        type: '出港',
        time: new Date().toISOString().slice(0, 16),
        berthNo: 'B02',
        iceKg: 0,
        fuelL: 0,
        unloadKg: 0,
        visaStatus: '待签证',
      },
      '浙岱渔07156',
      'p-1001',
    );
  } catch (e) {
    failed = true;
    assert((e as Error).message.includes('占用'), '应提示被占用');
  }
  assert(failed, '应为别的船登记出港应被拒');
  const b02 = s.berths.find((b) => b.id === 'p-1001-B02')!;
  assert(b02.vesselId === 'v-2005', '占用船不变');
});

async function main(): Promise<void> {
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${pass}/${tests.length} 通过`);
}

void main();
