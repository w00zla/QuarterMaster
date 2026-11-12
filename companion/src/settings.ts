// The settings window's entry (settings.html): the connection, language, scan and overlay settings.
import { createApp } from "vue";
import SettingsApp from "./SettingsApp.vue";
import "../../adminapp/src/styles/base.css";
import "../../webapp/src/styles.css";

const app = createApp(SettingsApp);
app.config.errorHandler = (err, _instance, info) => console.error(`vue error (${info})`, err);
app.mount("#app");
