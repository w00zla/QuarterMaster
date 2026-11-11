import { createApp } from "vue";
import App from "./App.vue";
import { installCellTips } from "./cellTips";
import { router } from "./router";
import { initShell } from "./shell";
// Look and building blocks shared with the admin UI
import "../../adminapp/src/styles/base.css";
import "./styles.css";

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => console.error(`vue error (${info})`, err);
app.use(router);
// In the desktop shell (the global it injects) before the first render: the window chrome is part of it
void initShell();
app.mount("#app");
installCellTips();
