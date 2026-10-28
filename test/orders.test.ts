import type { PluginOrder } from "@spindlecommerce/plugin-sdk";
import { describe, expect, it } from "vitest";
import { financialStatus, fulfillmentStatus } from "../src/orders.ts";
import { contextFor, customer, deliver, fakeMailchimp, line, md5, order, product, variant, world } from "./helpers.ts";

const setup = (placed: Partial<PluginOrder> = {}) => {
  const api = fakeMailchimp();
  const platform = world();
  platform.data.products.set("ch-us", [
    product({ id: "tee", name: "Everyday Tee", variants: [variant({ id: "tee-m", sku: "TEE-BLACK-M", price: 2500 }), variant({ id: "tee-l", sku: "TEE-BLACK-L", price: 2500 })] }),
    product({ id: "cap", name: "Trail Cap", variants: [variant({ id: "cap-v1", sku: "CAP", price: 2500 })] }),
  ]);
  platform.data.customers.set("cus-1", customer({ id: "cus-1", email: "ana@example.test", firstName: "Ana", lastName: "Silva", acceptsMarketing: true }));
  platform.data.orders.set("ord-1", order({ customerId: "cus-1", email: "ana@example.test", ...placed }));
  const ctx = contextFor(api, platform);
  /** The order as the platform has it now, changed as it would be. */
  const change = (changes: Partial<PluginOrder>) => platform.data.orders.set("ord-1", { ...platform.data.orders.get("ord-1")!, ...changes });
  const patches = () => api.calls.filter((c) => c.method === "PATCH").map((c) => c.body);
  return { api, platform, ctx, change, patches };
};

