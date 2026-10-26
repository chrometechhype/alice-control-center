<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    labels?: boolean;
    compact?: boolean;
  }>(),
  { labels: false, compact: false },
);

const github = 'https://github.com/chrometechhype/alice-control-center';
const telegram = 'https://t.me/myloveiskeri';
</script>

<template>
  <div class="social-links" :class="{ 'social-links--compact': props.compact }">
    <a
      :href="github"
      target="_blank"
      rel="noopener noreferrer"
      class="social-link"
      title="Alice Control Center на GitHub"
      aria-label="GitHub"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <path
          d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.4-5.25 5.69.41.35.77 1.04.77 2.1 0 1.52-.01 2.75-.01 3.12 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"
        />
      </svg>
      <span v-if="labels">GitHub</span>
    </a>
    <a
      :href="telegram"
      target="_blank"
      rel="noopener noreferrer"
      class="social-link"
      title="Автор в Telegram: @myloveiskeri"
      aria-label="Telegram"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <path
          d="M21.94 4.3a1.5 1.5 0 0 0-1.53-.25L3.06 11.2c-1.4.54-1.38 1.33-.23 1.69l4.63 1.44 1.78 5.46c.2.57.37.79.73.79.35 0 .5-.16.7-.35l2.27-2.2 4.72 3.48c.87.48 1.5.23 1.72-.8l3.1-14.55a1.1 1.1 0 0 0-.54-1.86ZM9.05 14.55l10.1-6.36c.5-.3.96-.14.58.2l-8.67 7.82-.34 3.56-1.67-5.22Z"
        />
      </svg>
      <span v-if="labels">Telegram</span>
    </a>
  </div>
</template>

<style scoped>
.social-links {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.social-link {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 36px;
  padding: 0 10px;
  border-radius: 12px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 620;
  text-decoration: none;
  transition: background 160ms ease, color 160ms ease, transform 160ms ease;
}

.social-link svg {
  width: 17px;
  height: 17px;
}

.social-link:hover {
  background: var(--surface-2);
  color: var(--text);
}

.social-link:active {
  transform: scale(0.96);
}

.social-links--compact .social-link {
  width: 34px;
  min-height: 34px;
  padding: 0;
  justify-content: center;
}
</style>
