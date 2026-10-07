import { createRouter, createWebHistory } from "vue-router";
import BlueprintsView from "./views/BlueprintsView.vue";
import CraftingView from "./views/CraftingView.vue";
import HistoryView from "./views/HistoryView.vue";
import HomeView from "./views/HomeView.vue";
import RefineryView from "./views/RefineryView.vue";
import StockView from "./views/StockView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: HomeView },
    { path: "/stock", component: StockView },
    { path: "/refinery", component: RefineryView },
    { path: "/blueprints", component: BlueprintsView },
    { path: "/crafting", component: CraftingView },
    { path: "/history", component: HistoryView },
    { path: "/:rest(.*)*", redirect: "/" },
  ],
});
