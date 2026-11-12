import { createRouter, createWebHistory } from "vue-router";
import { capabilities } from "./capabilities";
import { routeAllowed } from "./navigation";
import BlueprintsView from "./views/BlueprintsView.vue";
import ComponentsView from "./views/ComponentsView.vue";
import CraftingView from "./views/CraftingView.vue";
import HistoryView from "./views/HistoryView.vue";
import HomeView from "./views/HomeView.vue";
import MiningView from "./views/MiningView.vue";
import RefineryView from "./views/RefineryView.vue";
import SettingsView from "./views/SettingsView.vue";
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
    // Only without a login (the singleuser variant): the guard below sends the others home
    { path: "/settings", component: SettingsView },
    // Features: /feature/<key>; thumb-review needs thumb-review.mark (the view says so without it; the server checks every call)
    { path: "/feature/thumb-review", component: ThumbReviewView },
    { path: "/:rest(.*)*", redirect: "/" },
  ],
});

// Routes the server's capabilities do not offer (settings with a login, the trade view without UEX) lead home. Before the
// capabilities are known everything passes: App.vue checks the current route again when they arrive.
router.beforeEach((to) => (routeAllowed(to.path, capabilities.value) ? true : "/"));
