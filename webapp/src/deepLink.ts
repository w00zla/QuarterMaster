// Deep links from the bot (`/resources?scope=…`, `/blueprints?scope=…`, `/crafting?add=…`): a view reads its
// parameter once when it opens (in setup), then the URL drops the query so a reload keeps the user's own
// choice. Views only render after the login, so the login screen still sees the whole link (returnTo).
import { useRoute, useRouter } from "vue-router";

/** The deep link's query parameter `name`, or null; clears the URL's query. Call in a view's setup. */
export function takeQuery(name: string): string | null {
  const route = useRoute();
  const value = route.query[name];
  if (Object.keys(route.query).length) void useRouter().replace({ query: {} });
  return typeof value === "string" ? value : null;
}
