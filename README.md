# Mailchimp, a SpindleCommerce plugin

Customers, products and orders in [Mailchimp](https://mailchimp.com), for email marketing that knows
what people buy:

- Customers join your audience, subscribed only when they accept marketing.
- Each channel gets a Mailchimp store with the products it sells, their prices and stock.
- Paid orders go to the store with their customer.

With them, Mailchimp's purchase segments, product recommendations, e-commerce automations (first
purchase, product follow-ups, best customers) and order notifications work with your shop's data.

## Setup

1. **Add the plugin** to your SpindleCommerce installation and deploy. It needs plugin SDK 1.1, and
   pnpm says so if the installation is older.

   ```bash
   pnpm add @spindlecommerce/plugin-mailchimp
   ```

   ```ts
   // ecom.config.ts
   import { mailchimp } from "@spindlecommerce/plugin-mailchimp";

   export default defineConfig({ plugins: [email(), stripe(), mailchimp()] });
   ```

2. **Create an API key** in Mailchimp, under Profile › Extras › API keys. It ends with the data
   centre that serves your account, such as `-us21`.

3. **Settings › Plugins › Mailchimp.** Enter the API key and the audience ID, from Audience ›
   Settings › Audience name and defaults. On a server, the `MAILCHIMP_API_KEY` environment
   variable can supply the key instead. **Test connection** checks the key and names the audience.

4. **Give each channel a storefront** under Settings › Storefronts, so that products link to it and
   each store gets the storefront's domain.

5. **Sync the catalogue now** with **Run now** on the plugin's `sync-products` task, rather than
   waiting a day for it. A run sends what it can in about 4 minutes, typically several hundred
   products, and the next run carries on from there: run it again for a larger catalogue.

6. **Order notifications** are Mailchimp's own emails, sent when an order's status changes. Turn
   them on in Mailchimp only if your installation doesn't send the same emails already, as the email
   plugin does, or customers get two of each.

## Settings

| Setting | |
|---|---|
| API key | Secret, required (`MAILCHIMP_API_KEY`). The part after its last dash names the data centre: the plugin calls `https://<dc>.api.mailchimp.com/3.0`. |
| Audience ID | Required. Customers join this audience, and each store is tied to it. |
| Store ID prefix | Default `spindle`. Each channel's store is `<prefix>-<channel code>`, e.g. `spindle-us`. |

A Mailchimp store can't move to another audience. To switch audiences, change the store ID prefix
too: new stores are created in the new audience, and the old ones stay where they are.

## What syncs

| SpindleCommerce | Mailchimp | When |
|---|---|---|
| Customer | Audience member, with `FNAME` and `LNAME` | `customer.created`, `customer.updated` |
| Channel | Store `<prefix>-<channel code>`: the channel's name, default currency and storefront domain, platform "SpindleCommerce" | When first needed |
| Product, as the channel's storefront shows it | Product: title, URL, HTML description and first image; variants with title, SKU, price, stock and URL | `product.created`, `product.updated`, `price.updated`; daily, by the `sync-products` task |
| Deleted product | Removed from every store | `product.deleted` |
| Paid order | Order with its customer, totals, promo codes and lines | The first of `order.payment_authorized` and `order.payment_captured` |
| Payment, fulfilment, refund, cancellation | The order's financial status (`paid`, `partially_refunded`, `refunded`, `cancelled`) and fulfilment status (`shipped`, with the tracking number) | `order.payment_captured`, `order.fulfilled`, `order.refunded`, `order.canceled` |

- **Products** go to the store of each channel that sells them, with a guest's prices in the
  channel's default currency. Amounts are converted from minor units: `1999` USD is `19.99`, and
  `1500` JPY stays `1500`. Stock is the channel's salable quantity; variants that don't track
  inventory report 1,000,000, so that they count as in stock.
- **The daily task** goes through every product each channel sells, a page at a time, which also
  catches stock and price changes that send no event. A run stops after about 4 minutes, under the
  platform's 5-minute limit, and the next carries on from there. Products Mailchimp refuses are
  skipped and named in the run's error.
- **Orders** go once, when their payment is first authorized or captured, so unpaid orders don't go.
  - Lines carry unit prices.
  - The customer is the customer's account, or `guest-<MD5 of the email>` for guests.
  - The order's products are sent first, since Mailchimp refuses orders for products it doesn't
    know. A product the channel no longer sells is made from the order's lines, out of stock.
  - An order sent as `pending` (authorized) becomes `paid` when it is captured.
  - A status that hasn't changed isn't sent again, so each notification goes once.
  - Updates for orders that were never sent are skipped; such orders go with their statuses of the
    time when they are paid.
