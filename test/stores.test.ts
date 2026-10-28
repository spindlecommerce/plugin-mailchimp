import { describe, expect, it } from "vitest";
import { channel, contextFor, customer, deliver, fakeMailchimp, order, product, variant, world } from "./helpers.ts";

const tee = product({ id: "tee", name: "Everyday Tee" });

const setup = () => {
  const api = fakeMailchimp();
  const platform = world();
  platform.data.products.set("ch-us", [tee]);
  return { api, platform, ctx: contextFor(api, platform) };
};

describe("stores", () => {
  it("creates a channel's store on first use, then caches that it exists", async () => {
    const { api, platform, ctx } = setup();
    await deliver(ctx, "product.created", "tee");
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /ecommerce/stores/spindle-us?fields=id,list_id",
      "POST /ecommerce/stores",
      "PUT /ecommerce/stores/spindle-us/products/tee",
    ]);
    expect(api.stores.get("spindle-us")).toEqual({
      id: "spindle-us",
      list_id: "aud1",
      name: "Trail Co US",
      platform: "SpindleCommerce",
      currency_code: "USD",
      domain: "us.trail.example",
    });
    expect([...ctx.kv.entries.keys()]).toEqual(["store:aud1:spindle-us"]);

    api.calls.length = 0;
    await deliver(ctx, "product.updated", "tee");
    expect(api.writes()).toEqual(["PUT /ecommerce/stores/spindle-us/products/tee"]);
    expect(api.calls).toHaveLength(1);

    // Another instance (nothing cached) finds the store and uses it as it is.
    const other = contextFor(api, platform);
    api.calls.length = 0;
    await deliver(other, "product.updated", "tee");
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /ecommerce/stores/spindle-us?fields=id,list_id", "PUT /ecommerce/stores/spindle-us/products/tee"]);
  });

  it("names stores with the prefix, and will not use a store tied to another audience", async () => {
    const { api, platform } = setup();
    await deliver(contextFor(api, platform, { storeIdPrefix: "trail" }), "product.created", "tee");
    expect([...api.stores.keys()]).toEqual(["trail-us"]);

    api.audiences.set("aud2", { name: "Wholesale", member_count: 0 });
    await expect(deliver(contextFor(api, platform, { storeIdPrefix: "trail", audienceId: "aud2" }), "product.updated", "tee")).rejects.toThrow(
      "The Mailchimp store trail-us belongs to the audience aud1, not aud2, and a store cannot change audience: set another store ID prefix to start new stores, or delete that store in Mailchimp",
    );
  });

  it("creates a store without a domain when another store has it", async () => {
    const { api, platform, ctx } = setup();
    // One storefront serves both channels.
    platform.data.channels = [channel("us", { storefrontUrl: "https://trail.example" }), channel("eu", { storefrontUrl: "https://trail.example/" })];
    platform.data.products.set("ch-eu", [product({ id: "tee", name: "Everyday Tee", currency: "EUR" })]);
    await deliver(ctx, "product.created", "tee");
    expect(api.stores.get("spindle-eu")).toMatchObject({ domain: "trail.example", currency_code: "EUR" });
    expect(api.stores.get("spindle-us")).toMatchObject({ currency_code: "USD" });
    expect(api.stores.get("spindle-us")!.domain).toBeUndefined();
    expect(api.products.has("spindle-us/tee")).toBe(true);
  });

  it("creates a store again when it was deleted in Mailchimp", async () => {
    const { api, ctx } = setup();
    await deliver(ctx, "product.created", "tee");
    api.stores.clear();
    api.products.clear();
    api.calls.length = 0;
    await deliver(ctx, "product.updated", "tee");
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /ecommerce/stores/spindle-us/products/tee",
      "GET /ecommerce/stores/spindle-us?fields=id,list_id",
      "POST /ecommerce/stores",
      "PUT /ecommerce/stores/spindle-us/products/tee",
    ]);
    expect(api.products.has("spindle-us/tee")).toBe(true);
  });

  it("gives an order's store the channel's default currency, else the order's", async () => {
    const { api, platform, ctx } = setup();
    // The Europe channel sells in euros by default; this order was paid in pounds.
    platform.data.products.set("ch-eu", [product({ id: "tee", name: "Everyday Tee", currency: "EUR", variants: [variant({ id: "tee-m", sku: "TEE-M", price: 2900 })] })]);
    platform.data.customers.set("cus-1", customer({ id: "cus-1", email: "ana@example.test" }));
    const lines = [{ ...order().lines[0]!, unitPrice: 2500, quantity: 1 }];
    platform.data.orders.set("ord-gbp", order({ id: "ord-gbp", channelId: "ch-eu", currency: "GBP", customerId: "cus-1", lines }));
    await deliver(ctx, "order.payment_authorized", "ord-gbp");
    expect(api.stores.get("spindle-eu")).toMatchObject({ currency_code: "EUR", name: "Trail Co Europe" });
    expect(api.orders.get("spindle-eu/ord-gbp")).toMatchObject({ currency_code: "GBP", order_total: 78.89 });

    // A channel that sells nothing (any more) reports no currency: the order's is used.
    platform.data.channels.push(channel("jp"));
    platform.data.orders.set("ord-jpy", order({ id: "ord-jpy", channelId: "ch-jp", currency: "JPY", lines: [{ ...lines[0]!, unitPrice: 3200 }] }));
    await deliver(ctx, "order.payment_authorized", "ord-jpy");
    expect(api.stores.get("spindle-jp")).toMatchObject({ currency_code: "JPY" });
    expect(api.orders.get("spindle-jp/ord-jpy")).toMatchObject({ currency_code: "JPY", lines: [{ product_id: "tee", price: 3200 }] });
  });
});
