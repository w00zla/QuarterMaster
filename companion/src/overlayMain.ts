// The scan overlay's entry (overlay.html): the main window's detections over the game, read-only.
import { createApp } from "vue";
import OverlayApp from "./OverlayApp.vue";
import "./styles/base.css";
import "./styles/views.css";

const app = createApp(OverlayApp);
app.config.errorHandler = (err, _instance, info) => console.error(`vue error (${info})`, err);
app.mount("#app");
