// Layout facts shared between components: the top bar's height (it wraps on narrow screens), so
// the toasts sit right below it. 0 while there is no top bar (login page).
import { ref } from "vue";

export const topbarHeight = ref(0);
