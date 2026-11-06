// The scan overlay's entry (overlay.html): the main window's detections over the game, read-only.
import { createApp } from "vue";
import OverlayApp from "./OverlayApp.vue";
import "./shared/ui/adminapp/styles/base.css";
import "./shared/ui/webapp/styles.css";

const app = createApp(OverlayApp);
app.config.errorHandler = (err, _instance, info) => console.error(`vue error (${info})`, err);
app.mount("#app");
