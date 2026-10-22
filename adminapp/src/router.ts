import { createRouter, createWebHistory } from "vue-router";
import DashboardView from "./views/DashboardView.vue";
import StatusView from "./views/StatusView.vue";
import ActivityView from "./views/ActivityView.vue";
import OrgsView from "./views/OrgsView.vue";
import UsersView from "./views/UsersView.vue";
import StockView from "./views/StockView.vue";
import RefineryView from "./views/RefineryView.vue";
import BlueprintsView from "./views/BlueprintsView.vue";
import ResourcesView from "./views/ResourcesView.vue";
import ItemsView from "./views/ItemsView.vue";
import TextsView from "./views/TextsView.vue";
import ImportsView from "./views/ImportsView.vue";
import ThirdPartyView from "./views/ThirdPartyView.vue";
import BotView from "./views/BotView.vue";

declare module "vue-router" {
  interface RouteMeta {
    // The page's name in the top bar
    title?: string;
  }
}

// List views keep their table while the optional param selects the detail. The old paths
// (/resources, /localisation, /3rd-party) redirect to the new ones.
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "dashboard", component: DashboardView, meta: { title: "Dashboard" } },
    { path: "/status", name: "status", component: StatusView, meta: { title: "Status" } },
    { path: "/activity", name: "activity", component: ActivityView, meta: { title: "Activity" } },
    { path: "/orgs/:guildId?", name: "orgs", component: OrgsView, meta: { title: "Orgs" } },
    { path: "/users/:userId?", name: "users", component: UsersView, meta: { title: "Users" } },
    { path: "/stock", name: "stock", component: StockView, meta: { title: "Stock" } },
    { path: "/refinery", name: "refinery", component: RefineryView, meta: { title: "Refinery" } },
    { path: "/blueprints/:uuid?", name: "blueprints", component: BlueprintsView, meta: { title: "Blueprints" } },
    { path: "/materials/:uuid?", name: "materials", component: ResourcesView, meta: { title: "Materials" } },
    { path: "/resources/:uuid?", redirect: (to) => `/materials/${to.params.uuid ?? ""}` },
    { path: "/items/:uuid?", name: "items", component: ItemsView, meta: { title: "Items" } },
    { path: "/texts/:key?", name: "texts", component: TextsView, meta: { title: "Texts" } },
    { path: "/localisation/:key?", redirect: (to) => `/texts/${to.params.key ?? ""}` },
    { path: "/imports/:id?", name: "imports", component: ImportsView, meta: { title: "Imports" } },
    { path: "/uex", name: "uex", component: ThirdPartyView, meta: { title: "UEX" } },
    { path: "/3rd-party", redirect: "/uex" },
    { path: "/bot", name: "bot", component: BotView, meta: { title: "Bot" } },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
