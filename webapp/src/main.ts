import { createApp } from "vue";
import App from "./App.vue";
import { installCellTips } from "./cellTips";
import { router } from "./router";
// Look and building blocks shared with the admin UI
import "../../adminapp/src/styles/base.css";
import "./styles.css";

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => console.error(`vue error (${info})`, err);
app.use(router);
app.mount("#app");
installCellTips();
