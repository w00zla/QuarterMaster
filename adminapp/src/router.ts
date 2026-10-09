import { createRouter, createWebHistory } from "vue-router";
import OverviewView from "./views/OverviewView.vue";
import BlueprintsView from "./views/BlueprintsView.vue";
import ResourcesView from "./views/ResourcesView.vue";
import ItemsView from "./views/ItemsView.vue";
import TextsView from "./views/TextsView.vue";
import ImportsView from "./views/ImportsView.vue";
import ThirdPartyView from "./views/ThirdPartyView.vue";
import OrgsView from "./views/OrgsView.vue";
import UsersView from "./views/UsersView.vue";

// List views keep their table while the optional param selects the detail.
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "overview", component: OverviewView },
    { path: "/orgs/:guildId?", name: "orgs", component: OrgsView },
    { path: "/users/:userId?", name: "users", component: UsersView },
    { path: "/blueprints/:uuid?", name: "blueprints", component: BlueprintsView },
    { path: "/resources/:uuid?", name: "resources", component: ResourcesView },
    { path: "/items/:uuid?", name: "items", component: ItemsView },
    { path: "/localisation/:key?", name: "localisation", component: TextsView },
    { path: "/texts/:key?", redirect: (to) => `/localisation/${to.params.key ?? ""}` },
    { path: "/imports/:id?", name: "imports", component: ImportsView },
    { path: "/3rd-party", name: "third-party", component: ThirdPartyView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
