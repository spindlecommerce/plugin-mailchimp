import { createHash } from "node:crypto";
import { NotFoundError, type Address, type PluginChannel, type PluginCustomer, type PluginEvent, type PluginOrder, type PluginProduct, type PluginProductVariant, type PluginServices } from "@spindlecommerce/plugin-sdk";
import { mailchimp } from "../src/index.ts";
import type { MailchimpContext } from "../src/settings.ts";

export const KEY = "fake-api-key-us21";
export const AUDIENCE = "aud1";
export const md5 = (text: string) => createHash("md5").update(text).digest("hex");

// ---------------------------------------------------------------- Mailchimp

export type Call = { method: string; path: string; body: any };
type Json = Record<string, any>;

const response = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { "content-type": "application/problem+json" } });

const problem = (status: number, title: string, detail: string, errors?: { field: string; message: string }[]) =>
  response(status, { type: "https://mailchimp.com/developer/marketing/docs/errors/", title, status, detail, instance: "c0ffee", ...(errors ? { errors } : {}) });

/**
 * Mailchimp's Marketing API as far as the plugin uses it, with its state: audiences and their
 * members, stores and their products, customers and orders. It refuses what Mailchimp refuses
 * (another data centre or key, orders naming unknown products, resubscribing an unsubscribed
 * member, a domain another store has) and records every call.
 */
