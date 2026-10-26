import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: () => import('./views/DashboardView.vue'),
      meta: { title: 'Обзор', subtitle: 'Текущее состояние колонки и быстрые действия' },
    },
    {
      path: '/system',
      name: 'system',
      component: () => import('./views/SystemView.vue'),
      meta: { title: 'Системный монитор', subtitle: 'Железо, возможности, диагностика и логи' },
    },
    {
      path: '/sounds',
      name: 'sounds',
      component: () => import('./views/SoundsView.vue'),
      meta: { title: 'Sound Studio', subtitle: 'Инвентаризация, предпросмотр и замена звуков' },
    },
    {
      path: '/led',
      name: 'led',
      component: () => import('./views/LedView.vue'),
      meta: { title: 'LED Studio', subtitle: 'Цвета и анимации реальных LED-зон' },
    },
    {
      path: '/bluetooth',
      name: 'bluetooth',
      component: () => import('./views/BluetoothView.vue'),
      meta: { title: 'Bluetooth', subtitle: 'Адаптер, сканирование и подключение устройств' },
    },
    {
      path: '/files',
      name: 'files',
      component: () => import('./views/FilesView.vue'),
      meta: { title: 'Файловый менеджер', subtitle: 'Разрешённые каталоги, только безопасные операции' },
    },
    {
      path: '/terminal',
      name: 'terminal',
      component: () => import('./views/TerminalView.vue'),
      meta: { title: 'Терминал', subtitle: 'Только команды из белого списка' },
    },
    {
      path: '/backups',
      name: 'backups',
      component: () => import('./views/BackupsView.vue'),
      meta: { title: 'Backup Manager', subtitle: 'Резервные копии конфигурации и звуков на компьютере' },
    },
    {
      path: '/automation',
      name: 'automation',
      component: () => import('./views/AutomationView.vue'),
      meta: { title: 'Automation Studio', subtitle: 'Сценарии только по реальным событиям' },
    },
    {
      path: '/events',
      name: 'events',
      component: () => import('./views/EventsView.vue'),
      meta: { title: 'Event Center', subtitle: 'Журнал действий и ошибок' },
    },
    {
      path: '/plugins',
      name: 'plugins',
      component: () => import('./views/PluginsView.vue'),
      meta: { title: 'Плагины и YAM', subtitle: 'Статус без автоматической установки сторонних пакетов' },
    },
    {
      path: '/fun',
      name: 'fun',
      component: () => import('./views/FunView.vue'),
      meta: { title: 'Fun Lab', subtitle: 'Световые эффекты и случайные звуки' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue'),
      meta: { title: 'Настройки', subtitle: 'Подключение, доступ по сети, тема и токены' },
    },
    {
      path: '/setup',
      name: 'setup',
      component: () => import('./views/SetupView.vue'),
      meta: { title: 'Мастер подключения', subtitle: 'Проверка инструментов и первичная настройка' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
