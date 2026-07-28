/**
 * Single source of truth for every wire-visible identity token this product
 * publishes at `/.well-known/yurucommu` (and its `/.well-known/social-server`
 * alias).
 *
 * WHY this file exists: the tokens used to be literals inside
 * `scripts/build-yurucommu-worker.ts` and, separately, inside
 * `scripts/dev-mock-server.ts`. The sibling product (Yurumeet) had the same
 * two-copy arrangement and the copies disagreed — the mock advertised what the
 * mobile shells expect and the deployed Worker did not, so every mobile
 * connection failed while local development looked healthy. The disagreement
 * was undetectable because no code ever compared the two. Producers import
 * from here; the contract test next to this file fails if one re-declares a
 * token.
 *
 * `product` names the *family engine* (@takosjp/yurucommu-core), not this app.
 * Per-app identity lives in `clients[].id` and in the Takosumi catalog key.
 */
interface ProductWireIdentity {
  readonly product: string;
  readonly name: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly clients: readonly {
    readonly id: string;
    readonly name: string;
    readonly defaultEntry: string;
  }[];
  readonly capabilities: readonly string[];
}

export const PRODUCT_WIRE_IDENTITY = {
  product: "yurucommu",
  name: "Yurucommu",
  serverId: "yurucommu-server",
  serverName: "Yurucommu Server",
  clients: [
    { id: "yurucommu", name: "Yurucommu", defaultEntry: "feed" },
    { id: "yurume", name: "Yurumeet", defaultEntry: "messages" },
  ],
  capabilities: [
    "api.social.v1",
    "activitypub.server.v1",
    "client.yurucommu.feed.v1",
    "client.yurume.messages.v1",
    "notification.pushers.v1",
  ],
} satisfies ProductWireIdentity;

/** The client key this SPA and the Yurucommu mobile shell identify as. */
export const PRODUCT_CLIENT_KEY = "yurucommu";