export const fakeMailchimp = () => {
  const calls: Call[] = [];
  const audiences = new Map<string, { name: string; member_count: number }>([[AUDIENCE, { name: "Trail Co", member_count: 1200 }]]);
  const members = new Map<string, Json>();
  const stores = new Map<string, Json>();
  const products = new Map<string, Json>();
  const customers = new Map<string, Json>();
  const orders = new Map<string, Json>();
  type Failure = { title?: string; detail?: string; errors?: { field: string; message: string }[]; text?: string; times?: number };
  const failures: (Failure & { method: string; path: string; status: number; times: number })[] = [];
  const state = {
    /** Runs before each call is answered, e.g. to move a test clock. */
    onCall: (_call: Call) => {},
  };

  /** The next calls (`times`, default 1) of `method` to a path starting with `path` fail; `text` answers with a body that is not JSON. */
  const fail = (method: string, path: string, status: number, failure: Failure = {}) => failures.push({ method, path, status, ...failure, times: failure.times ?? 1 });

  const answer = (method: string, path: string, body: Json | null): Response => {
    if (method === "GET" && path === "/ping") return response(200, { health_status: "Everything's Chimpy!" });

    let match = path.match(/^\/lists\/([^/]+)$/);
    if (match && method === "GET") {
      const audience = audiences.get(match[1]!);
      return audience ? response(200, { id: match[1], name: audience.name, stats: { member_count: audience.member_count } }) : problem(404, "Resource Not Found", "The requested resource could not be found.");
    }
    match = path.match(/^\/lists\/([^/]+)\/members\/([^/]+)$/);
    if (match && method === "PUT") {
      const [, list, hash] = match as unknown as [string, string, string];
      if (!audiences.has(list)) return problem(404, "Resource Not Found", "The requested resource could not be found.");
      if (body!.email_address && md5(String(body!.email_address).toLowerCase()) !== hash) return problem(400, "Invalid Resource", "The subscriber hash does not match the email address.");
      const key = `${list}/${hash}`;
      const existing = members.get(key);
      if (!existing) {
        if (!body!.status_if_new && !body!.status) return problem(400, "Invalid Resource", "The resource submitted could not be validated.", [{ field: "status_if_new", message: "Required for new members." }]);
        members.set(key, { email_address: body!.email_address, status: body!.status ?? body!.status_if_new, merge_fields: { ...body!.merge_fields } });
      } else {
        if (body!.status === "subscribed" && ["unsubscribed", "cleaned"].includes(existing.status)) {
          return problem(400, "Member In Compliance State", `${existing.email_address} is already a list member in compliance state due to unsubscribe, bounce, or compliance review and cannot be subscribed.`);
        }
        if (body!.status) existing.status = body!.status;
        existing.merge_fields = { ...existing.merge_fields, ...body!.merge_fields };
      }
      return response(200, { id: hash, ...members.get(key) });
    }

    match = path.match(/^\/ecommerce\/stores\/([^/]+)$/);
    if (match && method === "GET") {
      const store = stores.get(match[1]!);
      return store ? response(200, store) : problem(404, "Resource Not Found", "The requested resource could not be found.");
    }
    if (path === "/ecommerce/stores" && method === "POST") {
      if (stores.has(body!.id)) return problem(400, "Invalid Resource", "A store with the provided ID already exists.");
      for (const field of ["id", "list_id", "name", "currency_code"]) {
        if (!body![field]) return problem(400, "Invalid Resource", "The resource submitted could not be validated.", [{ field, message: "This value should not be blank." }]);
      }
      if (!audiences.has(body!.list_id)) return problem(400, "Invalid Resource", "The list_id does not exist.");
      if (body!.domain && [...stores.values()].some((s) => s.domain === body!.domain)) {
        return problem(400, "Invalid Resource", "The resource submitted could not be validated.", [{ field: "domain", message: "This domain is already used by another store in this account." }]);
      }
      stores.set(body!.id, { ...body });
      return response(200, body);
    }

    match = path.match(/^\/ecommerce\/stores\/([^/]+)\/(products|customers|orders)(?:\/([^/]+))?$/);
    if (match) {
      const [, storeId, kind, id] = match as unknown as [string, string, "products" | "customers" | "orders", string | undefined];
      if (!stores.has(storeId)) return problem(404, "Resource Not Found", "The requested resource could not be found.");
      const records = { products, customers, orders }[kind];
      const key = `${storeId}/${id ?? body?.id}`;
      if (method === "GET") return records.has(key) ? response(200, records.get(key)) : problem(404, "Resource Not Found", "The requested resource could not be found.");
      if (method === "DELETE") {
        if (!records.delete(key)) return problem(404, "Resource Not Found", "The requested resource could not be found.");
        return response(204);
      }
      if (method === "PUT" && kind === "products") {
        if (!body!.variants?.length) return problem(400, "Invalid Resource", "The resource submitted could not be validated.", [{ field: "variants", message: "At least one variant is required." }]);
        // Variants are added or updated by id.
        const variants = new Map<string, Json>((products.get(key)?.variants ?? []).map((v: Json) => [v.id, v]));
        for (const v of body!.variants) variants.set(v.id, v);
        products.set(key, { ...products.get(key), ...body, variants: [...variants.values()] });
        return response(200, products.get(key));
      }
      if (method === "PUT" && kind === "customers") {
        customers.set(key, { ...customers.get(key), ...body });
        return response(200, customers.get(key));
      }
      if (method === "POST" && kind === "orders") {
        if (orders.has(key)) return problem(400, "Invalid Resource", "An order with the provided ID already exists.");
        if (!customers.has(`${storeId}/${body!.customer?.id}`) && !body!.customer?.email_address) return problem(400, "Invalid Resource", "A customer with the provided ID does not exist.");
        for (const line of body!.lines) {
          const product = products.get(`${storeId}/${line.product_id}`);
          if (!product) return problem(400, "Invalid Resource", `A product with the provided ID does not exist in the account for this list. (${line.product_id})`);
          if (!product.variants.some((v: Json) => v.id === line.product_variant_id)) return problem(400, "Invalid Resource", `A product variant with the provided ID does not exist. (${line.product_variant_id})`);
        }
        orders.set(key, { ...body });
        return response(200, body);
      }
      if (method === "PATCH" && kind === "orders") {
        if (!orders.has(key)) return problem(404, "Resource Not Found", "The requested resource could not be found.");
        orders.set(key, { ...orders.get(key), ...body });
        return response(200, orders.get(key));
      }
    }
    return problem(404, "Resource Not Found", "The requested resource could not be found.");
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : null;
    const path = url.pathname.replace(/^\/3\.0/, "");
    const call = { method, path: `${path}${url.search}`, body };
    calls.push(call);
    state.onCall(call);
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.host !== "us21.api.mailchimp.com" || !url.pathname.startsWith("/3.0/") || authorization !== `Basic ${Buffer.from(`anystring:${KEY}`).toString("base64")}`) {
      return problem(401, "API Key Invalid", "Your API key may be invalid, or you've attempted to access the wrong datacenter.");
    }
    const failure = failures.find((f) => f.times > 0 && f.method === method && path.startsWith(f.path));
    if (failure) {
      failure.times--;
      if (failure.text !== undefined) return new Response(failure.text, { status: failure.status, headers: { "content-type": "text/html" } });
      return problem(failure.status, failure.title ?? "Internal Server Error", failure.detail ?? "An unexpected internal error has occurred.", failure.errors);
    }
    return answer(method, path, body);
  };

  /** Calls other than reads, as "METHOD path". */
  const writes = () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  return { fetch, calls, writes, fail, state, audiences, members, stores, products, customers, orders };
};

