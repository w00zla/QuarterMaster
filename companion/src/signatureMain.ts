// The signature overlay's entry (signature.html): the resources a radar signature can stand for, next to it.
import { createApp } from "vue";
import SignatureApp from "./SignatureApp.vue";
import "../../adminapp/src/styles/base.css";
import "../../webapp/src/styles.css";

const app = createApp(SignatureApp);
app.config.errorHandler = (err, _instance, info) => console.error(`vue error (${info})`, err);
app.mount("#app");
