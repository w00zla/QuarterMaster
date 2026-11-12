// Layout facts shared between components: the height of the bar at the top (the slim bar of 56 px above the side bar, or the settings
// window's title bar), so the toasts sit right
// below it. 0 while there is no such bar (login page).
import { ref } from "vue";

export const topbarHeight = ref(0);
