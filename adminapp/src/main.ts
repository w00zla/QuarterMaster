import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import "./styles/base.css";

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => console.error(`vue error (${info})`, err);
app.use(router);
app.mount("#app");
