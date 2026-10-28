import type { PluginProduct, ScheduledTask } from "@spindlecommerce/plugin-sdk";
import { isNotFound, MailchimpError, mailchimpRequest, segment, toMajorUnits } from "./api.ts";
import type { MailchimpContext, MailchimpSettings } from "./settings.ts";
import { ensureStore, storeId, withStore } from "./stores.ts";

/** The stock reported for variants that do not track inventory: always in stock, for recommendations. */
export const UNTRACKED_STOCK = 1_000_000;

/** A product as the channel's storefront shows it, in Mailchimp's shape. Prices are the channel's default currency, as a guest pays them. */
export const toMailchimpProduct = (product: PluginProduct) => {
  const url = product.url ?? undefined;
  return {
    id: product.id,
    title: product.name,
    url,
    // HTML, which Mailchimp takes as it is.
    description: product.description ?? "",
    image_url: product.media.find((m) => m.kind === "image")?.url,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      title: variant.name,
      sku: variant.sku,
      price: variant.price === null ? undefined : toMajorUnits(variant.price, product.currency),
      inventory_quantity: variant.quantityAvailable ?? UNTRACKED_STOCK,
      url,
    })),
  };
};

/** Adds or updates the product in a store. False for a product without active variants: Mailchimp needs at least one. */
export const upsertProduct = async (ctx: MailchimpContext, store: string, product: PluginProduct): Promise<boolean> => {
  if (product.variants.length === 0) return false;
  await mailchimpRequest(ctx, "PUT", `/ecommerce/stores/${segment(store)}/products/${segment(product.id)}`, toMailchimpProduct(product));
  return true;
};

/** product.created, product.updated and price.updated: the product in the store of each channel that sells it. */
export const syncProduct = async (ctx: MailchimpContext, productId: string) => {
  for (const channel of await ctx.services.channels.list()) {
    const product = await ctx.services.catalog.getProduct(productId, { channelId: channel.id });
    if (product) await withStore(ctx, channel, product.currency, (store) => upsertProduct(ctx, store, product));
  }
};

/** product.deleted: out of every channel's store. One that never had it (or no store) answers 404, which is fine. */
export const deleteProduct = async (ctx: MailchimpContext, productId: string) => {
  for (const channel of await ctx.services.channels.list()) {
    try {
      await mailchimpRequest(ctx, "DELETE", `/ecommerce/stores/${segment(storeId(ctx, channel))}/products/${segment(productId)}`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
};

// ---------------------------------------------------------------- the full sync

export const SYNC_CURSOR_KEY = "sync-products:cursor";
/** Where the cycle stopped: the channel (by code) and the cursor of the page to do next. */
type SyncCursor = { channel: string; after: string | null };

/** Under the platform's 5-minute limit for a run, with room for the request in flight. */
const SYNC_BUDGET_MS = 4 * 60_000;
const SYNC_PAGE_SIZE = 25;

/**
 * Errors the next product would hit too (a refused key, a rate limit, an outage, no network): the
 * run stops and the next run tries the page again. Mailchimp refusing one product skips it.
 */
const stopsTheRun = (error: unknown) => !(error instanceof MailchimpError) || [401, 403, 429].includes(error.status) || error.status >= 500;

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The scheduled pass that keeps prices and stock current (stock reserved by orders, scheduled prices
 * and exchange rates send no product event). Every product each active channel sells goes to its
 * store, channel by channel in code order, a page at a time. It stops once `budgetMs` has passed
 * and keeps its place in kv; the next run carries on from there, and once every channel is done
 * the next run starts a new cycle. A page left halfway is done again whole, which is harmless.
 * What Mailchimp refuses is skipped, and the run then fails with the reasons.
 */
export const syncProducts = async (ctx: MailchimpContext, options: { budgetMs?: number; pageSize?: number; clock?: () => number } = {}) => {
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.budgetMs ?? SYNC_BUDGET_MS);
  const channels = (await ctx.services.channels.list()).toSorted((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const cursor = await ctx.kv.get<SyncCursor>(SYNC_CURSOR_KEY);
  let synced = 0;
  const refused: string[] = [];

  const finish = async (done: boolean) => {
    ctx.logger.info({ synced, refused: refused.length, done }, done ? "Mailchimp product sync finished" : "Mailchimp product sync paused; the next run carries on");
    if (refused.length) throw new Error(`Mailchimp refused ${refused.slice(0, 3).join("; ")}${refused.length > 3 ? `; and ${refused.length - 3} more` : ""}`);
    return { synced, refused: refused.length, done };
  };

  channels: for (const channel of channels) {
    // Done earlier in this cycle.
    if (cursor && channel.code < cursor.channel) continue;
    let after = cursor?.channel === channel.code ? cursor.after : null;
    let storeReady = false;
    const keepPlace = () => ctx.kv.set(SYNC_CURSOR_KEY, { channel: channel.code, after } satisfies SyncCursor);
    do {
      if (clock() >= deadline) {
        await keepPlace();
        return finish(false);
      }
      const page = await ctx.services.catalog.listProducts({ channelId: channel.id, first: options.pageSize ?? SYNC_PAGE_SIZE, after });
      // The store first, once: if Mailchimp refuses it, the channel's products are skipped this time.
      if (!storeReady && page.products[0]) {
        try {
          await ensureStore(ctx, channel, page.products[0].currency);
          storeReady = true;
        } catch (error) {
          if (stopsTheRun(error)) {
            await keepPlace();
            throw error;
          }
          ctx.logger.warn({ err: error, channel: channel.code }, "Mailchimp refused the channel's store");
          refused.push(`the ${channel.code} store, so its products were skipped: ${describe(error)}`);
          continue channels;
        }
      }
      for (const product of page.products) {
        if (clock() >= deadline) {
          // This page again next time.
          await keepPlace();
          return finish(false);
        }
        try {
          if (await withStore(ctx, channel, product.currency, (store) => upsertProduct(ctx, store, product))) synced++;
        } catch (error) {
          if (stopsTheRun(error)) {
            await keepPlace();
            throw error;
          }
          ctx.logger.warn({ err: error, productId: product.id, channel: channel.code }, "Mailchimp refused a product");
          refused.push(`the product ${product.name || product.id} (${product.id}) in ${channel.code}: ${describe(error)}`);
        }
      }
      after = page.next;
      if (after) await keepPlace();
    } while (after);
  }
  await ctx.kv.delete(SYNC_CURSOR_KEY);
  return finish(true);
};

export const syncProductsTask: ScheduledTask<MailchimpSettings> = {
  name: "sync-products",
  description: "Sends every product each channel sells to its Mailchimp store, with current prices and stock. A run stops after about 4 minutes; the next one carries on.",
  intervalMinutes: 1440,
  run: async (ctx) => {
    await syncProducts(ctx);
  },
};
