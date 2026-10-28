import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { NotFoundError } from "@spindlecommerce/plugin-sdk";
import type { MailchimpContext } from "./settings.ts";

type ApiContext = Pick<MailchimpContext, "settings" | "fetch">;
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Mailchimp may take up to 120 seconds to answer. Event deliveries have 30 seconds and are retried,
 * so a call that hangs fails sooner and runs again later.
 */
const TIMEOUT_MS = 15_000;

/** "…-us21" → "us21": the part after the last dash is the data centre that serves the account. */
export const dataCenter = (apiKey: string): string => {
  const key = apiKey.trim();
  const dash = key.lastIndexOf("-");
  const dc = dash > 0 ? key.slice(dash + 1) : "";
  // Letters and digits only: it becomes part of the host name.
  if (!/^[a-z0-9]+$/i.test(dc)) throw new Error("The API key should end with its data centre, such as -us21: copy the whole key from Mailchimp");
  return dc.toLowerCase();
};

export const apiBase = (apiKey: string) => `https://${dataCenter(apiKey)}.api.mailchimp.com/3.0`;

/** The audience, as staff pasted it. */
export const audienceOf = (ctx: Pick<MailchimpContext, "settings">) => ctx.settings.audienceId.trim();

/** A path segment from a setting or an id. */
export const segment = (value: string) => encodeURIComponent(value);

type ErrorBody = { title?: unknown; detail?: unknown; errors?: { field?: unknown; message?: unknown }[] };

/** An answer other than 2xx, with Mailchimp's own explanation: `{ title, detail, errors: [{ field, message }] }`. */
export class MailchimpError extends Error {
  readonly status: number;
  /** Mailchimp's title, e.g. "Invalid Resource" or "Member In Compliance State". */
  readonly title: string | null;
  /** The fields named in `errors`, e.g. ["domain"]. */
  readonly fields: string[];

  constructor(status: number, body: unknown, text: string) {
    const parsed: ErrorBody = body && typeof body === "object" ? (body as ErrorBody) : {};
    const title = typeof parsed.title === "string" ? parsed.title : null;
    const detail = typeof parsed.detail === "string" ? parsed.detail : null;
    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    const fieldErrors = errors.map((e) => [e.field, e.message].filter((part) => typeof part === "string" && part).join(": ")).filter(Boolean);
    const summary = [title, detail].filter(Boolean).join(": ") || text.trim().slice(0, 200) || "no details";
    super(`Mailchimp answered ${status}: ${summary}${fieldErrors.length ? ` (${fieldErrors.join("; ")})` : ""}`);
    this.name = "MailchimpError";
    this.status = status;
    this.title = title;
    this.fields = errors.flatMap((e) => (typeof e.field === "string" ? [e.field] : []));
  }
}

export const isNotFound = (error: unknown) => error instanceof MailchimpError && error.status === 404;

/**
 * The platform's NotFoundError, e.g. from the catalog for a channel deactivated since. Matched by
 * its code too: where the SDK is loaded twice (as by a test runner), each copy has its own class.
 */
export const isPlatformNotFound = (error: unknown) => error instanceof NotFoundError || (error instanceof Error && (error as { code?: unknown }).code === "NOT_FOUND");

/** One call to the Marketing API, with HTTP basic auth (any user name, the key as password). Returns the JSON answer, or null for none (204). */
export const mailchimpRequest = async <T = unknown>(ctx: ApiContext, method: Method, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> => {
  const key = ctx.settings.apiKey.trim();
  const response = await ctx.fetch(`${apiBase(key)}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`anystring:${key}`).toString("base64")}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: an outage page or a proxy's answer.
  }
  if (!response.ok) throw new MailchimpError(response.status, json, text);
  return json as T;
};

/** The MD5 of the lowercased address: how Mailchimp names an audience member. Guests' customer ids use it too. */
export const emailHash = (email: string) => createHash("md5").update(email.toLowerCase()).digest("hex");

/**
 * Decimal places of currencies whose minor unit is not the cent, as the platform counts them (ISO
 * 4217). Intl's own figures differ for some, e.g. HUF and IDR, which the platform keeps in cents.
 */
const EXPONENTS: Record<string, number> = {
  BHD: 3, BIF: 0, CLP: 0, DJF: 0, GNF: 0, IQD: 3, ISK: 0, JOD: 3, JPY: 0, KMF: 0, KRW: 0,
  KWD: 3, LYD: 3, OMR: 3, PYG: 0, RWF: 0, TND: 3, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};

/** Minor units → Mailchimp's decimal amounts: 1999 USD → 19.99, 1500 JPY → 1500. */
export const toMajorUnits = (amount: number, currency: string) => amount / 10 ** (EXPONENTS[currency.toUpperCase()] ?? 2);
