<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useBerthStatus } from '../hooks/useBerthStatus';
import BerthGrid from '../components/common/BerthGrid.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { Berth } from '../types/berth';
import {
  CALL_TYPES,
  VISA_STATUSES,
  callChain,
  callState,
  emptyCallDraft,
  isCorrectionOpen,
  isFailureLog,
  type CallCorrection,
  type CallDraft,
  type CallType,
  type PortCall,
} from '../types/call';
import {
  formatDateTime,
  formatNumber,
  isToday,
  isoToLocalInputValue,
  nowLocalInputValue,
  toPlain,
} from '../utils/format';

interface CallForm extends CallDraft {
  portId: string;
}

const router = useRouter();
const portStore = usePortStore();
const vesselStore = useVesselStore();

const { draft, restored, savedAt, storageKey, persist, restore, clearDraft } = useLocalDraft<CallForm>('call-board', () => ({
  ...emptyCallDraft(),
  portId: '',
  time: nowLocalInputValue(),
}));
const form = draft;

const formRef = ref<FormInstance>();
const submitting = ref(false);
const focusPortId = ref('');

const rules: FormRules = {
  vesselId: [{ required: true, message: '请选择渔船', trigger: 'change' }],
  portId: [{ required: true, message: '请选择泊位', trigger: 'change' }],
  time: [{ required: true, message: '请选择进出港时间', trigger: 'change' }],
};

const vesselOptions = computed(() => vesselStore.vessels);

const selectedVessel = computed(() => vesselStore.vesselById(form.value.vesselId));

/**
 * 进港只能选空闲泊位（不能挤掉别的船）；
 * 出港只能选「空闲」或「本船当前占用」的泊位。
 */
