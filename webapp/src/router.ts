import { createRouter, createWebHistory } from "vue-router";
import BlueprintsView from "./views/BlueprintsView.vue";
import ComponentsView from "./views/ComponentsView.vue";
import CraftingView from "./views/CraftingView.vue";
import HistoryView from "./views/HistoryView.vue";
import HomeView from "./views/HomeView.vue";
import MiningView from "./views/MiningView.vue";
import RefineryView from "./views/RefineryView.vue";
import StockView from "./views/StockView.vue";
import ThumbReviewView from "./views/ThumbReviewView.vue";
import TradeView from "./views/TradeView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: HomeView },
    { path: "/resources", component: StockView },
    { path: "/gear", component: ComponentsView },
    { path: "/refinery", component: RefineryView },
    { path: "/blueprints", component: BlueprintsView },
    { path: "/crafting", component: CraftingView },
    { path: "/mining", component: MiningView },
    { path: "/trade", component: TradeView },
    { path: "/history", component: HistoryView },
    // Privilege thumb-review (the view says so without it; the server checks every call)
    { path: "/review/thumbs", component: ThumbReviewView },
    { path: "/:rest(.*)*", redirect: "/" },
  ],
});
