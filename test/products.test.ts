import { describe, expect, it } from "vitest";
import { SYNC_CURSOR_KEY, syncProducts, toMailchimpProduct, UNTRACKED_STOCK } from "../src/products.ts";
import { contextFor, deliver, fakeMailchimp, product, variant, world } from "./helpers.ts";

const tee = product({
  id: "tee",
  name: "Everyday Tee",
  description: "<p>Organic <strong>cotton</strong>, garment-dyed.</p>",
  media: [
    { url: "https://cdn.trail.example/tee.mp4", alt: null, kind: "video", variantId: null },
    { url: "https://cdn.trail.example/tee-front.jpg", alt: "Front", kind: "image", variantId: null },
    { url: "https://cdn.trail.example/tee-back.jpg", alt: "Back", kind: "image", variantId: null },
  ],
  variants: [
    variant({ id: "tee-m", sku: "TEE-BLACK-M", name: "Everyday Tee – Black / M", price: 2500, quantityAvailable: 12 }),
    variant({ id: "tee-l", sku: "TEE-BLACK-L", name: "Everyday Tee – Black / L", price: 2750, quantityAvailable: 0, available: false }),
    // No price in the currency, and no inventory tracking.
    variant({ id: "tee-gift", sku: "TEE-GIFT", name: "Everyday Tee – Gift box", price: null, quantityAvailable: null }),
  ],
});

describe("products", () => {
  it("maps a product as its channel's storefront shows it", () => {
    expect(toMailchimpProduct(tee)).toEqual({
      id: "tee",
      title: "Everyday Tee",
      url: "https://us.trail.example/products/everyday-tee",
      description: "<p>Organic <strong>cotton</strong>, garment-dyed.</p>",
      image_url: "https://cdn.trail.example/tee-front.jpg",
      variants: [
        { id: "tee-m", title: "Everyday Tee – Black / M", sku: "TEE-BLACK-M", price: 25, inventory_quantity: 12, url: "https://us.trail.example/products/everyday-tee" },
        { id: "tee-l", title: "Everyday Tee – Black / L", sku: "TEE-BLACK-L", price: 27.5, inventory_quantity: 0, url: "https://us.trail.example/products/everyday-tee" },
        { id: "tee-gift", title: "Everyday Tee – Gift box", sku: "TEE-GIFT", price: undefined, inventory_quantity: UNTRACKED_STOCK, url: "https://us.trail.example/products/everyday-tee" },
      ],
    });
    expect(UNTRACKED_STOCK).toBe(1_000_000);
    // No storefront, media or description.
    const bare = toMailchimpProduct(product({ id: "cap", name: "Trail Cap", url: null, currency: "JPY", variants: [variant({ id: "cap-v1", sku: "CAP", price: 3200 })] }));
    expect(bare).toMatchObject({ url: undefined, image_url: undefined, description: "", variants: [{ price: 3200, url: undefined }] });
    expect(JSON.parse(JSON.stringify(bare))).not.toHaveProperty("url");
  });

  it("upserts a product in the store of each channel that sells it, on product and price events", async () => {
    const api = fakeMailchimp();
    const platform = world();
    const euroTee = product({ ...tee, currency: "EUR", url: "https://eu.trail.example/products/everyday-tee", variants: [variant({ id: "tee-m", sku: "TEE-BLACK-M", price: 2900 })] });
    platform.data.products.set("ch-us", [tee, product({ id: "cap", name: "Trail Cap" })]);
    platform.data.products.set("ch-eu", [euroTee]);
    const ctx = contextFor(api, platform);

    await deliver(ctx, "product.created", "tee");
    expect(api.writes()).toEqual(["POST /ecommerce/stores", "PUT /ecommerce/stores/spindle-eu/products/tee", "POST /ecommerce/stores", "PUT /ecommerce/stores/spindle-us/products/tee"]);
    expect(api.products.get("spindle-eu/tee")).toMatchObject({ url: "https://eu.trail.example/products/everyday-tee", variants: [{ id: "tee-m", price: 29 }] });
    expect(api.products.get("spindle-us/tee")).toEqual(toMailchimpProduct(tee));

    // Only the US channel sells the cap.
    api.calls.length = 0;
    await deliver(ctx, "product.updated", "cap");
    expect(api.writes()).toEqual(["PUT /ecommerce/stores/spindle-us/products/cap"]);

    // A new price arrives with price.updated, which names the product.
    platform.data.products.set("ch-us", [{ ...tee, variants: [{ ...tee.variants[0]!, price: 1999 }] }]);
    api.calls.length = 0;
    await deliver(ctx, "price.updated", "tee-m", { productId: "tee" });
    expect(api.writes()).toEqual(["PUT /ecommerce/stores/spindle-eu/products/tee", "PUT /ecommerce/stores/spindle-us/products/tee"]);
    expect(api.products.get("spindle-us/tee")!.variants[0]).toMatchObject({ id: "tee-m", price: 19.99 });

    // Neither a product no channel sells nor one without variants (Mailchimp needs one) is sent.
    platform.data.products.set("ch-us", [product({ id: "kit", name: "Repair kit", variants: [] })]);
    api.calls.length = 0;
    await deliver(ctx, "product.updated", "nothing");
    await deliver(ctx, "product.updated", "kit");
    expect(api.writes()).toEqual([]);
  });

  it("deletes a product from every channel's store, whether or not it is there", async () => {
    const api = fakeMailchimp();
    const platform = world();
    platform.data.products.set("ch-us", [tee]);
    const ctx = contextFor(api, platform);
    await deliver(ctx, "product.created", "tee");
    api.calls.length = 0;
    // The Europe channel has no store yet, so no product either: 404, which is fine.
    await deliver(ctx, "product.deleted", "tee");
    expect(api.writes()).toEqual(["DELETE /ecommerce/stores/spindle-eu/products/tee", "DELETE /ecommerce/stores/spindle-us/products/tee"]);
    expect(api.products.has("spindle-us/tee")).toBe(false);
    // Deleted already (a redelivery): still fine.
    await deliver(ctx, "product.deleted", "tee");
    // Other errors are retried.
    api.fail("DELETE", "/ecommerce/stores/spindle-us/products/", 503, { title: "Service Unavailable", detail: "Try again later." });
    await expect(deliver(ctx, "product.deleted", "tee")).rejects.toThrow("Mailchimp answered 503: Service Unavailable: Try again later.");
  });
});

