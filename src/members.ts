import type { PluginCustomer } from "@spindlecommerce/plugin-sdk";
import { audienceOf, emailHash, MailchimpError, mailchimpRequest, segment } from "./api.ts";
import type { MailchimpContext } from "./settings.ts";

/** Names as merge fields; a missing name is left out rather than clearing one Mailchimp has. */
const mergeFields = (customer: Pick<PluginCustomer, "firstName" | "lastName">) => ({
  ...(customer.firstName ? { FNAME: customer.firstName } : {}),
  ...(customer.lastName ? { LNAME: customer.lastName } : {}),
});

/** Someone who unsubscribed (or was cleaned) can only rejoin through Mailchimp's own forms. */
const isComplianceState = (error: unknown) => error instanceof MailchimpError && error.status === 400 && error.title === "Member In Compliance State";

/**
 * The customer as a member of the audience. Consent decides only how a new member joins:
 * subscribed when they accept marketing, else transactional (order emails only). An existing
 * member's status is left alone, except that accepting marketing subscribes them.
 */
export const upsertMember = async (ctx: MailchimpContext, customer: PluginCustomer) => {
  // skip_merge_validation: audiences may require merge fields the platform cannot fill.
  const path = `/lists/${segment(audienceOf(ctx))}/members/${emailHash(customer.email)}?skip_merge_validation=true`;
  const member = {
    email_address: customer.email,
    status_if_new: customer.acceptsMarketing ? "subscribed" : "transactional",
    merge_fields: mergeFields(customer),
  };
  if (!customer.acceptsMarketing) {
    await mailchimpRequest(ctx, "PUT", path, member);
    return;
  }
  try {
    await mailchimpRequest(ctx, "PUT", path, { ...member, status: "subscribed" });
  } catch (error) {
    if (!isComplianceState(error)) throw error;
    ctx.logger.info({ customerId: customer.id }, "The customer unsubscribed in Mailchimp, which only they can undo: their names were updated, not their status");
    await mailchimpRequest(ctx, "PUT", path, member);
  }
};

/** customer.created and customer.updated. */
export const syncMember = async (ctx: MailchimpContext, customerId: string) => {
  const customer = await ctx.services.customers.get(customerId);
  if (customer) await upsertMember(ctx, customer);
};
