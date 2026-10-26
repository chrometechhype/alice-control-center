import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import './styles/main.css';
import './styles/extra.css';
import './styles/expressive.css';

const RIPPLE_TARGET =
  '.btn, .nav-link, .tab, .action-tile, .category-item, .seg, .preset, .scene-card';

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const origin = event.target as HTMLElement | null;
  const target = origin?.closest<HTMLElement>(RIPPLE_TARGET);
  if (!target || target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true') {
    return;
  }
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2;
  const ripple = document.createElement('span');
  ripple.className = 'm3-ripple';
  ripple.style.width = `${size}px`;
  ripple.style.height = `${size}px`;
  ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
  ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
  target.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
});

createApp(App).use(router).mount('#app');