const berthOptions = computed(() => {
  const list =
    form.value.type === '进港'
      ? portStore.berths.filter((b) => b.status === '空闲')
      : portStore.berths.filter(
          (b) => b.status === '空闲' || (b.status === '占用' && b.vesselId === form.value.vesselId),
        );
  return list
    .map((b) => ({
      value: `${b.portId}|${b.berthNo}`,
      label: `${portStore.portById(b.portId)?.name ?? b.portId} · ${b.berthNo}`,
      portId: b.portId,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
});

const berthKey = computed({
  get: () => (form.value.portId && form.value.berthNo ? `${form.value.portId}|${form.value.berthNo}` : ''),
  set: (key: string) => {
    const [portId, berthNo] = String(key).split('|');
    form.value.portId = portId ?? '';
    form.value.berthNo = berthNo ?? '';
    focusPortId.value = portId ?? '';
  },
});

const focusBerths = computed<Berth[]>(() =>
  focusPortId.value ? portStore.berthsOf(focusPortId.value) : [],
);

const berthRef = computed(() => portStore.berths);
const { summary } = useBerthStatus(berthRef, computed(() => focusPortId.value));

/** 今日全部流水（含已更正、已撤销，用于回看处理链） */
const todayCalls = computed(() => portStore.callsSorted.filter((c) => isToday(c.time)));

/** 今日有效流水：已更正、已撤销的记录不再计入统计 */
const todayEffective = computed(() => todayCalls.value.filter((c) => callState(c) === '有效'));

const todayStats = computed(() => ({
  inbound: todayEffective.value.filter((c) => c.type === '进港').length,
  outbound: todayEffective.value.filter((c) => c.type === '出港').length,
  ice: todayEffective.value.reduce((sum, c) => sum + c.iceKg, 0),
  fuel: todayEffective.value.reduce((sum, c) => sum + c.fuelL, 0),
  unload: todayEffective.value.reduce((sum, c) => sum + c.unloadKg, 0),
}));

function hasContent(value: CallForm): boolean {
  return (
    Boolean(value.vesselId) ||
    Boolean(value.berthNo) ||
    Number(value.iceKg) > 0 ||
    Number(value.fuelL) > 0 ||
    Number(value.unloadKg) > 0
  );
}

onMounted(async () => {
  if (!portStore.ports.length) await portStore.loadAll();
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (restore()) {
    if (hasContent(form.value)) {
      ElMessage.info(`已恢复本地草稿（保存于 ${formatDateTime(savedAt.value)}）`);
    } else {
      // 空草稿没有恢复价值，直接清掉，避免误报「已恢复草稿」
      clearDraft();
    }
  }
  if (form.value.portId) focusPortId.value = form.value.portId;
});

watch(
  () => toPlain(form.value),
  (value) => {
    // 只有存在有效输入时才落草稿；提交后表单被重置，草稿同步清空
    if (hasContent(value)) persist();
    else clearDraft();
  },
  { deep: true },
);

watch(
  () => [form.value.type, form.value.vesselId] as const,
  () => {
    const valid = berthOptions.value.some((opt) => opt.value === berthKey.value);
    if (!valid) berthKey.value = '';
  },
);

function selectBerth(berth: Berth): void {
  berthKey.value = `${berth.portId}|${berth.berthNo}`;
  ElMessage.info(`已选择 ${berth.berthNo}`);
}

async function submit(): Promise<void> {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;
  if (!selectedVessel.value) {
    ElMessage.warning('请选择有效的渔船');
    return;
  }
  submitting.value = true;
  try {
    const payload: CallDraft = {
      vesselId: form.value.vesselId,
      type: form.value.type,
      time: form.value.time,
      berthNo: form.value.berthNo,
      iceKg: Number(form.value.iceKg) || 0,
      fuelL: Number(form.value.fuelL) || 0,
      unloadKg: Number(form.value.unloadKg) || 0,
      visaStatus: form.value.visaStatus,
    };
    const call = await portStore.registerCall(payload, selectedVessel.value.name, form.value.portId);
    ElMessage.success(`已登记 ${call.vesselName} ${call.type} · 泊位 ${call.berthNo}`);
    clearDraft();
    Object.assign(form.value, {
      ...emptyCallDraft(),
      portId: '',
      time: nowLocalInputValue(),
    });
    focusPortId.value = '';
  } catch (error) {
    ElMessage.error(`登记失败：${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
}

function openVessel(vesselId: string): void {
  void router.push(`/vessels/${vesselId}`);
}

/* ---------------- 更正 ---------------- */

const correctVisible = ref(false);
const correctSaving = ref(false);
const correctRef = ref<FormInstance>();
const correctingId = ref('');
const correctForm = ref<CallCorrection & { note: string }>({
  vesselId: '',
  time: '',
  portId: '',
  berthNo: '',
  iceKg: 0,
  fuelL: 0,
  unloadKg: 0,
  note: '',
});

const correctRules: FormRules = {
  vesselId: [{ required: true, message: '请选择渔船', trigger: 'change' }],
  portId: [{ required: true, message: '请选择泊位', trigger: 'change' }],
  time: [{ required: true, message: '请选择时间', trigger: 'change' }],
};

const correctingCall = computed(() => portStore.callById(correctingId.value));

/** 更正弹窗可选泊位：空闲 / 维修排除 / 本船占用位可改回；源泊位始终保留（只换船不换位时要能选中） */
const correctBerthOptions = computed(() => {
  const vesselId = correctForm.value.vesselId;
  const source = correctingCall.value;
  return portStore.berths
    .filter((b) => {
      if (b.status === '维修') return false;
      if (b.status === '空闲' || b.vesselId === vesselId) return true;
      return Boolean(source) && source!.portId === b.portId && source!.berthNo === b.berthNo;
    })
    .map((b) => ({
      value: `${b.portId}|${b.berthNo}`,
      label: `${portStore.portById(b.portId)?.name ?? b.portId} · ${b.berthNo}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
});

const correctBerthKey = computed({
  get: () =>
    correctForm.value.portId && correctForm.value.berthNo
      ? `${correctForm.value.portId}|${correctForm.value.berthNo}`
      : '',
  set: (key: string) => {
    const [portId, berthNo] = String(key).split('|');
    correctForm.value.portId = portId ?? '';
    correctForm.value.berthNo = berthNo ?? '';
  },
});

watch(
  () => correctForm.value.vesselId,
  () => {
    const valid = correctBerthOptions.value.some((opt) => opt.value === correctBerthKey.value);
    if (!valid) correctBerthKey.value = '';
  },
);

function openCorrect(call: PortCall): void {
  if (!isCorrectionOpen(call)) {
    ElMessage.warning('只有未签证的有效记录可以更正');
    return;
  }
  correctingId.value = call.id;
  correctForm.value = {
    vesselId: call.vesselId,
    time: isoToLocalInputValue(call.time),
    portId: call.portId ?? '',
    berthNo: call.berthNo,
    iceKg: call.iceKg,
    fuelL: call.fuelL,
    unloadKg: call.unloadKg,
    note: '',
  };
  correctVisible.value = true;
}

async function submitCorrect(): Promise<void> {
  if (!correctRef.value) return;
  const valid = await correctRef.value.validate().catch(() => false);
  if (!valid) return;
  correctSaving.value = true;
  try {
    const fresh = await portStore.correctCall(correctingId.value, { ...correctForm.value });
    ElMessage.success(`已更正，新记录已接续：${fresh.vesselName} · 泊位 ${fresh.berthNo}`);
    correctVisible.value = false;
  } catch (error) {
    ElMessage.error(`更正失败：${(error as Error).message}（失败原因已写入处理链）`);
  } finally {
    correctSaving.value = false;
  }
}

/* ---------------- 撤销 ---------------- */

const cancelVisible = ref(false);
const cancelSaving = ref(false);
const cancelingId = ref('');
const cancelReason = ref('');

const cancelingCall = computed(() => portStore.callById(cancelingId.value));

function openCancel(call: PortCall): void {
  if (callState(call) !== '有效') {
    ElMessage.warning('只有有效记录可以撤销');
    return;
  }
  cancelingId.value = call.id;
  cancelReason.value = '';
  cancelVisible.value = true;
}

async function submitCancel(): Promise<void> {
  if (!cancelReason.value.trim()) {
    ElMessage.warning('请填写撤销原因');
    return;
  }
  cancelSaving.value = true;
  try {
    await portStore.cancelCall(cancelingId.value, cancelReason.value);
    ElMessage.success('已撤销，该记录不再计入在港状态与今日统计');
    cancelVisible.value = false;
  } catch (error) {
    ElMessage.error(`撤销失败：${(error as Error).message}（失败原因已写入处理链）`);
  } finally {
    cancelSaving.value = false;
  }
}

/* ---------------- 处理链回看 ---------------- */

const chainVisible = ref(false);
const chainCallId = ref('');

const chainRecords = computed(() => (chainCallId.value ? callChain(portStore.calls, chainCallId.value) : []));

/** 历史流水状态筛选（登记页回看任意日期的处理链与失败原因） */
const historyStateFilter = ref<'全部' | '有效' | '已更正' | '已撤销'>('全部');

const filteredHistory = computed(() => {
  const list = portStore.callsSorted;
  return historyStateFilter.value === '全部' ? list : list.filter((c) => callState(c) === historyStateFilter.value);
});

function openChain(call: PortCall): void {
  chainCallId.value = call.id;
  chainVisible.value = true;
}

function chainNodeTagType(node: PortCall): 'success' | 'warning' | 'info' {
  const state = callState(node);
  if (state === '有效') return 'success';
  if (state === '已更正') return 'warning';
  return 'info';
}

function stateTagType(state: ReturnType<typeof callState>): 'success' | 'warning' | 'info' {
  if (state === '有效') return 'success';
  if (state === '已更正') return 'warning';
  return 'info';
}

function rowClassName({ row }: { row: PortCall }): string {
  return callState(row) === '已撤销' ? 'call-row--canceled' : '';
}
</script>

<template>
  <section class="page">
    <header class="page__head">
      <div>
        <h1>进出港登记</h1>
        <p class="page__sub">
          选择渔船与进出港类型，填写泊位号、加冰量、加油量与卸货量，提交后自动同步泊位占用状态
        </p>
      </div>
    </header>

    <el-alert
      v-if="restored"
      type="info"
      show-icon
      :closable="false"
      title="已从浏览器本地草稿恢复未提交的表单"
      data-testid="draft-alert"
      class="draft-alert"
    >
      <template #default>
        草稿保存在 localStorage（键 {{ storageKey }}），提交成功后会清空。
      </template>
    </el-alert>

    <el-row :gutter="16">
      <el-col :lg="13" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header><span class="card-title">登记表单</span></template>
          <el-form ref="formRef" :model="form" :rules="rules" label-width="110px" data-testid="call-form">
            <el-form-item label="渔船" prop="vesselId">
              <el-select id="call-vessel" v-model="form.vesselId" placeholder="请选择渔船" filterable style="width: 100%">
                <el-option
                  v-for="v in vesselOptions"
                  :key="v.id"
                  :label="`${v.name}（${v.homePort} · ${formatNumber(v.enginePower, 0)}kW）`"
                  :value="v.id"
                />
              </el-select>
            </el-form-item>

            <el-form-item label="进出港类型" prop="type">
              <el-radio-group v-model="form.type" data-testid="call-type">
                <el-radio-button v-for="t in CALL_TYPES" :key="t" :value="t">{{ t }}</el-radio-button>
              </el-radio-group>
            </el-form-item>

            <el-form-item label="时间" prop="time">
              <el-date-picker
                id="call-time"
                v-model="form.time"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                placeholder="选择时间"
                style="width: 100%"
              />
            </el-form-item>

            <el-form-item label="泊位号" prop="portId">
              <el-select
                id="call-berth"
                v-model="berthKey"
                :placeholder="form.type === '进港' ? '选择空闲泊位' : '选择本船占用 / 空闲泊位'"
                style="width: 100%"
                data-testid="call-berth"
              >
                <el-option v-for="opt in berthOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>

            <el-row :gutter="12">
              <el-col :span="8">
                <el-form-item label="加冰 kg" prop="iceKg">
                  <el-input-number id="call-ice" v-model="form.iceKg" :min="0" :max="20000" :step="50" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="加油 L" prop="fuelL">
                  <el-input-number id="call-fuel" v-model="form.fuelL" :min="0" :max="20000" :step="50" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="卸货量 kg" prop="unloadKg">
                  <el-input-number id="call-unload" v-model="form.unloadKg" :min="0" :max="200000" :step="100" style="width: 100%" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item label="签证状态" prop="visaStatus">
              <el-select id="call-visa" v-model="form.visaStatus" style="width: 100%">
                <el-option v-for="s in VISA_STATUSES" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>

            <el-form-item>
              <el-button type="primary" :loading="submitting" data-testid="submit-call" @click="submit">保存登记</el-button>
              <el-button data-testid="clear-draft" @click="clearDraft(); ElMessage.success('草稿已清空')">清空草稿</el-button>
              <el-button v-if="selectedVessel" text type="primary" @click="openVessel(selectedVessel.id)">查看渔船档案</el-button>
            </el-form-item>
          </el-form>
          <p class="detail-hint">
            登记出错时：未签证记录可直接「更正」（原记录留档并接续新记录）；任意记录可「撤销」（需填原因，留档但不再计入在港状态与统计）。
          </p>
        </el-card>
      </el-col>

      <el-col :lg="11" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">今日统计<span class="card-title__sub">（仅有效记录）</span></span>
          </template>
          <div class="stat-row">
            <div class="stat"><span class="stat__label">进港</span><b>{{ todayStats.inbound }}</b></div>
            <div class="stat"><span class="stat__label">出港</span><b>{{ todayStats.outbound }}</b></div>
            <div class="stat"><span class="stat__label">加冰 kg</span><b>{{ formatNumber(todayStats.ice, 0) }}</b></div>
            <div class="stat"><span class="stat__label">加油 L</span><b>{{ formatNumber(todayStats.fuel, 0) }}</b></div>
            <div class="stat"><span class="stat__label">卸货 kg</span><b>{{ formatNumber(todayStats.unload, 0) }}</b></div>
          </div>
        </el-card>

        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">
              泊位占用网格{{ focusPortId ? ` · ${portStore.portById(focusPortId)?.name ?? ''}` : '（选择泊位后聚焦对应渔港）' }}
            </span>
          </template>
          <BerthGrid v-if="focusBerths.length" :berths="focusBerths" @select="selectBerth" />
          <EmptyState v-else title="尚未选择渔港泊位" description="在左侧表单选择泊位，或直接点击泊位网格中的方块。">
            <el-button type="primary" @click="focusPortId = portStore.ports[0]?.id ?? ''">聚焦第一座渔港</el-button>
          </EmptyState>
          <p v-if="focusBerths.length" class="detail-hint">
            占用率 {{ (summary.occupancyRate * 100).toFixed(1) }}% · 占用 {{ summary.occupied }} · 空闲 {{ summary.free }} · 维修 {{ summary.maintenance }}
          </p>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="detail-card">
      <template #header>
        <span class="card-title">
          今日流水（{{ todayCalls.length }} 条，有效 {{ todayEffective.length }} 条）
        </span>
      </template>
      <el-table
        :data="todayCalls"
        size="small"
        border
        empty-text="今日暂无进出港流水"
        data-testid="today-calls"
        :row-class-name="rowClassName"
      >
        <el-table-column label="状态" width="86">
          <template #default="scope">
            <el-tag size="small" :type="stateTagType(callState(scope.row))" data-testid="call-state">
              {{ callState(scope.row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="vesselName" label="船名" min-width="130" />
        <el-table-column prop="type" label="类型" width="80" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column label="泊位" min-width="150">
          <template #default="scope">
            {{ portStore.portById(scope.row.portId)?.name ?? '—' }} · {{ scope.row.berthNo }}
          </template>
        </el-table-column>
        <el-table-column label="加冰 kg" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.iceKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="加油 L" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.fuelL, 0) }}</template>
        </el-table-column>
        <el-table-column label="卸货 kg" min-width="110">
          <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
        </el-table-column>
        <el-table-column prop="visaStatus" label="签证状态" width="100" />
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="scope">
            <el-button
              text
              type="primary"
              size="small"
              data-testid="correct-call"
              :disabled="!isCorrectionOpen(scope.row)"
              @click="openCorrect(scope.row)"
            >
              更正
            </el-button>
            <el-button
              text
              type="danger"
              size="small"
              data-testid="cancel-call"
              :disabled="callState(scope.row) !== '有效'"
              @click="openCancel(scope.row)"
            >
              撤销
            </el-button>
            <el-button text size="small" data-testid="open-chain" @click="openChain(scope.row)">处理链</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="detail-card">
      <template #header>
        <div class="history-head">
          <span class="card-title">历史流水（{{ filteredHistory.length }} 条）</span>
          <el-radio-group v-model="historyStateFilter" size="small" data-testid="history-filter">
            <el-radio-button value="全部">全部</el-radio-button>
            <el-radio-button value="有效">有效</el-radio-button>
            <el-radio-button value="已更正">已更正</el-radio-button>
            <el-radio-button value="已撤销">已撤销</el-radio-button>
          </el-radio-group>
        </div>
      </template>
      <el-table :data="filteredHistory" size="small" border max-height="360" empty-text="暂无流水" data-testid="history-calls">
        <el-table-column label="状态" width="86">
          <template #default="scope">
            <el-tag size="small" :type="stateTagType(callState(scope.row))">{{ callState(scope.row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="vesselName" label="船名" min-width="130" />
        <el-table-column prop="type" label="类型" width="72" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column label="泊位" min-width="140">
          <template #default="scope">
            {{ portStore.portById(scope.row.portId)?.name ?? '—' }} · {{ scope.row.berthNo }}
          </template>
        </el-table-column>
        <el-table-column label="补给" min-width="180">
          <template #default="scope">
            冰 {{ formatNumber(scope.row.iceKg, 0) }} / 油 {{ formatNumber(scope.row.fuelL, 0) }} / 卸 {{ formatNumber(scope.row.unloadKg, 0) }}
          </template>
        </el-table-column>
        <el-table-column label="撤销原因" min-width="160">
          <template #default="scope">
            <span v-if="scope.row.cancelReason" class="cancel-text">{{ scope.row.cancelReason }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="scope">
            <el-button
              text
              type="primary"
              size="small"
              :disabled="!isCorrectionOpen(scope.row)"
              @click="openCorrect(scope.row)"
            >
              更正
            </el-button>
            <el-button
              text
              type="danger"
              size="small"
              :disabled="callState(scope.row) !== '有效'"
              @click="openCancel(scope.row)"
            >
              撤销
            </el-button>
            <el-button text size="small" @click="openChain(scope.row)">处理链</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 更正弹窗 -->
    <el-dialog v-model="correctVisible" title="更正进出港记录" width="620px" data-testid="correct-dialog">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="保存后原记录留档为「已更正」，并接续一条新记录；泊位状态按有效流水自动重算，不会挤掉别的船。"
        class="dialog-alert"
      />
      <el-form
        v-if="correctingCall"
        ref="correctRef"
        :model="correctForm"
        :rules="correctRules"
        label-width="110px"
        data-testid="correct-form"
      >
        <el-form-item label="原记录">
          <span class="muted">
            {{ correctingCall.vesselName }} · {{ correctingCall.type }} · {{ formatDateTime(correctingCall.time) }} · 泊位 {{ correctingCall.berthNo }}
          </span>
        </el-form-item>
        <el-form-item label="渔船" prop="vesselId">
          <el-select v-model="correctForm.vesselId" placeholder="请选择渔船" filterable style="width: 100%">
            <el-option
              v-for="v in vesselOptions"
              :key="v.id"
              :label="`${v.name}（${v.homePort}）`"
              :value="v.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="时间" prop="time">
          <el-date-picker
            v-model="correctForm.time"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            placeholder="选择时间"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="泊位" prop="portId">
          <el-select v-model="correctBerthKey" placeholder="选择空闲 / 本船占用泊位" style="width: 100%">
            <el-option v-for="opt in correctBerthOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="加冰 kg">
              <el-input-number v-model="correctForm.iceKg" :min="0" :max="20000" :step="50" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="加油 L">
              <el-input-number v-model="correctForm.fuelL" :min="0" :max="20000" :step="50" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="卸货 kg">
              <el-input-number v-model="correctForm.unloadKg" :min="0" :max="200000" :step="100" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="更正说明">
          <el-input v-model="correctForm.note" type="textarea" :rows="2" placeholder="可选，如：登记员笔误" />
        </el-form-item>
        <el-form-item v-if="correctingCall">
          <span class="muted">进出港类型与签证状态（{{ correctingCall.visaStatus }}）沿用原记录，不在更正范围内。</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="correctVisible = false">取消</el-button>
        <el-button type="primary" :loading="correctSaving" data-testid="submit-correct" @click="submitCorrect">保存更正</el-button>
      </template>
    </el-dialog>

    <!-- 撤销弹窗 -->
    <el-dialog v-model="cancelVisible" title="撤销进出港记录" width="520px" data-testid="cancel-dialog">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="撤销后记录保留可查，但不再计入在港状态与今日统计；泊位状态按最近一条有效流水自动重算。"
        class="dialog-alert"
      />
      <div v-if="cancelingCall" class="cancel-source">
        <el-tag size="small" :type="cancelingCall.type === '进港' ? 'primary' : 'success'">{{ cancelingCall.type }}</el-tag>
        <span>{{ cancelingCall.vesselName }} · {{ formatDateTime(cancelingCall.time) }} · 泊位 {{ cancelingCall.berthNo }}</span>
      </div>
      <el-form label-width="90px" data-testid="cancel-form">
        <el-form-item label="撤销原因" required>
          <el-input
            v-model="cancelReason"
            type="textarea"
            :rows="3"
            placeholder="必填，如：重复登记 / 船名泊位录错"
            data-testid="cancel-reason"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cancelVisible = false">取消</el-button>
        <el-button type="danger" :loading="cancelSaving" data-testid="submit-cancel" @click="submitCancel">确认撤销</el-button>
      </template>
    </el-dialog>

    <!-- 处理链弹窗 -->
    <el-dialog v-model="chainVisible" title="更正 / 撤销处理链" width="640px" data-testid="chain-dialog">
      <el-timeline v-if="chainRecords.length">
        <el-timeline-item
          v-for="(node, index) in chainRecords"
          :key="node.id"
          :type="chainNodeTagType(node)"
          placement="top"
          :timestamp="formatDateTime(node.time)"
        >
          <div class="chain-head">
            <el-tag size="small" :type="chainNodeTagType(node)">{{ callState(node) }}</el-tag>
            <el-tag size="small" :type="node.type === '进港' ? 'primary' : 'success'">{{ node.type }}</el-tag>
            <b>{{ node.vesselName }}</b>
            <span class="muted">泊位 {{ node.berthNo }}</span>
            <span v-if="index === 0" class="muted">（原始记录）</span>
          </div>
          <div class="chain-metrics muted">
            加冰 {{ formatNumber(node.iceKg, 0) }} kg · 加油 {{ formatNumber(node.fuelL, 0) }} L · 卸货 {{ formatNumber(node.unloadKg, 0) }} kg · {{ node.visaStatus }}
          </div>
          <div v-if="node.cancelReason" class="chain-reason">
            撤销原因（{{ formatDateTime(node.canceledAt) }}）：{{ node.cancelReason }}
          </div>
          <ul v-if="node.logs?.length" class="chain-logs">
            <li
              v-for="(log, i) in node.logs"
              :key="i"
              :class="{ 'chain-logs__item--fail': isFailureLog(log) }"
              data-testid="chain-log"
            >
              <el-tag size="small" :type="isFailureLog(log) ? 'danger' : 'info'">{{ log.action }}</el-tag>
              <span>{{ formatDateTime(log.at) }}</span>
              <span v-if="log.detail">{{ log.detail }}</span>
            </li>
          </ul>
        </el-timeline-item>
      </el-timeline>
      <EmptyState v-else title="无处理链" description="该记录尚未发生更正或撤销。" />
      <template #footer>
        <el-button @click="chainVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page__head h1 {
  margin: 0;
  font-size: 22px;
  color: #17324d;
}
.page__sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6b7c8c;
}
.detail-card {
  border-radius: 10px;
  margin-bottom: 16px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.card-title__sub {
  font-weight: 400;
  font-size: 12px;
  color: #8592a0;
}
.draft-alert {
  border-radius: 10px;
}
.dialog-alert {
  margin-bottom: 14px;
}
.stat-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat__label {
  font-size: 12px;
  color: #7b8a99;
}
.stat b {
  font-size: 18px;
  color: #17324d;
}
.detail-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #6b7c8c;
}
.muted {
  color: #8592a0;
  font-size: 12px;
}
.cancel-source {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 14px;
  font-size: 13px;
  color: #4b5c6d;
}
.history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.cancel-text {
  font-size: 12px;
  color: #b53f3f;
}
.chain-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.chain-metrics {
  margin-top: 4px;
}
.chain-reason {
  margin-top: 6px;
  font-size: 13px;
  color: #b53f3f;
}
.chain-logs {
  margin: 8px 0 0;
  padding-left: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.chain-logs li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #5b6b7b;
}
.chain-logs__item--fail {
  color: #b53f3f;
}
:deep(.call-row--canceled) {
  color: #a8b4bf;
  text-decoration: line-through;
}
</style>
