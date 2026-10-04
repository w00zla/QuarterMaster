// Display language for game texts (names, slot names, stats); the UI itself is English.
import { ref, watch } from "vue";

const KEY = "qm.lang";

function load(): string {
  try {
    return localStorage.getItem(KEY) ?? "en";
  } catch {
    return "en";
  }
}

export const lang = ref(load());

watch(lang, (l) => {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // localStorage unavailable: the choice simply does not persist.
  }
});