export type FakeMailchimp = ReturnType<typeof fakeMailchimp>;

// ---------------------------------------------------------------- the platform

export const ADDRESS: Address = { firstName: "Ana", lastName: "Silva", line1: "1 Broad St", city: "New York", regionCode: "NY", postalCode: "10004", countryCode: "US" };

export const channel = (code: string, overrides: Partial<PluginChannel> = {}): PluginChannel => ({
  id: `ch-${code}`,
  code,
  name: `Trail Co ${code.toUpperCase()}`,
  defaultLocale: "en-US",
  storefrontUrl: `https://${code}.trail.example`,
  ...overrides,
});

export const variant = (overrides: Partial<PluginProductVariant> & Pick<PluginProductVariant, "id" | "sku">): PluginProductVariant => ({
  name: `Variant ${overrides.sku}`,
  barcode: null,
  weightGrams: 200,
  options: [],
  price: 2500,
  compareAtPrice: null,
  available: true,
  quantityAvailable: 10,
  ...overrides,
});

export const product = (overrides: Partial<PluginProduct> & Pick<PluginProduct, "id" | "name">): PluginProduct => {
  const slug = overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    channelId: "ch-us",
    locale: "en-US",
    currency: "USD",
    pricesIncludeTax: false,
    slug,
    description: null,
    seo: { title: null, description: null },
    path: `/products/${slug}`,
    url: `https://us.trail.example/products/${slug}`,
    visibleInListings: true,
    productType: { code: "apparel", name: "Apparel", isShippable: true },
    attributes: [],
    categories: [],
    media: [],
    priceRange: null,
    available: true,
    variants: [variant({ id: `${overrides.id}-v1`, sku: overrides.id.toUpperCase() })],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
};

export const customer = (overrides: Partial<PluginCustomer> & Pick<PluginCustomer, "id" | "email">): PluginCustomer => ({
  firstName: "Ana",
  lastName: "Silva",
  locale: "en-US",
  phone: null,
  acceptsMarketing: false,
  ...overrides,
});

type OrderLine = PluginOrder["lines"][number];
export const line = (overrides: Partial<OrderLine> & Pick<OrderLine, "id" | "productId" | "variantId" | "unitPrice" | "quantity">): OrderLine => ({
  sku: String(overrides.variantId).toUpperCase(),
  name: `Line ${overrides.id}`,
  variantAttributes: {},
  quantityFulfilled: 0,
  total: overrides.unitPrice * overrides.quantity,
  weightGrams: 200,
  isShippable: true,
  ...overrides,
});

export const order = (overrides: Partial<PluginOrder> = {}): PluginOrder => ({
  id: "ord-1",
  number: "US-000001",
  channelId: "ch-us",
  customerId: null,
  email: "Ana.Silva@Example.test",
  locale: "en-US",
  currency: "USD",
  status: "open",
  paymentStatus: "authorized",
  fulfillmentStatus: "unfulfilled",
  // 2 × 25.00 + 25.00, less 7.50, plus 5.99 shipping and 5.40 tax.
  subtotal: 7500,
  discountTotal: 750,
  shippingTotal: 599,
  taxTotal: 540,
  grandTotal: 7889,
  pricesIncludeTax: false,
  shippingAddress: ADDRESS,
  billingAddress: ADDRESS,
  shippingMethod: null,
  paymentMethodCode: "card",
  lines: [
    line({ id: "line-1", productId: "tee", variantId: "tee-m", name: "Everyday Tee – Black / M", unitPrice: 2500, quantity: 2 }),
    line({ id: "line-2", productId: "cap", variantId: "cap-v1", name: "Trail Cap", unitPrice: 2500, quantity: 1 }),
  ],
  fulfillments: [],
  couponCodes: ["WELCOME10"],
  metadata: {},
  createdAt: new Date("2026-10-20T09:30:00Z"),
  ...overrides,
});

