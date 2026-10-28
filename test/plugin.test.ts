import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { checkConnection } from "../src/check.ts";
import { mailchimp } from "../src/index.ts";
import { contextFor, fakeMailchimp, world } from "./helpers.ts";

describe("the connection check", () => {
  it("pings Mailchimp, then finds the audience", async () => {
    const api = fakeMailchimp();
    expect(await checkConnection(contextFor(api, world()))).toEqual({
      ok: true,
      message: `Connected to the audience "Trail Co" (1200 subscribed). Each channel's store is spindle-<channel code>.`,
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /ping", "GET /lists/aud1?fields=name,stats.member_count"]);
  });

  it("says what is wrong", async () => {
    const api = fakeMailchimp();
    const check = (settings: Parameters<typeof contextFor>[2]) => checkConnection(contextFor(api, world(), settings));
    expect(await check({ apiKey: "0123456789abcdef" })).toEqual({ ok: false, message: "The API key should end with its data centre, such as -us21: copy the whole key from Mailchimp" });
    expect(await check({ apiKey: "0123456789abcdef-us6" })).toEqual({
      ok: false,
      message: "Mailchimp refused the API key. Mailchimp answered 401: API Key Invalid: Your API key may be invalid, or you've attempted to access the wrong datacenter.",
    });
    expect(await check({ audienceId: "nope" })).toEqual({
      ok: false,
      message: "The API key works, but Mailchimp has no audience nope: copy its ID from Audience › Settings › Audience name and defaults.",
    });
    api.fail("GET", "/ping", 503, { title: "Service Unavailable", detail: "Mailchimp is down for maintenance." });
    expect(await check({})).toEqual({ ok: false, message: "Could not reach Mailchimp: Mailchimp answered 503: Service Unavailable: Mailchimp is down for maintenance." });
  });
});

describe("the plugin", () => {
  it("syncs customers, products and orders, for plugin API 1", () => {
    const plugin = mailchimp();
    expect(plugin).toMatchObject({ name: "mailchimp", apiVersion: 1, title: "Mailchimp" });
    expect(Object.keys(plugin.settings!)).toEqual(["apiKey", "audienceId", "storeIdPrefix"]);
    expect(plugin.settings).toMatchObject({
      apiKey: { type: "secret", required: true, env: "MAILCHIMP_API_KEY" },
      audienceId: { type: "string", required: true },
      storeIdPrefix: { type: "string", default: "spindle" },
    });
    expect(Object.keys(plugin.events!)).toEqual([
      "customer.created",
      "customer.updated",
      "product.created",
      "product.updated",
      "price.updated",
      "product.deleted",
      "order.payment_authorized",
      "order.payment_captured",
      "order.fulfilled",
      "order.canceled",
      "order.refunded",
    ]);
    expect(plugin.check).toBe(checkConnection);
  });

  it("reports the package's version", async () => {
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(mailchimp().version).toBe(version);
  });
});
