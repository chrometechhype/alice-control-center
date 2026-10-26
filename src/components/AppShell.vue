<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import {
  Archive,
  AudioLines,
  Bluetooth,
  Check,
  FlaskConical,
  FolderOpen,
  Info,
  LayoutDashboard,
  Lightbulb,
  LogOut,
  Menu,
  Moon,
  Plug,
  Puzzle,
  RefreshCw,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Sun,
  Workflow,
  Wifi,
  AlertTriangle,
  X,
} from '@lucide/vue';
import StatusPill from './StatusPill.vue';
import SocialLinks from './SocialLinks.vue';
import UpdateBanner from './UpdateBanner.vue';
import DevicePortrait from './DevicePortrait.vue';
import { detectDeviceVisual } from '@/lib/deviceVisual';
import {
  deviceName,
  dismissToast,
  isConnected,
  loadSnapshot,
  logout,
  pushToast,
  refreshProbe,
  store,
  toggleTheme,
} from '@/lib/store';
import { errorMessage } from '@/lib/api';

interface NavItem {
  to: string;
  label: string;
  icon: Component;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: 'Обзор',
    items: [
      { to: '/', label: 'Обзор', icon: LayoutDashboard },
      { to: '/system', label: 'Системный монитор', icon: Server },
    ],
  },
  {
    label: 'Станция',
    items: [
      { to: '/sounds', label: 'Sound Studio', icon: AudioLines },
      { to: '/led', label: 'LED Studio', icon: Lightbulb },
      { to: '/bluetooth', label: 'Bluetooth', icon: Bluetooth },
    ],
  },
  {
    label: 'Инструменты',
    items: [
      { to: '/files', label: 'Файлы', icon: FolderOpen },
      { to: '/terminal', label: 'Терминал', icon: SquareTerminal },
      { to: '/backups', label: 'Бэкапы', icon: Archive },
      { to: '/automation', label: 'Автоматизация', icon: Workflow },
    ],
  },
  {
    label: 'Система',
    items: [
      { to: '/events', label: 'Event Center', icon: ScrollText },
      { to: '/plugins', label: 'Плагины и YAM', icon: Puzzle },
      { to: '/fun', label: 'Fun Lab', icon: FlaskConical },
      { to: '/settings', label: 'Настройки', icon: Settings },
    ],
  },
];

const route = useRoute();
const sidebarOpen = ref(false);
const refreshing = ref(false);

const deviceVisual = computed(() => detectDeviceVisual(store.info));
const themeTitle = computed(() => {
  const next = store.theme === 'light' ? 'тёмную' : 'светлую';
  if (store.themeMode === 'system') {
    return `Системная тема (${store.theme === 'dark' ? 'тёмная' : 'светлая'}). Включить ${next}`;
  }
  return `Включить ${next} тему`;
});
const wsLabel = computed(() =>
  store.wsState === 'online' ? 'Live' : store.wsState === 'connecting' ? 'Sync' : 'Offline',
);
const wsTone = computed(() =>
  store.wsState === 'online' ? 'pill--ok' : store.wsState === 'connecting' ? 'pill--warn' : 'pill--muted',
);

watch(
  () => route.fullPath,
  () => {
    sidebarOpen.value = false;
  },
);

async function refresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    if (isConnected.value) {
      await refreshProbe();
      pushToast('ok', 'Данные устройства обновлены');
    } else {
      await loadSnapshot();
      pushToast('info', 'Состояние обновлено');
    }
  } catch (error) {
    pushToast('error', errorMessage(error));
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <div class="shell">
    <div v-if="sidebarOpen" class="sidebar-scrim" @click="sidebarOpen = false" />
    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <RouterLink to="/" class="brand" style="text-decoration: none; color: inherit">
        <div class="brand-mark"><AudioLines :size="20" /></div>
        <div>
          <div class="brand-name">Alice Control</div>
          <div class="brand-sub">Station Center</div>
        </div>
      </RouterLink>

      <RouterLink to="/setup" class="device-mini">
        <div class="device-mini__portrait">
          <DevicePortrait :info="store.info" size="sm" :muted="!isConnected" />
        </div>
        <div class="device-mini__body">
          <span class="device-mini__name">{{ deviceName }}</span>
          <span class="device-mini__kind">{{ deviceVisual.tagline }}</span>
        </div>
        <div class="device-mini__meta">
          <span v-if="store.status.host">{{ store.status.host }}:{{ store.status.port ?? 2222 }}</span>
          <span v-else>Подключение не настроено</span>
          <span v-if="store.info?.firmware">Quasar {{ store.info.firmware }}</span>
          <span v-else-if="store.status.lastError" class="truncate">{{ store.status.lastError }}</span>
          <span v-else>Ожидание устройства</span>
        </div>
      </RouterLink>

      <nav class="nav">
        <template v-for="group in navGroups" :key="group.label">
          <div class="nav-group">{{ group.label }}</div>
          <RouterLink v-for="item in group.items" :key="item.to" :to="item.to" class="nav-link">
            <component :is="item.icon" :size="16" />
            <span class="truncate">{{ item.label }}</span>
          </RouterLink>
        </template>
      </nav>

      <div class="sidebar-foot">
        <RouterLink to="/setup" class="nav-link">
          <Plug :size="16" />
          <span>Мастер подключения</span>
        </RouterLink>
        <div class="row" style="padding: 0 4px">
          <span v-if="store.auth.required" class="pill pill--primary">
            <ShieldCheck :size="13" />
            LAN-сессия
          </span>
          <span v-else class="pill pill--muted">
            <ShieldCheck :size="13" />
            Локальный доступ
          </span>
          <span class="spacer" />
          <button
            v-if="store.auth.required"
            type="button"
            class="btn btn--ghost btn--icon btn--sm"
            title="Выйти"
            @click="logout"
          >
            <LogOut :size="15" />
          </button>
        </div>
        <div class="sidebar-social">
          <SocialLinks compact />
          <span class="eyebrow">ACC 0.2</span>
        </div>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <button
          type="button"
          class="btn btn--ghost btn--icon mobile-only"
          aria-label="Открыть меню"
          @click="sidebarOpen = true"
        >
          <Menu :size="18" />
        </button>
        <div class="topbar-title">
          <strong>Alice Control Center</strong>
        </div>
        <div class="topbar-spacer" />
        <div class="topbar-actions">
          <span class="pill topbar-ws" :class="wsTone" :title="`WebSocket: ${store.wsState}`">
            <Wifi :size="13" />
            {{ wsLabel }}
          </span>
          <StatusPill :state="store.status.state" />
          <button
            type="button"
            class="btn btn--icon btn--sm"
            title="Обновить данные"
            :disabled="refreshing"
            @click="refresh"
          >
            <RefreshCw :size="15" :class="{ spin: refreshing }" />
          </button>
          <button
            type="button"
            class="btn btn--icon btn--sm"
            :title="themeTitle"
            :disabled="store.updatingSettings"
            @click="toggleTheme"
          >
            <Moon v-if="store.theme === 'light'" :size="15" />
            <Sun v-else :size="15" />
          </button>
        </div>
      </header>

      <UpdateBanner />

      <RouterView />

      <div class="toasts">
        <div v-for="item in store.toasts" :key="item.id" class="toast" :class="`toast--${item.kind}`">
          <Check v-if="item.kind === 'ok'" :size="15" />
          <AlertTriangle v-else-if="item.kind === 'error'" :size="15" />
          <Info v-else :size="15" />
          <span>{{ item.message }}</span>
          <button type="button" class="toast-close" aria-label="Закрыть" @click="dismissToast(item.id)">
            <X :size="13" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
