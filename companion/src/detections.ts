// What the scans detect, counted for the overlay's flash (overlay.ts): an inventory
// read that adds or changes a sighting (inventorySync.ts), a refinery read with a new proposal or a job
// update (refinerySync.ts), a new unlock to register while the app runs (overlay.ts). A module of its own:
// the sync modules and overlay.ts import each other otherwise.
import { ref } from "vue";

export const detections = ref(0);

export function detected() {
  detections.value++;
}
