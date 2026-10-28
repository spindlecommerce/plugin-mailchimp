import { NotFoundError } from "@spindlecommerce/plugin-sdk";
import { describe, expect, it } from "vitest";
import { apiBase, dataCenter, emailHash, isPlatformNotFound, MailchimpError, mailchimpRequest, toMajorUnits } from "../src/api.ts";
import { contextFor, fakeMailchimp, KEY, md5, world } from "./helpers.ts";

describe("the Mailchimp API client", () => {
  it("finds the data centre after the key's last dash", () => {
    expect(dataCenter(KEY)).toBe("us21");
    expect(dataCenter(" 0123-4567-US6 ")).toBe("us6");
    expect(apiBase(KEY)).toBe("https://us21.api.mailchimp.com/3.0");
    expect(() => dataCenter("0123456789abcdef")).toThrow("The API key should end with its data centre, such as -us21");
    expect(() => dataCenter("0123-")).toThrow("should end with its data centre");
    // It becomes part of a host name: nothing else gets in.
    expect(() => dataCenter("0123-evil.example/x?")).toThrow("should end with its data centre");
  });

  it("calls the key's data centre with basic auth and returns the JSON answer", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ health_status: "Everything's Chimpy!" });
    };
    const ctx = contextFor({ ...fakeMailchimp(), fetch }, world(), { apiKey: ` ${KEY} ` });
    expect(await mailchimpRequest(ctx, "GET", "/ping")).toEqual({ health_status: "Everything's Chimpy!" });
    expect(requests[0]!.url).toBe("https://us21.api.mailchimp.com/3.0/ping");
    expect(new Headers(requests[0]!.init?.headers).get("authorization")).toBe(`Basic ${Buffer.from(`anystring:${KEY}`).toString("base64")}`);
    expect(requests[0]!.init?.body).toBeUndefined();

    await mailchimpRequest(ctx, "PUT", "/lists/aud1/members/abc", { email_address: "a@b.test" });
    expect(new Headers(requests[1]!.init?.headers).get("content-type")).toBe("application/json");
    expect(requests[1]!.init?.body).toBe('{"email_address":"a@b.test"}');
  });

  it("throws errors with Mailchimp's title, detail and field errors", async () => {
    const api = fakeMailchimp();
    const ctx = contextFor(api, world());
    api.fail("POST", "/ecommerce/stores", 400, {
      title: "Invalid Resource",
      detail: "The resource submitted could not be validated. For field-specific details, see the 'errors' array.",
      errors: [
        { field: "currency_code", message: "This value should be a valid currency." },
        { field: "domain", message: "This value is too long." },
      ],
    });
    const error = await mailchimpRequest(ctx, "POST", "/ecommerce/stores", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailchimpError);
    expect(error).toMatchObject({
      status: 400,
      title: "Invalid Resource",
      fields: ["currency_code", "domain"],
      message:
        "Mailchimp answered 400: Invalid Resource: The resource submitted could not be validated. For field-specific details, see the 'errors' array. (currency_code: This value should be a valid currency.; domain: This value is too long.)",
    });

    // A wrong key, or the wrong data centre.
    await expect(mailchimpRequest(contextFor(api, world(), { apiKey: "0123456789abcdef-us6" }), "GET", "/ping")).rejects.toThrow(
      "Mailchimp answered 401: API Key Invalid: Your API key may be invalid, or you've attempted to access the wrong datacenter.",
    );
    // An answer that is not JSON, e.g. from a proxy.
    api.fail("GET", "/ping", 502, { text: "<html><body>Bad gateway</body></html>" });
    await expect(mailchimpRequest(ctx, "GET", "/ping")).rejects.toThrow("Mailchimp answered 502: <html><body>Bad gateway</body></html>");
    // An empty answer (204) is null.
    api.stores.set("spindle-us", { id: "spindle-us" });
    api.products.set("spindle-us/p", { id: "p" });
    expect(await mailchimpRequest(ctx, "DELETE", "/ecommerce/stores/spindle-us/products/p")).toBeNull();
  });

  it("converts minor units with the currency's decimal places, as the platform counts them", () => {
    expect(toMajorUnits(1999, "USD")).toBe(19.99);
    expect(toMajorUnits(5, "eur")).toBe(0.05);
    expect(toMajorUnits(-250, "GBP")).toBe(-2.5);
    expect(toMajorUnits(1500, "JPY")).toBe(1500);
    expect(toMajorUnits(12345, "KWD")).toBe(12.345);
    // Cents, although Intl shows none.
    expect(toMajorUnits(99999, "HUF")).toBe(999.99);
  });

  it("recognises the platform's NotFoundError, from any copy of the SDK", () => {
    expect(isPlatformNotFound(new NotFoundError("Channel", "eu"))).toBe(true);
    // Another copy's class, as under a test runner that loads the SDK twice.
    class OtherNotFoundError extends Error {
      readonly code = "NOT_FOUND";
    }
    expect(isPlatformNotFound(new OtherNotFoundError("Channel eu was not found"))).toBe(true);
    expect(isPlatformNotFound(new MailchimpError(404, { title: "Resource Not Found" }, ""))).toBe(false);
    expect(isPlatformNotFound(new Error("Channel eu was not found"))).toBe(false);
  });

  it("names members by the MD5 of their lowercased address", () => {
    expect(emailHash("Ana.Silva@Example.test")).toBe(md5("ana.silva@example.test"));
    expect(emailHash("ana.silva@example.test")).toMatch(/^[0-9a-f]{32}$/);
  });
});
