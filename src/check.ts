import { audienceOf, dataCenter, isNotFound, MailchimpError, mailchimpRequest, segment } from "./api.ts";
import type { MailchimpContext } from "./settings.ts";
import { storePrefix } from "./stores.ts";

/** Two calls within the platform's 15 seconds for a check. */
const CHECK_TIMEOUT_MS = 7_000;

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** "Test connection": the key works (GET /ping) and the audience exists. */
export const checkConnection = async (ctx: Pick<MailchimpContext, "settings" | "fetch">): Promise<{ ok: boolean; message: string }> => {
  try {
    dataCenter(ctx.settings.apiKey);
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
  try {
    await mailchimpRequest(ctx, "GET", "/ping", undefined, CHECK_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof MailchimpError && (error.status === 401 || error.status === 403)) return { ok: false, message: `Mailchimp refused the API key. ${error.message}` };
    return { ok: false, message: `Could not reach Mailchimp: ${describe(error)}` };
  }
  const audience = audienceOf(ctx);
  try {
    const list = await mailchimpRequest<{ name?: string; stats?: { member_count?: number } }>(ctx, "GET", `/lists/${segment(audience)}?fields=name,stats.member_count`, undefined, CHECK_TIMEOUT_MS);
    const members = list.stats?.member_count;
    return {
      ok: true,
      message: `Connected to the audience "${list.name ?? audience}"${typeof members === "number" ? ` (${members} subscribed)` : ""}. Each channel's store is ${storePrefix(ctx)}-<channel code>.`,
    };
  } catch (error) {
    if (isNotFound(error)) return { ok: false, message: `The API key works, but Mailchimp has no audience ${audience}: copy its ID from Audience › Settings › Audience name and defaults.` };
    return { ok: false, message: `Could not read the audience: ${describe(error)}` };
  }
};
