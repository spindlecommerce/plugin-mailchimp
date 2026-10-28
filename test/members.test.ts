import { describe, expect, it } from "vitest";
import { AUDIENCE, contextFor, customer, deliver, fakeMailchimp, md5, world } from "./helpers.ts";

const setup = () => {
  const api = fakeMailchimp();
  const platform = world();
  const ctx = contextFor(api, platform);
  const member = (email: string) => api.members.get(`${AUDIENCE}/${md5(email.toLowerCase())}`);
  return { api, platform, ctx, member };
};

describe("audience members", () => {
  it("subscribes customers who accept marketing, with their names", async () => {
    const { api, platform, ctx, member } = setup();
    platform.data.customers.set("cus-1", customer({ id: "cus-1", email: "Ana.Silva@Example.test", acceptsMarketing: true }));
    await deliver(ctx, "customer.created", "cus-1");
    expect(api.calls).toEqual([
      {
        method: "PUT",
        path: `/lists/aud1/members/${md5("ana.silva@example.test")}?skip_merge_validation=true`,
        body: { email_address: "Ana.Silva@Example.test", status_if_new: "subscribed", status: "subscribed", merge_fields: { FNAME: "Ana", LNAME: "Silva" } },
      },
    ]);
    expect(member("ana.silva@example.test")).toMatchObject({ status: "subscribed", merge_fields: { FNAME: "Ana", LNAME: "Silva" } });

    // Consent given later subscribes a member who was transactional (an earlier guest order, say).
    platform.data.customers.set("cus-2", customer({ id: "cus-2", email: "sam@example.test", firstName: "Sam", lastName: null }));
    await deliver(ctx, "customer.created", "cus-2");
    expect(member("sam@example.test")).toMatchObject({ status: "transactional" });
    platform.data.customers.set("cus-2", customer({ id: "cus-2", email: "sam@example.test", firstName: "Sam", lastName: null, acceptsMarketing: true }));
    await deliver(ctx, "customer.updated", "cus-2");
    expect(member("sam@example.test")).toEqual({ email_address: "sam@example.test", status: "subscribed", merge_fields: { FNAME: "Sam" } });
  });

  it("adds customers without consent as transactional, and never changes an existing member's status for them", async () => {
    const { api, platform, ctx, member } = setup();
    platform.data.customers.set("cus-1", customer({ id: "cus-1", email: "lee@example.test", firstName: "Lee", lastName: "Park" }));
    await deliver(ctx, "customer.created", "cus-1");
    expect(api.calls[0]!.body).toEqual({ email_address: "lee@example.test", status_if_new: "transactional", merge_fields: { FNAME: "Lee", LNAME: "Park" } });
    expect(member("lee@example.test")).toMatchObject({ status: "transactional" });

    // Members who signed up through Mailchimp, or unsubscribed there, keep their status.
    api.members.set(`${AUDIENCE}/${md5("kim@example.test")}`, { email_address: "kim@example.test", status: "subscribed", merge_fields: {} });
    api.members.set(`${AUDIENCE}/${md5("jo@example.test")}`, { email_address: "jo@example.test", status: "unsubscribed", merge_fields: {} });
    platform.data.customers.set("cus-2", customer({ id: "cus-2", email: "kim@example.test", firstName: "Kim" }));
    platform.data.customers.set("cus-3", customer({ id: "cus-3", email: "jo@example.test", firstName: "Jo" }));
    await deliver(ctx, "customer.updated", "cus-2");
    await deliver(ctx, "customer.updated", "cus-3");
    expect(member("kim@example.test")).toMatchObject({ status: "subscribed", merge_fields: { FNAME: "Kim" } });
    expect(member("jo@example.test")).toMatchObject({ status: "unsubscribed", merge_fields: { FNAME: "Jo" } });
  });

  it("leaves someone who unsubscribed in Mailchimp unsubscribed, even if they accept marketing here", async () => {
    const { api, platform, ctx, member } = setup();
    api.members.set(`${AUDIENCE}/${md5("jo@example.test")}`, { email_address: "jo@example.test", status: "unsubscribed", merge_fields: {} });
    platform.data.customers.set("cus-3", customer({ id: "cus-3", email: "jo@example.test", firstName: "Jo", lastName: "Reyes", acceptsMarketing: true }));
    await deliver(ctx, "customer.updated", "cus-3");
    // Mailchimp refuses to resubscribe them through the API; their names still change.
    expect(api.calls.map((c) => c.body.status ?? null)).toEqual(["subscribed", null]);
    expect(member("jo@example.test")).toEqual({ email_address: "jo@example.test", status: "unsubscribed", merge_fields: { FNAME: "Jo", LNAME: "Reyes" } });
  });

  it("ignores customers deleted since, and retries what Mailchimp could not take", async () => {
    const { api, platform, ctx } = setup();
    await deliver(ctx, "customer.updated", "gone");
    expect(api.calls).toEqual([]);

    platform.data.customers.set("cus-1", customer({ id: "cus-1", email: "lee@example.test" }));
    api.fail("PUT", "/lists/aud1/members/", 400, { title: "Invalid Resource", detail: "lee@example.test looks fake or invalid, please enter a real email address." });
    await expect(deliver(ctx, "customer.created", "cus-1")).rejects.toThrow(
      "Mailchimp answered 400: Invalid Resource: lee@example.test looks fake or invalid, please enter a real email address.",
    );
  });
});
