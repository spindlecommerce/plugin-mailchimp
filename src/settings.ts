import { setting, type PluginContext } from "@spindlecommerce/plugin-sdk";

export const mailchimpSettings = {
  apiKey: setting.secret({
    label: "API key",
    description: "Mailchimp › Profile › Extras › API keys. The part after the last dash is the data centre that serves your account, e.g. us21.",
    required: true,
    env: "MAILCHIMP_API_KEY",
  }),
  audienceId: setting.string({
    label: "Audience ID",
    description: "Audience › Settings › Audience name and defaults. Customers join this audience, and each channel's store is tied to it for good.",
    required: true,
    placeholder: "a1b2c3d4e5",
  }),
  storeIdPrefix: setting.string({
    label: "Store ID prefix",
    description: "Each channel has a store in Mailchimp called <prefix>-<channel code>, e.g. spindle-us. A new prefix starts new stores, e.g. for another audience.",
    default: "spindle",
  }),
};

export type MailchimpSettings = typeof mailchimpSettings;
export type MailchimpContext = PluginContext<MailchimpSettings>;
