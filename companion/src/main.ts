import { createApp } from "vue";
import App from "./App.vue";
// Look and building blocks shared with the web apps
import "./styles/base.css";
import "./styles/views.css";

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => console.error(`vue error (${info})`, err);
app.mount("#app");
