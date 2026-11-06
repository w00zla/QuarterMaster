// The debug window's entry (debug.html): the inventory scan's reads with the frame and overlays.
import { createApp } from "vue";
import DebugApp from "./DebugApp.vue";
import "./shared/ui/adminapp/styles/base.css";
import "./shared/ui/webapp/styles.css";

const app = createApp(DebugApp);
app.config.errorHandler = (err, _instance, info) => console.error(`vue error (${info})`, err);
app.mount("#app");
