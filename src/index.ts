import { definePlugin } from "@spindlecommerce/plugin-sdk";
import { checkConnection } from "./check.ts";
import { syncMember } from "./members.ts";
import { sendOrder, updateOrder } from "./orders.ts";
import { deleteProduct, syncProduct, syncProductsTask } from "./products.ts";
import { mailchimpSettings } from "./settings.ts";

/**
 * Mailchimp (mailchimp.com): customers join the audience with their marketing consent, and each
 * channel's products and paid orders go to a Mailchimp e-commerce store. See README.md.
 */
export const mailchimp = () =>
  definePlugin({
    name: "mailchimp",
    // The package's version (a test keeps them equal), shown in the admin.
    version: "1.0.0",
    // The plugin API this was written for, as a number: PLUGIN_API_VERSION would be the
    // installation's own, so it would always match.
    apiVersion: 1,
    title: "Mailchimp",
    description: "Customers join your Mailchimp audience with their marketing consent, and each channel's products and paid orders go to a Mailchimp store, for product recommendations, purchase segments and e-commerce automations.",
    settings: mailchimpSettings,
    events: {
      "customer.created": (event, ctx) => syncMember(ctx, event.aggregateId),
      "customer.updated": (event, ctx) => syncMember(ctx, event.aggregateId),
      "product.created": (event, ctx) => syncProduct(ctx, event.aggregateId),
      "product.updated": (event, ctx) => syncProduct(ctx, event.aggregateId),
      // Its payload names the product whose variant's price changed.
      "price.updated": async (event, ctx) => {
        if (typeof event.payload.productId === "string") await syncProduct(ctx, event.payload.productId);
      },
      "product.deleted": (event, ctx) => deleteProduct(ctx, event.aggregateId),
      "order.payment_authorized": (event, ctx) => sendOrder(ctx, event.aggregateId, event.occurredAt),
      "order.payment_captured": (event, ctx) => sendOrder(ctx, event.aggregateId, event.occurredAt),
      "order.fulfilled": (event, ctx) => updateOrder(ctx, event.aggregateId, event.occurredAt),
      "order.canceled": (event, ctx) => updateOrder(ctx, event.aggregateId, event.occurredAt),
      "order.refunded": (event, ctx) => updateOrder(ctx, event.aggregateId, event.occurredAt),
    },
    tasks: [syncProductsTask],
    check: checkConnection,
  });

export default mailchimp;