describe("the sync task", () => {
  /** Every channel's products, and a clock that moves a minute per product sent. */
  const setup = () => {
    const api = fakeMailchimp();
    const platform = world();
    platform.data.products.set("ch-eu", ["e1", "e2", "e3"].map((id) => product({ id, name: id, currency: "EUR" })));
    platform.data.products.set("ch-us", ["u1", "u2", "u3", "u4", "u5"].map((id) => product({ id, name: id })));
    const clock = { now: 0 };
    api.state.onCall = (call) => {
      if (call.method === "PUT" && call.path.includes("/products/")) clock.now += 60_000;
    };
    const ctx = contextFor(api, platform);
    const run = () => {
      clock.now = 0;
      api.calls.length = 0;
      return syncProducts(ctx, { pageSize: 2, clock: () => clock.now });
    };
    const sent = () => api.calls.filter((c) => c.method === "PUT").map((c) => c.path.split("/").slice(-3).join("/").replace("/products", ""));
    return { api, platform, ctx, run, sent };
  };

  it("goes through each channel's products a page at a time, and carries on where it stopped", async () => {
    const { ctx, run, sent } = setup();
    // Four minutes, four products: the second US product is not started.
    expect(await run()).toEqual({ synced: 4, refused: 0, done: false });
    expect(sent()).toEqual(["spindle-eu/e1", "spindle-eu/e2", "spindle-eu/e3", "spindle-us/u1"]);
    // Its page is done again from the start.
    expect(await ctx.kv.get(SYNC_CURSOR_KEY)).toEqual({ channel: "us", after: null });

    expect(await run()).toEqual({ synced: 4, refused: 0, done: false });
    expect(sent()).toEqual(["spindle-us/u1", "spindle-us/u2", "spindle-us/u3", "spindle-us/u4"]);
    expect(await ctx.kv.get(SYNC_CURSOR_KEY)).toEqual({ channel: "us", after: "u4" });

    expect(await run()).toEqual({ synced: 1, refused: 0, done: true });
    expect(sent()).toEqual(["spindle-us/u5"]);
    expect(await ctx.kv.get(SYNC_CURSOR_KEY)).toBeNull();

    // A new cycle.
    await run();
    expect(sent()).toEqual(["spindle-eu/e1", "spindle-eu/e2", "spindle-eu/e3", "spindle-us/u1"]);
  });

  it("sends what the storefront shows, in the channel's currency", async () => {
    const { api, run } = setup();
    await run();
    expect(api.stores.get("spindle-eu")).toMatchObject({ currency_code: "EUR" });
    expect(api.products.get("spindle-eu/e1")).toEqual(toMailchimpProduct(product({ id: "e1", name: "e1", currency: "EUR" })));
  });

  it("skips products Mailchimp refuses, and stops when Mailchimp is out of reach, keeping its place", async () => {
    const { api, ctx, run, sent } = setup();
    api.fail("PUT", "/ecommerce/stores/spindle-eu/products/e2", 400, {
      title: "Invalid Resource",
      detail: "The resource submitted could not be validated.",
      errors: [{ field: "image_url", message: "This value is not a valid URL." }],
    });
    await expect(run()).rejects.toThrow(
      "Mailchimp refused the product e2 (e2) in eu: Mailchimp answered 400: Invalid Resource: The resource submitted could not be validated. (image_url: This value is not a valid URL.)",
    );
    // The others went on; the place is kept as usual.
    expect(sent()).toEqual(["spindle-eu/e1", "spindle-eu/e2", "spindle-eu/e3", "spindle-us/u1"]);
    expect(api.products.has("spindle-eu/e2")).toBe(false);
    expect(await ctx.kv.get(SYNC_CURSOR_KEY)).toEqual({ channel: "us", after: null });

    // Rate limited: the run stops, and the next starts with the same page.
    api.fail("PUT", "/ecommerce/stores/spindle-us/products/u4", 429, { title: "Too Many Requests", detail: "You have exceeded the limit of 10 simultaneous connections." });
    await expect(run()).rejects.toThrow("Mailchimp answered 429: Too Many Requests: You have exceeded the limit of 10 simultaneous connections.");
    expect(sent()).toEqual(["spindle-us/u1", "spindle-us/u2", "spindle-us/u3", "spindle-us/u4"]);
    expect(await ctx.kv.get(SYNC_CURSOR_KEY)).toEqual({ channel: "us", after: "u2" });
    expect(await run()).toEqual({ synced: 3, refused: 0, done: true });
    expect(sent()).toEqual(["spindle-us/u3", "spindle-us/u4", "spindle-us/u5"]);
  });

  it("skips a channel whose store Mailchimp refuses, without asking again for each product", async () => {
    const { api, run, sent } = setup();
    api.fail("POST", "/ecommerce/stores", 400, {
      title: "Invalid Resource",
      detail: "The resource submitted could not be validated.",
      errors: [{ field: "currency_code", message: "This value is not a valid currency." }],
    });
    await expect(run()).rejects.toThrow(
      "Mailchimp refused the eu store, so its products were skipped: Mailchimp answered 400: Invalid Resource: The resource submitted could not be validated. (currency_code: This value is not a valid currency.)",
    );
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(sent()).toEqual(["spindle-us/u1", "spindle-us/u2", "spindle-us/u3", "spindle-us/u4"]);
  });

  it("is a daily task", async () => {
    const { mailchimp } = await import("../src/index.ts");
    expect(mailchimp().tasks).toEqual([expect.objectContaining({ name: "sync-products", intervalMinutes: 1440 })]);
  });
});