- **Stores** are created the first time a channel needs one. A store deleted in Mailchimp is created
  again.

## Consent

- **Customers who accept marketing** are subscribed: new members join as `subscribed`, and
  existing members are subscribed too, such as the transactional member of an earlier guest order.
- **Customers who don't** join as `transactional` members, who get no campaigns. Existing members
  keep their status: someone who signed up through a Mailchimp form stays subscribed.
- **Guests** never opt in. Their orders add them as transactional members if they are new.
- **Unsubscribing in Mailchimp wins.** Mailchimp won't resubscribe someone who unsubscribed (or
  bounced) through the API, so the plugin updates their names and leaves their status. They can
  rejoin through a Mailchimp signup form.
- **Withdrawing consent here doesn't unsubscribe anyone.** The platform can't tell a customer who
  withdrew consent from one who never gave it, so the plugin never lowers a member's status.
  Unsubscribe them in Mailchimp, where every campaign has an unsubscribe link.
- **Every paid order** reaches Mailchimp with the customer's email and name, whatever their
  consent, as transactional data. Addresses and phone numbers are not sent. Name Mailchimp in your
  privacy notice.

## Limitations

- **One currency per store**, the channel's default, set when the store is created. Orders in
  another of the channel's currencies are sent in their own; Mailchimp's docs don't say how its
  reports combine currencies. Later changes to a channel's currency, name or storefront don't
  change its store.
- **Promo codes.** Plugins aren't told what each code saved, so the order's discount, automatic
  promotions included, is shared equally among its codes, as fixed amounts.
- **Products taken off a channel** (unpublished, or made inactive) stay in its store, with their last
  stock, until they are deleted. **Variants** removed from a product may stay too: the upsert adds
  and updates variants, and Mailchimp's docs don't say whether it drops the others.
- **Stock and scheduled prices** change in Mailchimp with the daily run, or with the product's next
  event.
- **Not sent:** carts (abandoned-cart automations need them), campaign attribution (orders carry no
  `campaign_id`), promo rules, addresses, and orders placed before the plugin was set up.
- **Customers.** A new email address makes a new member, and the old one stays. Deleting a customer
  doesn't remove them from Mailchimp.
- **Contacts count.** Every customer, and every guest who pays, becomes a contact: a transactional
  one without consent. Mailchimp prices its plans by contacts, and non-subscribed ones count.
- **Store domains** must be unique in a Mailchimp account. When channels share a storefront, the
  first store created gets the domain and the others have none.
- **Mailchimp's own limits:**
  - 10 simultaneous connections per user, across all the account's API keys and apps. Calls beyond
    that are answered 429: event deliveries retry with backoff, and the daily task stops and carries
    on next time.
  - Calls can take up to 120 seconds. The plugin gives up after 15 and the platform retries.
  - Exceeding the limits can get the account's API access disabled, and Mailchimp doesn't raise
    them for individual accounts.
  - See Mailchimp's [rate limits and timeouts](https://mailchimp.com/developer/marketing/api-concepts/rate-limits-and-timeouts/).

## Develop

```bash
pnpm install
pnpm test
pnpm build
```

The tests run the plugin with a hand-built context (the platform's services, kv and `once`) against
a fake Mailchimp API. The plugin API it builds on is
[@spindlecommerce/plugin-sdk](https://www.npmjs.com/package/@spindlecommerce/plugin-sdk).

## Release

Each version is staged on npm and goes live when a maintainer approves it.

1. Raise `version` in `package.json` and in `src/index.ts`. A test checks they match.
2. Commit, then tag and push: for example `git tag v1.0.1 && git push origin main v1.0.1`.
3. The Release workflow tests, builds and stages the version, and creates the GitHub release.
4. Approve it on npmjs.com, under **Staged Packages**, with 2FA.

The workflow publishes with npm's trusted publishing, so it needs no token. Before its first release,
a maintainer links the package to the workflow:

```bash
npm trust github @spindlecommerce/plugin-mailchimp --repo spindlecommerce/plugin-mailchimp --file release.yml --allow-stage-publish
```

Run it just before tagging: npm drops a link that isn't used within 48 hours.

## License

MIT
