<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  AlertTriangle,
  Check,
  Download,
  Info,
  LoaderCircle,
  RefreshCw,
  ScrollText,
  Search,
  Trash,
} from '@lucide/vue';
import type { AccEvent, EventLevel } from '@shared/types';
import EmptyState from '@/components/EmptyState.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { api, apiUrl, errorMessage, triggerDownload } from '@/lib/api';
import { pushToast, refreshEvents, store } from '@/lib/store';
import { formatDateTime, formatRelative, formatTime } from '@/lib/format';

const level = ref<'all' | EventLevel>('all');
const module = ref('all');
const query = ref('');
const busy = ref(false);
const expanded = ref<string | null>(null);
const clearDialog = ref(false);

const levelTabs: Array<{ value: 'all' | EventLevel; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'info', label: 'Инфо' },
  { value: 'success', label: 'Успех' },
  { value: 'warn', label: 'Внимание' },
  { value: 'error', label: 'Ошибки' },
];

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return store.events.filter((event) => {
    if (level.value !== 'all' && event.level !== level.value) return false;
    if (module.value !== 'all' && event.module !== module.value) return false;
    if (
      needle &&
      !`${event.module} ${event.operation} ${event.message}`.toLowerCase().includes(needle)
    ) {
      return false;
    }
    return true;
  });
});

/**
 * Повторы одного и того же события (обрыв транспорта, серия реплик) схлопываются в одну строку
 * со счётчиком: журнал читают глазами, а не листают одинаковые строки. Склейка идёт по всему окну,
 * а не только по соседним строкам — иначе «Колонка не отвечает» между другими записями занимала
 * экран сотнями копий.
 */
const groupedEvents = computed(() => {
  const rows = new Map<string, { event: AccEvent; count: number; lastTs: number }>();
  for (const event of filtered.value) {
    const key = `${event.level}|${event.module}|${event.operation}|${event.message}`;
    const row = rows.get(key);
    if (row) {
      row.count += 1;
      if (event.ts >= row.lastTs) {
        row.lastTs = event.ts;
        row.event = event;
      }
    } else {
      rows.set(key, { event, count: 1, lastTs: event.ts });
    }
  }
  return [...rows.values()].sort((a, b) => b.lastTs - a.lastTs);
});

const PAGE_SIZE = 60;
const visibleLimit = ref(PAGE_SIZE);
const displayEvents = computed(() => groupedEvents.value.slice(0, visibleLimit.value));
const hiddenEvents = computed(() => Math.max(0, groupedEvents.value.length - displayEvents.value.length));

watch([level, module, query], () => {
  visibleLimit.value = PAGE_SIZE;
});

const errorCount = computed(() => store.events.filter((event) => event.level === 'error').length);
const modulesVisible = computed(() => {
  const set = new Set(store.eventModules);
  for (const event of store.events) set.add(event.module);
  return [...set].sort();
});

function eventIcon(levelValue: string) {
  if (levelValue === 'success') return Check;
  if (levelValue === 'warn' || levelValue === 'error') return AlertTriangle;
  return Info;
}

function toggle(event: AccEvent): void {
  if (!event.details) return;
  expanded.value = expanded.value === event.id ? null : event.id;
}

async function reload(): Promise<void> {
  busy.value = true;
  try {
    await refreshEvents();
    pushToast('ok', 'Журнал обновлён');
  } catch (error) {
    pushToast('error', errorMessage(error));
  } finally {
    busy.value = false;
  }
}

async function clearAll(): Promise<void> {
  busy.value = true;
  try {
    await api.post<{ removed: number }>('/events/clear', { confirm: true });
    store.events = [];
    store.eventTotal = 0;
    clearDialog.value = false;
    pushToast('ok', 'Журнал очищен');
  } catch (error) {
    pushToast('error', errorMessage(error));
  } finally {
    busy.value = false;
  }
}

function exportLog(): void {
  triggerDownload(apiUrl('/events/export'));
}

