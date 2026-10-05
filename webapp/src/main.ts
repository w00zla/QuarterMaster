import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
// Look and building blocks shared with the admin UI
import "../../web/src/styles/base.css";

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => console.error(`vue error (${info})`, err);
app.use(router);
app.mount("#app");
