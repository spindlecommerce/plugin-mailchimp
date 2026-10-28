import type { PluginOrder } from "@spindlecommerce/plugin-sdk";
import { emailHash, isNotFound, isPlatformNotFound, MailchimpError, mailchimpRequest, segment, toMajorUnits } from "./api.ts";
import { upsertProduct } from "./products.ts";
import type { MailchimpContext } from "./settings.ts";
import { channelCurrency, withStore } from "./stores.ts";

/** What went to Mailchimp for an order: its store and the statuses Mailchimp has. Kept in kv as `order:<id>`. */
export type SentOrder = { store: string; financial_status: string; fulfillment_status: string };
const sentKey = (orderId: string) => `order:${orderId}`;

type Line = PluginOrder["lines"][number] & { productId: string; variantId: string };
/** Lines of catalog products: Mailchimp needs a product and a variant for each. */
const productLines = (order: PluginOrder) => order.lines.filter((line): line is Line => Boolean(line.productId && line.variantId));

/**
 * Mailchimp's financial status for the order as it is now. paid, pending, refunded and cancelled
 * trigger Mailchimp's order notifications, when the account uses them; pending covers authorized
 * and partly paid orders.
 */
export const financialStatus = (order: Pick<PluginOrder, "status" | "paymentStatus">) => {
  if (order.status === "canceled") return "cancelled";
  if (order.paymentStatus === "paid") return "paid";
  if (order.paymentStatus === "refunded") return "refunded";
  if (order.paymentStatus === "partially_refunded") return "partially_refunded";
  return "pending";
};

/** "shipped" (which triggers Mailchimp's shipping confirmation) once anything has shipped. */
export const fulfillmentStatus = (order: Pick<PluginOrder, "fulfillmentStatus">) =>
  order.fulfillmentStatus === "fulfilled" || order.fulfillmentStatus === "partially_fulfilled" ? "shipped" : "unfulfilled";

/** The financial status, with the time when it is a cancellation (which cancels the order in Mailchimp). */
const financialFields = (order: PluginOrder, at: Date) => {
  const status = financialStatus(order);
  return { financial_status: status, ...(status === "cancelled" ? { cancelled_at_foreign: at.toISOString() } : {}) };
};

/** The fulfilment status, with the latest tracking number once shipped, for the shipping confirmation. */
const fulfillmentFields = (order: PluginOrder) => {
  const status = fulfillmentStatus(order);
  const tracking = status === "shipped" ? order.fulfillments.flatMap((f) => f.tracking).at(-1) : undefined;
  return {
    fulfillment_status: status,
    ...(tracking ? { tracking_number: tracking.number, tracking_carrier: tracking.carrier, tracking_url: tracking.url ?? undefined } : {}),
  };
};

/**
 * The codes the customer entered. Plugins are not told what each code saved, so the order's
 * discount (which counts automatic promotions too) is shared equally among them.
 */
const promos = (order: PluginOrder) => {
  const codes = order.couponCodes;
  if (codes.length === 0) return undefined;
  const share = Math.floor(order.discountTotal / codes.length);
  return codes.map((code, i) => ({
    code,
    amount_discounted: toMajorUnits(i === 0 ? order.discountTotal - share * (codes.length - 1) : share, order.currency),
    type: "fixed",
  }));
};

/** The order in Mailchimp's shape, in its own currency. Line prices are unit prices. */
export const toMailchimpOrder = (order: PluginOrder, customerId: string, at: Date) => {
  const amount = (minor: number) => toMajorUnits(minor, order.currency);
  return {
    id: order.id,
    customer: { id: customerId },
    currency_code: order.currency,
    order_total: amount(order.grandTotal),
    tax_total: amount(order.taxTotal),
    shipping_total: amount(order.shippingTotal),
    discount_total: amount(order.discountTotal),
    processed_at_foreign: new Date(order.createdAt).toISOString(),
    ...financialFields(order, at),
    ...fulfillmentFields(order),
    promos: promos(order),
    lines: productLines(order).map((line) => ({
      id: line.id,
      product_id: line.productId,
      product_variant_id: line.variantId,
      quantity: line.quantity,
      price: amount(line.unitPrice),
    })),
  };
};

/**
 * A product the channel no longer sells: Mailchimp keeps the copy it has. One it never had is made
 * from the order's lines, out of stock so that it is not recommended.
 */