describe("orders", () => {
  it("sends an order once, on its first payment event, after its products and customer", async () => {
    const { api, ctx } = setup();
    await deliver(ctx, "order.payment_authorized", "ord-1");
    expect(api.writes()).toEqual([
      "POST /ecommerce/stores",
      "PUT /ecommerce/stores/spindle-us/products/tee",
      "PUT /ecommerce/stores/spindle-us/products/cap",
      "PUT /ecommerce/stores/spindle-us/customers/cus-1",
      "POST /ecommerce/stores/spindle-us/orders",
    ]);
    expect(api.customers.get("spindle-us/cus-1")).toEqual({ id: "cus-1", email_address: "ana@example.test", opt_in_status: true, first_name: "Ana", last_name: "Silva" });
    expect(api.calls.at(-1)!.body).toEqual({
      id: "ord-1",
      customer: { id: "cus-1" },
      currency_code: "USD",
      order_total: 78.89,
      tax_total: 5.4,
      shipping_total: 5.99,
      discount_total: 7.5,
      processed_at_foreign: "2026-10-20T09:30:00.000Z",
      financial_status: "pending",
      fulfillment_status: "unfulfilled",
      promos: [{ code: "WELCOME10", amount_discounted: 7.5, type: "fixed" }],
      lines: [
        { id: "line-1", product_id: "tee", product_variant_id: "tee-m", quantity: 2, price: 25 },
        { id: "line-2", product_id: "cap", product_variant_id: "cap-v1", quantity: 1, price: 25 },
      ],
    });
    expect(await ctx.kv.get("order:ord-1")).toEqual({ store: "spindle-us", financial_status: "pending", fulfillment_status: "unfulfilled" });

    // A redelivery, and the capture's own event, send nothing more while nothing changed.
    api.calls.length = 0;
    await deliver(ctx, "order.payment_authorized", "ord-1");
    await deliver(ctx, "order.payment_captured", "ord-1");
    expect(api.calls).toEqual([]);
    expect(api.orders.size).toBe(1);
  });

  it("sends a guest's order with a customer named after their address, who has not opted in", async () => {
    const { api, ctx } = setup({ customerId: null, email: "Guest.Buyer@Example.test", paymentStatus: "paid", couponCodes: ["SUMMER", "FREESHIP"], discountTotal: 751 });
    await deliver(ctx, "order.payment_captured", "ord-1");
    const id = `guest-${md5("guest.buyer@example.test")}`;
    expect(api.customers.get(`spindle-us/${id}`)).toEqual({ id, email_address: "Guest.Buyer@Example.test", opt_in_status: false, first_name: "Ana", last_name: "Silva" });
    expect(api.orders.get("spindle-us/ord-1")).toMatchObject({
      customer: { id },
      financial_status: "paid",
      discount_total: 7.51,
      // What each code saved is not known: the discount is shared.
      promos: [
        { code: "SUMMER", amount_discounted: 3.76, type: "fixed" },
        { code: "FREESHIP", amount_discounted: 3.75, type: "fixed" },
      ],
    });
  });

  it("follows the order with its statuses: paid, shipped, refunded and cancelled", async () => {
    const { api, ctx, change, patches } = setup();
    await deliver(ctx, "order.payment_authorized", "ord-1");

    change({ paymentStatus: "paid" });
    await deliver(ctx, "order.payment_captured", "ord-1");
    expect(patches()).toEqual([{ financial_status: "paid" }]);

    const tracking = { carrier: "USPS", number: "9400111899223197428490", url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490" };
    change({ fulfillmentStatus: "partially_fulfilled", fulfillments: [{ id: "f1", number: "FUL-1", tracking: [tracking], lines: [{ orderLineId: "line-1", quantity: 2 }], createdAt: new Date() }] });
    await deliver(ctx, "order.fulfilled", "ord-1");
    expect(patches().at(-1)).toEqual({ fulfillment_status: "shipped", tracking_number: tracking.number, tracking_carrier: "USPS", tracking_url: tracking.url });
    // The rest ships: still shipped, nothing to send.
    change({ fulfillmentStatus: "fulfilled" });
    await deliver(ctx, "order.fulfilled", "ord-1");
    expect(patches()).toHaveLength(2);

    change({ paymentStatus: "partially_refunded" });
    await deliver(ctx, "order.refunded", "ord-1");
    expect(patches().at(-1)).toEqual({ financial_status: "partially_refunded" });
    change({ paymentStatus: "refunded" });
    await deliver(ctx, "order.refunded", "ord-1");
    expect(patches().at(-1)).toEqual({ financial_status: "refunded" });

    change({ status: "canceled" });
    await deliver(ctx, "order.canceled", "ord-1", {}, new Date("2026-10-22T08:00:00Z"));
    expect(patches().at(-1)).toEqual({ financial_status: "cancelled", cancelled_at_foreign: "2026-10-22T08:00:00.000Z" });
    expect(api.calls.filter((c) => c.method === "PATCH").every((c) => c.path === "/ecommerce/stores/spindle-us/orders/ord-1")).toBe(true);
    expect(api.orders.get("spindle-us/ord-1")).toMatchObject({ financial_status: "cancelled", fulfillment_status: "shipped", tracking_carrier: "USPS" });
  });

  it("skips updates for orders that were never sent, which go with their statuses when they are", async () => {
    const { api, ctx, change } = setup();
    // Shipped before it was paid (cash on delivery, say).
    change({ fulfillmentStatus: "fulfilled" });
    await deliver(ctx, "order.fulfilled", "ord-1");
    await deliver(ctx, "order.canceled", "ord-1");
    await deliver(ctx, "order.refunded", "ord-1");
    expect(api.calls).toEqual([]);

    change({ paymentStatus: "paid" });
    await deliver(ctx, "order.payment_captured", "ord-1");
    expect(api.orders.get("spindle-us/ord-1")).toMatchObject({ financial_status: "paid", fulfillment_status: "shipped" });
  });

  it("maps the platform's statuses to Mailchimp's", () => {
    const statuses = (status: string, paymentStatus: string) => financialStatus({ status, paymentStatus });
    expect(statuses("open", "pending")).toBe("pending");
    expect(statuses("open", "authorized")).toBe("pending");
    expect(statuses("open", "partially_paid")).toBe("pending");
    expect(statuses("completed", "paid")).toBe("paid");
    expect(statuses("open", "partially_refunded")).toBe("partially_refunded");
    expect(statuses("completed", "refunded")).toBe("refunded");
    expect(statuses("canceled", "refunded")).toBe("cancelled");
    expect(fulfillmentStatus({ fulfillmentStatus: "unfulfilled" })).toBe("unfulfilled");
    expect(fulfillmentStatus({ fulfillmentStatus: "partially_fulfilled" })).toBe("shipped");
  });

  it("does not send an order twice when a retry finds Mailchimp has it", async () => {
    const { api, ctx } = setup();
    // An earlier attempt reached Mailchimp but failed on the way back.
    api.fail("POST", "/ecommerce/stores/spindle-us/orders", 504, { title: "Gateway Timeout", detail: "The request timed out." });
    await expect(deliver(ctx, "order.payment_authorized", "ord-1")).rejects.toThrow("Mailchimp answered 504");
    api.orders.set("spindle-us/ord-1", { id: "ord-1", financial_status: "pending" });
    await deliver(ctx, "order.payment_authorized", "ord-1");
    expect(api.calls.filter((c) => c.method === "POST" && c.path.endsWith("/orders"))).toHaveLength(2);
    expect(api.orders.size).toBe(1);
    expect(await ctx.kv.get("order:ord-1")).toMatchObject({ store: "spindle-us" });

    // Other refusals are errors, retried by the platform.
    const other = setup();
    other.change({ lines: [line({ id: "line-9", productId: "tee", variantId: "tee-xl", unitPrice: 2500, quantity: 1 })] });
    await expect(deliver(other.ctx, "order.payment_authorized", "ord-1")).rejects.toThrow("Mailchimp answered 400: Invalid Resource: A product variant with the provided ID does not exist. (tee-xl)");
    expect(await other.ctx.kv.get("order:ord-1")).toBeNull();
  });

  it("sends products the channel no longer sells from the order's lines", async () => {
    const { api, platform, ctx, change } = setup();
    change({
      lines: [
        line({ id: "line-1", productId: "tee", variantId: "tee-m", unitPrice: 2500, quantity: 1 }),
        line({ id: "line-2", productId: "retired", variantId: "retired-s", sku: "OLD-S", name: "Old Jacket – S", unitPrice: 9900, quantity: 1 }),
        line({ id: "line-3", productId: "retired", variantId: "retired-m", sku: "OLD-M", name: "Old Jacket – M", unitPrice: 9900, quantity: 1 }),
      ],
    });
    await deliver(ctx, "order.payment_authorized", "ord-1");
    expect(api.products.get("spindle-us/retired")).toEqual({
      id: "retired",
      title: "Old Jacket – S",
      variants: [
        { id: "retired-s", title: "Old Jacket – S", sku: "OLD-S", price: 99, inventory_quantity: 0 },
        { id: "retired-m", title: "Old Jacket – M", sku: "OLD-M", price: 99, inventory_quantity: 0 },
      ],
    });
    expect(api.orders.get("spindle-us/ord-1")!.lines).toHaveLength(3);

    // In the next order, Mailchimp's copy is left as it is.
    api.calls.length = 0;
    platform.data.orders.set("ord-2", { ...platform.data.orders.get("ord-1")!, id: "ord-2" });
    await deliver(ctx, "order.payment_authorized", "ord-2");
    expect(api.writes().filter((w) => w.includes("/products/"))).toEqual(["PUT /ecommerce/stores/spindle-us/products/tee"]);
    expect(api.orders.has("spindle-us/ord-2")).toBe(true);
  });

  it("sends the order of a channel deactivated since, from its lines, in the order's currency", async () => {
    const { api, platform, ctx } = setup();
    platform.data.channels.push({ id: "ch-popup", code: "popup", name: "Pop-up", defaultLocale: "en-GB", storefrontUrl: null });
    platform.data.inactive.add("ch-popup");
    platform.data.orders.set("ord-popup", order({ id: "ord-popup", channelId: "ch-popup", currency: "GBP", couponCodes: [] }));
    await deliver(ctx, "order.payment_authorized", "ord-popup");
    expect(api.stores.get("spindle-popup")).toEqual({ id: "spindle-popup", list_id: "aud1", name: "Pop-up", platform: "SpindleCommerce", currency_code: "GBP" });
    expect(api.products.get("spindle-popup/tee")).toMatchObject({ variants: [{ id: "tee-m", price: 25, inventory_quantity: 0 }] });
    expect(api.orders.get("spindle-popup/ord-popup")).toMatchObject({ currency_code: "GBP", order_total: 78.89 });
  });

  it("prices orders in their own currency's units", async () => {
    const { api, platform, ctx } = setup();
    platform.data.orders.set(
      "ord-jp",
      order({ id: "ord-jp", currency: "JPY", grandTotal: 5400, taxTotal: 400, shippingTotal: 1000, discountTotal: 0, couponCodes: [], lines: [line({ id: "l1", productId: "cap", variantId: "cap-v1", unitPrice: 4000, quantity: 1 })] }),
    );
    await deliver(ctx, "order.payment_authorized", "ord-jp");
    expect(api.orders.get("spindle-us/ord-jp")).toMatchObject({ currency_code: "JPY", order_total: 5400, tax_total: 400, shipping_total: 1000, discount_total: 0, lines: [{ price: 4000 }] });
    expect(api.orders.get("spindle-us/ord-jp")).not.toHaveProperty("promos");
  });
});
