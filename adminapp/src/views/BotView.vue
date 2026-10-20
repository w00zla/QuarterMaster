<script setup lang="ts">
// The bot's status texts: the bot shows one at random as its Discord status, a new one every 10 minutes.
import { ref } from "vue";
import Icon from "../components/Icon.vue";
import { send, useFetch } from "../api";
import { dateTime } from "../format";
import type { StatusQuote } from "../../../src/adminapp/api-types";

// Discord's limit for a custom status (the server checks it too)
const MAX = 128;

const quotes = useFetch<StatusQuote[]>(() => "/status-quotes", false);
const draft = ref("");
const editId = ref<number | null>(null);
const editText = ref("");
const busy = ref(false);
const error = ref("");

const length = (text: string) => [...text.trim()].length;
const valid = (text: string) => length(text) >= 1 && length(text) <= MAX;

async function run(action: () => Promise<unknown>) {
  busy.value = true;
  error.value = "";
  try {
    await action();
    quotes.reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

const add = () =>
  run(async () => {
    await send("POST", "/status-quotes", { text: draft.value });
    draft.value = "";
  });

function startEdit(q: StatusQuote) {
  editId.value = q.id;
  editText.value = q.text;
}

const save = (id: number) =>
  run(async () => {
    await send("PUT", `/status-quotes/${id}`, { text: editText.value });
    editId.value = null;
  });

function remove(q: StatusQuote) {
  if (!confirm(`Delete "${q.text}"?`)) return;
  void run(() => send("DELETE", `/status-quotes/${q.id}`));
}
</script>

<template>
  <div class="view">
    <div class="stack">
      <section class="panel">
        <div class="head">
          <Icon name="texts" :size="16" />
          <span class="head-title no-grow">Status texts</span>
          <span class="head-count">{{ quotes.data.value?.length ?? 0 }}</span>
        </div>
        <form class="add" @submit.prevent="valid(draft) && !busy && add()">
          <input v-model="draft" class="input text" placeholder="New status text" />
          <span class="counter mono" :class="{ over: length(draft) > MAX }">{{ length(draft) }}/{{ MAX }}</span>
          <button type="submit" class="btn outline small" :disabled="!valid(draft) || busy"><Icon name="plus" :size="14" /> Add</button>
        </form>
        <div v-if="error" class="empty-line err">{{ error }}</div>
        <div v-if="quotes.error.value" class="empty-line">{{ quotes.error.value }}</div>
        <div v-else-if="quotes.data.value && !quotes.data.value.length" class="empty-line">No status texts</div>
        <table v-else-if="quotes.data.value" class="mini">
          <thead><tr><th>Text</th><th>Changed</th><th /></tr></thead>
          <tbody>
            <tr v-for="q in quotes.data.value" :key="q.id">
              <td class="text-cell">
                <form v-if="editId === q.id" class="edit" @submit.prevent="valid(editText) && !busy && save(q.id)">
                  <input v-model="editText" class="input text" @keydown.esc="editId = null" />
                  <span class="counter mono" :class="{ over: length(editText) > MAX }">{{ length(editText) }}/{{ MAX }}</span>
                </form>
                <template v-else>{{ q.text }}</template>
              </td>
              <td class="nowrap">{{ dateTime(q.updatedAt) }}</td>
              <td class="actions">
                <template v-if="editId === q.id">
                  <button type="button" class="icon-btn" title="Save" :disabled="!valid(editText) || busy" @click="save(q.id)"><Icon name="check" :size="16" /></button>
                  <button type="button" class="icon-btn" title="Cancel" @click="editId = null"><Icon name="close" :size="16" /></button>
                </template>
                <template v-else>
                  <button type="button" class="icon-btn" title="Edit" :disabled="busy" @click="startEdit(q)"><Icon name="edit" :size="16" /></button>
                  <button type="button" class="icon-btn" title="Delete" :disabled="busy" @click="remove(q)"><Icon name="trash" :size="16" /></button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.add,
.edit {
  display: flex;
  align-items: center;
  gap: 10px;
}

.add {
  padding: 12px 16px;
}

.input {
  height: var(--h-chip-sm);
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-control);
  background: var(--bg-surface-2);
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.input.text {
  flex: 1;
  min-width: 0;
  max-width: 720px;
}

.counter {
  font-size: 12px;
  color: var(--text-3);
}

.counter.over,
.err {
  color: var(--err);
}

.text-cell {
  width: 100%;
}

.actions {
  display: flex;
  gap: 8px;
}
</style>
