<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { WarningFilled } from '@element-plus/icons-vue';
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
  emptyCallDraft,
  isEffectiveCall,
  type CallDraft,
  type CallType,
  type PortCall,
} from '../types/call';
import type { CallChainEntry } from '../stores/portStore';
import { formatDateTime, formatNumber, isToday, nowLocalInputValue, toPlain } from '../utils/format';

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

/** 进港只能选空闲泊位；出港只能选已占用泊位 */
const berthOptions = computed(() => berthOptionsFor(form.value.type, berthKey.value));

/** 候选泊位：按类型过滤，但始终保留当前已选中的泊位（避免回填时被过滤掉） */
function berthOptionsFor(type: CallType, currentKey = '') {
  const wanted = type === '进港' ? '空闲' : '占用';
  return portStore.berths
    .filter((b) => b.status === wanted || `${b.portId}|${b.berthNo}` === currentKey)
    .map((b) => ({
      value: `${b.portId}|${b.berthNo}`,
      label: `${portStore.portById(b.portId)?.name ?? b.portId} · ${b.berthNo}`,
      portId: b.portId,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

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

/** 今日流水保留全部记录（含已更正 / 已撤销），状态单独标注；统计只算有效记录 */
const todayCalls = computed(() => portStore.callsSorted.filter((c) => isToday(c.time)));
const todayEffectiveCalls = computed(() => todayCalls.value.filter(isEffectiveCall));

const todayStats = computed(() => ({
  inbound: todayEffectiveCalls.value.filter((c) => c.type === '进港').length,
  outbound: todayEffectiveCalls.value.filter((c) => c.type === '出港').length,
  ice: todayEffectiveCalls.value.reduce((sum, c) => sum + c.iceKg, 0),
  fuel: todayEffectiveCalls.value.reduce((sum, c) => sum + c.fuelL, 0),
  unload: todayEffectiveCalls.value.reduce((sum, c) => sum + c.unloadKg, 0),
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
  () => form.value.type,
  () => {
    const valid = berthOptions.value.some((opt) => opt.value === berthKey.value);
    if (!valid) berthKey.value = '';
  },
);

function selectBerth(berth: Berth): void {
  berthKey.value = `${berth.portId}|${berth.berthNo}`;
  ElMessage.info(`已选择 ${berth.berthNo}`);
}

function reportRecomputeErrors(call: PortCall): void {
  if (call.recomputeError) ElMessage.warning(`已登记，但泊位状态未同步：${call.recomputeError}`);
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
    reportRecomputeErrors(call);
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

/** 未签证（待签证 / 免签）且当前有效，才允许更正 */
function canCorrect(call: PortCall): boolean {
  return isEffectiveCall(call) && call.visaStatus !== '已签证';
}

function canVoid(call: PortCall): boolean {
  return isEffectiveCall(call);
}

/* ---------------- 更正 ---------------- */

const correctionVisible = ref(false);
const correctionSaving = ref(false);
const correctionRef = ref<FormInstance>();
const correctionTarget = ref<PortCall | null>(null);
const correctionForm = reactive<CallForm>({
  ...emptyCallDraft(),
  portId: '',
  time: '',
});

const correctionRules: FormRules = {
  vesselId: [{ required: true, message: '请选择渔船', trigger: 'change' }],
  portId: [{ required: true, message: '请选择泊位', trigger: 'change' }],
  time: [{ required: true, message: '请选择进出港时间', trigger: 'change' }],
};

const correctionVessel = computed(() => vesselStore.vesselById(correctionForm.vesselId));
const correctionBerthKey = computed({
  get: () =>
    correctionForm.portId && correctionForm.berthNo ? `${correctionForm.portId}|${correctionForm.berthNo}` : '',
  set: (key: string) => {
    const [portId, berthNo] = String(key).split('|');
    correctionForm.portId = portId ?? '';
    correctionForm.berthNo = berthNo ?? '';
  },
});

/** 更正不允许改进出港类型，泊位候选项沿用原类型（进港选空闲、出港选占用） */
const correctionBerthOptions = computed(() =>
  correctionTarget.value
    ? berthOptionsFor(correctionTarget.value.type, correctionBerthKey.value)
    : [],
);

function isoToInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openCorrection(call: PortCall): void {
  if (!canCorrect(call)) {
    ElMessage.warning(call.visaStatus === '已签证' ? '已签证记录不能更正' : '该记录已处理');
    return;
  }
  correctionTarget.value = call;
  Object.assign(correctionForm, {
    vesselId: call.vesselId,
    type: call.type,
    time: isoToInputValue(call.time),
    berthNo: call.berthNo,
    portId: call.portId ?? '',
    iceKg: call.iceKg,
    fuelL: call.fuelL,
    unloadKg: call.unloadKg,
    visaStatus: call.visaStatus,
  });
  correctionVisible.value = true;
}

async function submitCorrection(): Promise<void> {
  if (!correctionRef.value || !correctionTarget.value) return;
  const valid = await correctionRef.value.validate().catch(() => false);
  if (!valid) return;
  if (!correctionVessel.value) {
    ElMessage.warning('请选择有效的渔船');
    return;
  }
  correctionSaving.value = true;
  try {
    const next = await portStore.correctCall(
      correctionTarget.value.id,
      {
        vesselId: correctionForm.vesselId,
        time: correctionForm.time,
        berthNo: correctionForm.berthNo,
        portId: correctionForm.portId,
        iceKg: Number(correctionForm.iceKg) || 0,
        fuelL: Number(correctionForm.fuelL) || 0,
        unloadKg: Number(correctionForm.unloadKg) || 0,
      },
      correctionVessel.value.name,
    );
    ElMessage.success(`已更正，原记录留档，新记录已生效（泊位 ${next.berthNo}）`);
    if (next.recomputeError) ElMessage.warning(`泊位状态未同步：${next.recomputeError}`);
    correctionVisible.value = false;
    correctionTarget.value = null;
  } catch (error) {
    ElMessage.error(`更正失败：${(error as Error).message}`);
  } finally {
    correctionSaving.value = false;
  }
}

/* ---------------- 撤销 ---------------- */

const voidTarget = ref<PortCall | null>(null);
const voidReason = ref('');
const voidSaving = ref(false);

async function openVoid(call: PortCall): Promise<void> {
  if (!canVoid(call)) {
    ElMessage.warning('该记录已处理');
    return;
  }
  try {
    const { value } = await ElMessageBox.prompt('请填写撤销原因（记录将保留，但不再计入在港状态与统计）', `撤销 ${call.vesselName} 的${call.type}记录`, {
      confirmButtonText: '确认撤销',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputPlaceholder: '如：泊位号登记错误 / 重复登记 / 补给量填写有误',
      inputValue: '',
      inputValidator: (v: string) => (v && v.trim() ? true : '撤销原因不能为空'),
    });
    voidTarget.value = call;
    voidReason.value = value;
    await confirmVoid();
  } catch {
    // 用户取消输入
  }
}

async function confirmVoid(): Promise<void> {
  const target = voidTarget.value;
  if (!target) return;
  voidSaving.value = true;
  try {
    await portStore.voidCall(target.id, voidReason.value);
    ElMessage.success('已撤销，该记录不再计入在港状态与统计');
    voidTarget.value = null;
    voidReason.value = '';
  } catch (error) {
    ElMessage.error(`撤销失败：${(error as Error).message}`);
  } finally {
    voidSaving.value = false;
  }
}

/* ---------------- 处理链 ---------------- */

const chainVisible = ref(false);
const chainEntries = ref<CallChainEntry[]>([]);
const chainTitle = ref('');

function openChain(call: PortCall): void {
  chainEntries.value = portStore.callChain(call.id);
  chainTitle.value = `${call.vesselName} · ${call.type}记录处理链`;
  chainVisible.value = true;
}

function lifecycleTagType(call: PortCall): 'success' | 'warning' | 'info' {
  const lifecycle = call.lifecycle ?? '正常';
  if (lifecycle === '正常') return 'success';
  if (lifecycle === '已更正') return 'warning';
  return 'info';
}

function lifecycleText(call: PortCall): string {
  return call.lifecycle ?? '正常';
}

function rowClassName({ row }: { row: PortCall }): string {
  const lifecycle = row.lifecycle ?? '正常';
  if (lifecycle === '已撤销') return 'call-row call-row--void';
  if (lifecycle === '已更正') return 'call-row call-row--corrected';
  if (row.recomputeError) return 'call-row call-row--error';
  return 'call-row';
}

function berthLabelOf(call: PortCall): string {
  if (call.portId) return `${portStore.portById(call.portId)?.name ?? ''} · ${call.berthNo}`;
  return call.berthNo;
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
                :placeholder="form.type === '进港' ? '选择空闲泊位' : '选择已占用泊位'"
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
        </el-card>
      </el-col>

      <el-col :lg="11" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">今日统计</span>
            <span class="card-title__hint">（仅计有效记录，已更正 / 已撤销不计入）</span>
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
        <span class="card-title">今日流水（{{ todayCalls.length }} 条，有效 {{ todayEffectiveCalls.length }} 条）</span>
        <span class="card-title__hint">未签证记录可更正，任意记录可撤销；处理链可回看更正与撤销原因</span>
      </template>
      <el-table
        :data="todayCalls"
        size="small"
        border
        empty-text="今日暂无进出港流水"
        data-testid="today-calls"
        :row-class-name="rowClassName"
      >
        <el-table-column prop="vesselName" label="船名" min-width="130" />
        <el-table-column prop="type" label="类型" width="70" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column label="泊位" min-width="150">
          <template #default="scope">{{ berthLabelOf(scope.row) }}</template>
        </el-table-column>
        <el-table-column label="加冰 kg" min-width="90">
          <template #default="scope">{{ formatNumber(scope.row.iceKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="加油 L" min-width="90">
          <template #default="scope">{{ formatNumber(scope.row.fuelL, 0) }}</template>
        </el-table-column>
        <el-table-column label="卸货 kg" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
        </el-table-column>
        <el-table-column prop="visaStatus" label="签证" width="90" />
        <el-table-column label="状态" width="100">
          <template #default="scope">
            <el-tag size="small" :type="lifecycleTagType(scope.row)" effect="plain">
              {{ lifecycleText(scope.row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="scope">
            <el-button
              text
              type="primary"
              size="small"
              data-testid="correct-call"
              :disabled="!canCorrect(scope.row)"
              @click="openCorrection(scope.row)"
            >
              更正
            </el-button>
            <el-button
              text
              type="danger"
              size="small"
              data-testid="void-call"
              :disabled="!canVoid(scope.row)"
              @click="openVoid(scope.row)"
            >
              撤销
            </el-button>
            <el-button text type="info" size="small" data-testid="chain-call" @click="openChain(scope.row)">
              处理链
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-alert
        v-for="call in todayCalls.filter((c) => c.recomputeError)"
        :key="call.id"
        class="error-alert"
        type="warning"
        show-icon
        :icon="WarningFilled"
        :closable="false"
        data-testid="recompute-error"
      >
        <template #title>
          {{ call.vesselName }} {{ formatDateTime(call.time) }} 的{{ call.type }}记录同步失败：{{ call.recomputeError }}
        </template>
      </el-alert>
    </el-card>

    <!-- 更正对话框 -->
    <el-dialog v-model="correctionVisible" title="更正进出港记录" width="640px" data-testid="correction-dialog">
      <el-alert
        v-if="correctionTarget"
        type="info"
        :closable="false"
        show-icon
        class="draft-alert"
        :title="`更正后原记录保留为「已更正」并接出新记录；进出港类型（${correctionTarget.type}）与签证状态不可修改。`"
      />
      <el-form
        v-if="correctionTarget"
        ref="correctionRef"
        :model="correctionForm"
        :rules="correctionRules"
        label-width="110px"
        class="correction-form"
      >
        <el-form-item label="渔船" prop="vesselId">
          <el-select v-model="correctionForm.vesselId" placeholder="请选择渔船" filterable style="width: 100%" data-testid="correction-vessel">
            <el-option
              v-for="v in vesselOptions"
              :key="v.id"
              :label="`${v.name}（${v.homePort} · ${formatNumber(v.enginePower, 0)}kW）`"
              :value="v.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="进出港类型">
          <el-tag>{{ correctionTarget.type }}</el-tag>
        </el-form-item>
        <el-form-item label="时间" prop="time">
          <el-date-picker
            v-model="correctionForm.time"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            placeholder="选择时间"
            style="width: 100%"
            data-testid="correction-time"
          />
        </el-form-item>
        <el-form-item label="泊位" prop="portId">
          <el-select
            v-model="correctionBerthKey"
            :placeholder="correctionTarget.type === '进港' ? '选择空闲泊位' : '选择已占用泊位'"
            style="width: 100%"
            data-testid="correction-berth"
          >
            <el-option v-for="opt in correctionBerthOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="加冰 kg" prop="iceKg">
              <el-input-number v-model="correctionForm.iceKg" :min="0" :max="20000" :step="50" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="加油 L" prop="fuelL">
              <el-input-number v-model="correctionForm.fuelL" :min="0" :max="20000" :step="50" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="卸货 kg" prop="unloadKg">
              <el-input-number v-model="correctionForm.unloadKg" :min="0" :max="200000" :step="100" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="correctionVisible = false">取消</el-button>
        <el-button type="primary" :loading="correctionSaving" data-testid="submit-correction" @click="submitCorrection">
          保存更正
        </el-button>
      </template>
    </el-dialog>

    <!-- 处理链对话框 -->
    <el-dialog v-model="chainVisible" :title="chainTitle" width="680px" data-testid="chain-dialog">
      <el-timeline v-if="chainEntries.length">
        <el-timeline-item
          v-for="entry in chainEntries"
          :key="entry.call.id"
          :type="entry.call.lifecycle === '已撤销' ? 'info' : entry.kind === '当前记录' ? 'primary' : 'warning'"
          placement="top"
          :timestamp="formatDateTime(entry.call.correctedAt ?? entry.call.voidAt ?? entry.call.createdAt)"
        >
          <div class="chain-node">
            <div class="chain-node__head">
              <el-tag size="small" :type="entry.kind === '当前记录' ? 'primary' : 'info'" effect="plain">{{ entry.kind }}</el-tag>
              <el-tag size="small" :type="lifecycleTagType(entry.call)">{{ lifecycleText(entry.call) }}</el-tag>
              <span class="chain-node__name">{{ entry.call.vesselName }}</span>
              <span class="chain-node__time">业务时间 {{ formatDateTime(entry.call.time) }}</span>
            </div>
            <div class="chain-node__body">
              {{ entry.call.type }} · {{ berthLabelOf(entry.call) }} · 加冰 {{ formatNumber(entry.call.iceKg, 0) }} kg ·
              加油 {{ formatNumber(entry.call.fuelL, 0) }} L · 卸货 {{ formatNumber(entry.call.unloadKg, 0) }} kg ·
              {{ entry.call.visaStatus }}
            </div>
            <div v-if="entry.call.voidReason" class="chain-node__reason">
              撤销原因（{{ formatDateTime(entry.call.voidAt) }}）：{{ entry.call.voidReason }}
            </div>
            <el-alert
              v-if="entry.call.recomputeError"
              class="error-alert"
              type="warning"
              show-icon
              :icon="WarningFilled"
              :closable="false"
              :title="`泊位状态同步失败：${entry.call.recomputeError}`"
            />
          </div>
        </el-timeline-item>
      </el-timeline>
      <EmptyState v-else title="暂无处理链" description="未找到相关记录。" />
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
.card-title__hint {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: #8592a0;
}
.draft-alert {
  border-radius: 10px;
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
.error-alert {
  margin-top: 10px;
}
.correction-form {
  margin-top: 12px;
}
:deep(.call-row--void) {
  color: #909399;
  background: #fafafa;
}
:deep(.call-row--corrected) {
  color: #b0834a;
  background: #fdf8f0;
}
:deep(.call-row--error) {
  background: #fef6ec;
}
.chain-node__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.chain-node__name {
  font-weight: 600;
  color: #17324d;
}
.chain-node__time {
  font-size: 12px;
  color: #7b8a99;
}
.chain-node__body {
  margin-top: 6px;
  font-size: 13px;
  color: #4b5c6d;
}
.chain-node__reason {
  margin-top: 6px;
  font-size: 12px;
  color: #c45656;
}
</style>
