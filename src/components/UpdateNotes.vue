<script setup lang="ts">
import { computed } from 'vue';
import { releaseDateLabel, updateStore } from '@/lib/updates';

const releaseDate = computed(releaseDateLabel);

const lines = computed(() => {
  const info = updateStore.info;
  if (!info) return [];
  if (info.highlights.length) return info.highlights;
  const note = info.notes.trim();
  return note ? [note.slice(0, 400)] : [];
});
</script>

<template>
  <div class="update-notes">
    <div class="update-notes__head">
      <strong>Изменения версии {{ updateStore.info?.latestVersion || '—' }}</strong>
      <span v-if="releaseDate" class="muted">{{ releaseDate }}</span>
      <a
        v-if="updateStore.info?.releaseUrl"
        :href="updateStore.info.releaseUrl"
        target="_blank"
        rel="noopener noreferrer"
      >Открыть релиз</a>
    </div>
    <ul v-if="lines.length" class="update-notes__list">
      <li v-for="line in lines" :key="line">{{ line }}</li>
    </ul>
    <p v-else class="field-hint">
      В релизе пока нет описания — оно появится на странице релиза, как только автор его добавит.
    </p>
  </div>
</template>