onMounted(() => {
  if (!store.events.length) void refreshEvents().catch(() => undefined);
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Event Center</h1>
        <p>Все действия и ошибки backend пишутся в журнал с маскированием секретов. Новые события приходят live.</p>
      </div>
      <div class="page-head__actions">
        <button class="btn" :disabled="busy" @click="reload">
          <RefreshCw :size="15" :class="{ spin: busy }" />
          Обновить
        </button>
        <button class="btn" @click="exportLog">
          <Download :size="15" />
          Экспорт JSONL
        </button>
        <button class="btn btn--danger" :disabled="!store.events.length" @click="clearDialog = true">
          <Trash :size="15" />
          Очистить
        </button>
      </div>
    </div>

    <div class="grid grid-3">
      <div class="card stat">
        <div class="stat-top"><span class="stat-label">Всего событий</span><ScrollText :size="15" class="muted" /></div>
        <div class="stat-value">{{ store.eventTotal }}</div>
        <div class="stat-foot"><span>В памяти backend</span><span class="mono">live</span></div>
      </div>
      <div class="card stat">
        <div class="stat-top"><span class="stat-label">Строк в журнале</span><Search :size="15" class="muted" /></div>
        <div class="stat-value">{{ groupedEvents.length }}</div>
        <div class="stat-foot"><span>Повторы склеены</span><span class="mono">{{ filtered.length }} зап.</span></div>
      </div>
      <div class="card stat">
        <div class="stat-top"><span class="stat-label">Ошибки</span><AlertTriangle :size="15" class="muted" /></div>
        <div class="stat-value">{{ errorCount }}</div>
        <div class="stat-foot"><span>Уровень error</span><span class="mono">warn</span></div>
      </div>
    </div>

    <article class="card card--flush">
      <div class="file-toolbar">
        <div class="tabs">
          <button
            v-for="item in levelTabs"
            :key="item.value"
            type="button"
            class="tab"
            :class="{ active: level === item.value }"
            @click="level = item.value"
          >
            {{ item.label }}
          </button>
        </div>
        <select v-model="module" class="select" style="max-width: 190px">
          <option value="all">Все модули</option>
          <option v-for="item in modulesVisible" :key="item" :value="item">{{ item }}</option>
        </select>
        <div class="search" style="flex: 1; min-width: 180px">
          <Search :size="14" />
          <input v-model="query" class="input" placeholder="Поиск по сообщению…" />
        </div>
      </div>

      <div v-if="displayEvents.length" class="list">
        <div
          v-for="row in displayEvents"
          :key="row.event.id"
          class="event-row"
          :class="{ 'event-row--grouped': row.count > 1, 'event-row--open': expanded === row.event.id }"
          style="cursor: pointer"
          @click="toggle(row.event)"
        >
          <span class="event-level" :class="`event-level--${row.event.level}`">
            <component :is="eventIcon(row.event.level)" :size="13" />
          </span>
          <div class="list-main">
            <div class="list-title">{{ row.event.message }}</div>
            <div class="list-meta">
              {{ formatDateTime(row.lastTs) }} · {{ row.event.module }} / {{ row.event.operation }} ·
              {{ formatRelative(row.lastTs) }}
            </div>
            <pre v-if="expanded === row.event.id && row.event.details" class="console mt-8" @click.stop>{{
              JSON.stringify(row.event.details, null, 2)
            }}</pre>
          </div>
          <div class="row" style="gap: 6px; flex: none">
            <span v-if="row.count > 1" class="pill pill--muted" :title="`Повторов: ${row.count}`">×{{ row.count }}</span>
            <span class="pill" :class="row.event.level === 'error' ? 'pill--error' : row.event.level === 'warn' ? 'pill--warn' : row.event.level === 'success' ? 'pill--ok' : 'pill--muted'">
              {{ row.event.level }}
            </span>
            <span class="mono muted">{{ formatTime(row.lastTs) }}</span>
          </div>
        </div>
      </div>
      <EmptyState
        v-else
        title="Нет событий по фильтру"
        text="Измените фильтры или выполните действие в любом модуле — событие появится здесь автоматически."
      >
        <template #icon><ScrollText :size="22" /></template>
      </EmptyState>

      <div v-if="hiddenEvents" class="row mt-12" style="justify-content: center">
        <button class="btn" @click="visibleLimit += PAGE_SIZE * 3">
          Показать ещё {{ Math.min(hiddenEvents, PAGE_SIZE * 3) }} из {{ hiddenEvents }}
        </button>
      </div>
    </article>

    <div class="alert alert--info">
      <Info :size="15" />
      <div>
        Журнал хранится в <span class="code-inline">data/events.jsonl</span>, ограничен 2000 записями и очищается только
        по явному подтверждению. Пароли и токены автоматически заменяются на «[скрыто]».
      </div>
    </div>

    <ConfirmDialog
      :open="clearDialog"
      title="Очистить журнал?"
      message="Все записи журнала будут удалены с этого компьютера. Действие нельзя отменить."
      confirm-label="Очистить журнал"
      :busy="busy"
      @cancel="clearDialog = false"
      @confirm="clearAll"
    >
      <div v-if="busy" class="row muted"><LoaderCircle :size="14" class="spin" /> Удаляем записи…</div>
    </ConfirmDialog>
  </div>
</template>