/** What the platform holds: channels, the products each sells (as its storefront shows them), customers and orders. Tests change it as they go. */
export const world = () => {
  const data = {
    channels: [channel("us"), channel("eu", { name: "Trail Co Europe", defaultLocale: "de-DE" })],
    products: new Map<string, PluginProduct[]>(),
    customers: new Map<string, PluginCustomer>(),
    orders: new Map<string, PluginOrder>(),
    /** Channels deactivated since: the catalog refuses them, as the platform's does. */
    inactive: new Set<string>(),
  };
  const sold = (channelId: string) => {
    if (data.inactive.has(channelId)) throw new NotFoundError("Channel", channelId);
    return data.products.get(channelId) ?? [];
  };
  const services: PluginServices = {
    orders: {
      get: async (id) => data.orders.get(id) ?? null,
      getByNumber: async (number) => [...data.orders.values()].find((o) => o.number === number) ?? null,
      addNote: async () => {},
    },
    customers: { get: async (id) => data.customers.get(id) ?? null },
    catalog: {
      getProduct: async (id, scope) => sold(scope.channelId).find((p) => p.id === id) ?? null,
      // Oldest (lowest id) first; `next` is the page's last id.
      listProducts: async (scope) => {
        const all = sold(scope.channelId).toSorted((a, b) => (a.id < b.id ? -1 : 1));
        const start = scope.after ? all.findIndex((p) => p.id > scope.after!) : 0;
        const first = Math.min(scope.first ?? 100, 100);
        const page = start < 0 ? [] : all.slice(start, start + first);
        return { products: page, next: start >= 0 && start + first < all.length ? page.at(-1)!.id : null };
      },
    },
    channels: {
      get: async (id) => data.channels.find((c) => c.id === id) ?? null,
      getByCode: async (code) => data.channels.find((c) => c.code === code) ?? null,
      list: async () => data.channels.filter((c) => !data.inactive.has(c.id)).toSorted((a, b) => (a.code < b.code ? -1 : 1)),
      getDefault: async () => data.channels[0] ?? null,
    },
    locations: { shipFrom: async () => null },
  };
  return { data, services };
};

// ---------------------------------------------------------------- the context

/** kv in memory, as the platform's: values are copied in and out. */
export const fakeKv = () => {
  const entries = new Map<string, unknown>();
  return {
    entries,
    get: async <T>(key: string) => (entries.has(key) ? (structuredClone(entries.get(key)) as T) : null),
    set: async (key: string, value: unknown) => void entries.set(key, structuredClone(value)),
    add: async (key: string, value: unknown) => (entries.has(key) ? false : (entries.set(key, structuredClone(value)), true)),
    delete: async (key: string) => void entries.delete(key),
    list: async <T>(prefix: string, options?: { limit?: number }) =>
      [...entries.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .slice(0, options?.limit ?? 100)
        .map((key) => ({ key, value: structuredClone(entries.get(key)) as T })),
  };
};

const quiet = () => {};
/** A logger that says nothing. */
export const silent = { trace: quiet, debug: quiet, info: quiet, warn: quiet, error: quiet, fatal: quiet, child: () => silent };

/** A plugin context built by hand, as the runtime builds one. */
export const contextFor = (api: FakeMailchimp, platform: ReturnType<typeof world>, settings: Partial<MailchimpContext["settings"]> = {}) => {
  const kv = fakeKv();
  const ctx = {
    plugin: { name: "mailchimp", version: "1.0.0" },
    settings: { apiKey: KEY, audienceId: AUDIENCE, storeIdPrefix: "spindle", ...settings },
    fetch: api.fetch,
    kv,
    // As the platform's: claim the key, run, mark it done; a throwing fn frees it.
    once: async (key: string, fn: () => Promise<void>) => {
      if (!(await kv.add(`once:${key}`, { state: "running" }))) return false;
      try {
        await fn();
      } catch (error) {
        await kv.delete(`once:${key}`);
        throw error;
      }
      await kv.set(`once:${key}`, { state: "done" });
      return true;
    },
    logger: silent,
    services: platform.services,
    urls: { admin: "https://api.trail.example/admin", api: "https://api.trail.example" },
    production: false,
  };
  return ctx as unknown as MailchimpContext & { kv: ReturnType<typeof fakeKv> };
};

let eventIds = 0;
/** Delivers a platform event to the plugin's handler, as the outbox worker does. */
export const deliver = (ctx: MailchimpContext, type: string, aggregateId: string, payload: Record<string, unknown> = {}, occurredAt = new Date("2026-10-21T12:00:00Z")) => {
  const handler = mailchimp().events?.[type];
  if (!handler) throw new Error(`The plugin does not handle ${type}`);
  const event: PluginEvent = { id: `evt-${++eventIds}`, type, aggregateType: type.split(".")[0]!, aggregateId, payload, occurredAt };
  return handler(event, ctx);
};
