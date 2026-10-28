import type { PluginChannel } from "@spindlecommerce/plugin-sdk";
import { audienceOf, isNotFound, isPlatformNotFound, MailchimpError, mailchimpRequest, segment } from "./api.ts";
import type { MailchimpContext } from "./settings.ts";

export const storePrefix = (ctx: Pick<MailchimpContext, "settings">) => ctx.settings.storeIdPrefix.trim() || "spindle";

/** `<prefix>-<channel code>`, e.g. spindle-us: one Mailchimp store per channel. */
export const storeId = (ctx: Pick<MailchimpContext, "settings">, channel: Pick<PluginChannel, "code">) => `${storePrefix(ctx)}-${channel.code}`;

/** Per audience, so a new audience setting checks the stores again. */
const cacheKey = (ctx: MailchimpContext, id: string) => `store:${audienceOf(ctx)}:${id}`;

/** The store's currency: a value, or a function asked only when the store has to be created. */
export type CurrencySource = string | (() => Promise<string>);

/**
 * The channel's default currency: the one the catalog reports when asked for none. A channel that
 * sells nothing reports none, and the catalog refuses inactive channels, so `fallback` is used.
 */
export const channelCurrency = async (ctx: MailchimpContext, channelId: string, fallback: string) => {
  try {
    return (await ctx.services.catalog.listProducts({ channelId, first: 1 })).products[0]?.currency ?? fallback;
  } catch (error) {
    if (isPlatformNotFound(error)) return fallback;
    throw error;
  }
};

const findStore = async (ctx: MailchimpContext, id: string) => {
  try {
    return await mailchimpRequest<{ id: string; list_id: string }>(ctx, "GET", `/ecommerce/stores/${segment(id)}?fields=id,list_id`);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
};

/** Mailchimp wants each store's domain to be unique in the account; channels can share a storefront. */
const isDomainError = (error: unknown) => error instanceof MailchimpError && error.status === 400 && (error.fields.includes("domain") || /domain/i.test(error.message));

const storefrontDomain = (url: string | null) => {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
};

const createStore = async (ctx: MailchimpContext, id: string, channel: PluginChannel, currency: string) => {
  const store = {
    id,
    list_id: audienceOf(ctx),
    name: channel.name,
    platform: "SpindleCommerce",
    currency_code: currency,
    domain: storefrontDomain(channel.storefrontUrl),
  };
  try {
    await mailchimpRequest(ctx, "POST", "/ecommerce/stores", store);
  } catch (error) {
    // Another delivery created it meanwhile.
    if (await findStore(ctx, id).catch(() => null)) return;
    if (!store.domain || !isDomainError(error)) throw error;
    ctx.logger.warn({ store: id, domain: store.domain }, "Another Mailchimp store has this channel's domain: the store was created without one");
    await mailchimpRequest(ctx, "POST", "/ecommerce/stores", { ...store, domain: undefined });
  }
};

/**
 * The channel's store, created on first use (its currency comes from `currency`). Its existence
 * is cached in kv; `cached` says whether it came from there.
 */
export const ensureStore = async (ctx: MailchimpContext, channel: PluginChannel, currency: CurrencySource): Promise<{ id: string; cached: boolean }> => {
  const id = storeId(ctx, channel);
  if (await ctx.kv.get(cacheKey(ctx, id))) return { id, cached: true };
  const found = await findStore(ctx, id);
  if (!found) {
    await createStore(ctx, id, channel, typeof currency === "string" ? currency : await currency());
  } else if (found.list_id !== audienceOf(ctx)) {
    throw new Error(
      `The Mailchimp store ${id} belongs to the audience ${found.list_id}, not ${audienceOf(ctx)}, and a store cannot change audience: set another store ID prefix to start new stores, or delete that store in Mailchimp`,
    );
  }
  await ctx.kv.set(cacheKey(ctx, id), { at: new Date().toISOString() });
  return { id, cached: false };
};

/**
 * Runs `write` against the channel's store, creating the store first if need be. A cached store
 * that has since been deleted in Mailchimp answers 404: it is created again and `write` runs once more.
 */
export const withStore = async <T>(ctx: MailchimpContext, channel: PluginChannel, currency: CurrencySource, write: (store: string) => Promise<T>): Promise<T> => {
  const store = await ensureStore(ctx, channel, currency);
  try {
    return await write(store.id);
  } catch (error) {
    if (!store.cached || !isNotFound(error)) throw error;
    await ctx.kv.delete(cacheKey(ctx, store.id));
    await ensureStore(ctx, channel, currency);
    return write(store.id);
  }
};