const ensureProductFromLines = async (ctx: MailchimpContext, store: string, order: PluginOrder, lines: Line[]) => {
  const first = lines[0]!;
  const path = `/ecommerce/stores/${segment(store)}/products/${segment(first.productId)}`;
  try {
    await mailchimpRequest(ctx, "GET", `${path}?fields=id`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const variants = new Map(
      lines.map((line) => [line.variantId, { id: line.variantId, title: line.name, sku: line.sku, price: toMajorUnits(line.unitPrice, order.currency), inventory_quantity: 0 }]),
    );
    await mailchimpRequest(ctx, "PUT", path, { id: first.productId, title: first.name, variants: [...variants.values()] });
  }
};

/** The product as the order's channel sells it; null when it doesn't, or the channel has been deactivated since. */
const productInChannel = async (ctx: MailchimpContext, productId: string, channelId: string) => {
  try {
    return await ctx.services.catalog.getProduct(productId, { channelId });
  } catch (error) {
    if (isPlatformNotFound(error)) return null;
    throw error;
  }
};

/** Mailchimp refuses lines whose product or variant it does not know, so the order's products go first. */
const upsertOrderProducts = async (ctx: MailchimpContext, store: string, order: PluginOrder) => {
  const lines = productLines(order);
  for (const productId of new Set(lines.map((line) => line.productId))) {
    const product = await productInChannel(ctx, productId, order.channelId);
    if (product && (await upsertProduct(ctx, store, product))) continue;
    await ensureProductFromLines(ctx, store, order, lines.filter((line) => line.productId === productId));
  }
};

/**
 * The order's customer in the store: their account, or for guests `guest-<email hash>`. They opt in
 * only with consent, and guests give none; Mailchimp never changes an existing member's status for it.
 */
const upsertCustomer = async (ctx: MailchimpContext, store: string, order: PluginOrder) => {
  const account = order.customerId ? await ctx.services.customers.get(order.customerId) : null;
  const address = order.billingAddress ?? order.shippingAddress;
  const customer = {
    id: account ? account.id : `guest-${emailHash(order.email)}`,
    email_address: account?.email ?? order.email,
    opt_in_status: account?.acceptsMarketing ?? false,
    first_name: account?.firstName || address?.firstName || undefined,
    last_name: account?.lastName || address?.lastName || undefined,
  };
  await mailchimpRequest(ctx, "PUT", `/ecommerce/stores/${segment(store)}/customers/${segment(customer.id)}`, customer);
  return customer.id;
};

const orderExists = (ctx: MailchimpContext, store: string, id: string) =>
  mailchimpRequest(ctx, "GET", `/ecommerce/stores/${segment(store)}/orders/${segment(id)}?fields=id`).then(
    () => true,
    () => false,
  );

const createOrder = async (ctx: MailchimpContext, store: string, order: ReturnType<typeof toMailchimpOrder>) => {
  try {
    await mailchimpRequest(ctx, "POST", `/ecommerce/stores/${segment(store)}/orders`, order);
  } catch (error) {
    // A retry after Mailchimp took the order but the delivery failed (a timeout, say): it is there already.
    if (error instanceof MailchimpError && error.status === 400 && (await orderExists(ctx, store, order.id))) return;
    throw error;
  }
};

/**
 * order.fulfilled, order.canceled and order.refunded, and payments after the first: the statuses
 * that changed since the order was sent. Orders never sent (unpaid ones) are skipped; when they are
 * sent, they go with their statuses of the time.
 */
export const updateOrder = async (ctx: MailchimpContext, orderId: string, at = new Date()) => {
  const sent = await ctx.kv.get<SentOrder>(sentKey(orderId));
  if (!sent) return;
  const order = await ctx.services.orders.get(orderId);
  if (!order) return;
  const financial = financialFields(order, at);
  const fulfillment = fulfillmentFields(order);
  const patch = {
    ...(financial.financial_status === sent.financial_status ? {} : financial),
    ...(fulfillment.fulfillment_status === sent.fulfillment_status ? {} : fulfillment),
  };
  if (Object.keys(patch).length === 0) return;
  try {
    await mailchimpRequest(ctx, "PATCH", `/ecommerce/stores/${segment(sent.store)}/orders/${segment(orderId)}`, patch);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    // Deleted in Mailchimp, with its store say: there is nothing left to update.
    ctx.logger.warn({ orderId, store: sent.store }, "The order is no longer in Mailchimp; its update was skipped");
    await ctx.kv.delete(sentKey(orderId));
    return;
  }
  await ctx.kv.set(sentKey(orderId), { ...sent, financial_status: financial.financial_status, fulfillment_status: fulfillment.fulfillment_status } satisfies SentOrder);
};

/**
 * order.payment_authorized and order.payment_captured: on the first of them, the order goes to its
 * channel's store, once, after its products and its customer. Later ones bring its statuses up to
 * date: an order sent as pending when authorized becomes paid when captured.
 */
export const sendOrder = async (ctx: MailchimpContext, orderId: string, at = new Date()) => {
  const order = await ctx.services.orders.get(orderId);
  if (!order) return;
  const ran = await ctx.once(`order:${order.id}`, async () => {
    const channel = await ctx.services.channels.get(order.channelId);
    if (!channel) throw new Error(`The order's channel ${order.channelId} was not found`);
    const store = await withStore(ctx, channel, () => channelCurrency(ctx, channel.id, order.currency), async (store) => {
      await upsertOrderProducts(ctx, store, order);
      const customerId = await upsertCustomer(ctx, store, order);
      await createOrder(ctx, store, toMailchimpOrder(order, customerId, at));
      return store;
    });
    await ctx.kv.set(sentKey(order.id), { store, financial_status: financialStatus(order), fulfillment_status: fulfillmentStatus(order) } satisfies SentOrder);
  });
  if (!ran) await updateOrder(ctx, order.id, at);
};
