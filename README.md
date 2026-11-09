# Salone Fresh Harvest

A web and mobile portal that links Sierra Leone farmers directly to customers. Farmers list produce, customers order and pay online, and farmers deliver. This is what the pitch deck describes.

## Quick start

Requires **Node.js 22.13 or newer**. Nothing else is needed: the database is SQLite and is built into Node.

```bash
npm install
npm run seed     # optional: demo farmers, a demo customer and 12 sample products
npm start        # http://localhost:3000
```

On first start the server creates an **admin account** and prints its phone number and password once. To choose them yourself, set `ADMIN_PHONE` and `ADMIN_PASSWORD` before the first start.

Demo logins after `npm run seed` (password `harvest123`):

| Role     | Phone      |
|----------|------------|
| Farmer   | 076 111111 |
| Farmer   | 078 333333 |
| Customer | 079 444444 |

## How it works (matches the deck)

1. **Farmers list.** A farmer signs up and posts produce with category, unit, price (SLe), quantity, district, harvest date and a photo. Photos are resized on the phone before upload to save data.
2. **Customers order.** Customers browse and filter by category and district, add items to a basket and check out with a delivery address. A basket with produce from several farms becomes one order per farm. Stock is reserved when the order is placed.
3. **The farmer confirms and sets the delivery charge.** This follows the deck's "delivery charge is set per order". The amount is pre-filled from the farmer's default and can be changed for each order. The farmer can also decline, which returns the stock.
4. **The customer pays** with Orange Money, Afrimoney, QMoney or a bank card.
5. **The farmer delivers.** The farmer marks the order *Out for delivery* and then *Delivered*. Both sides see a timeline of every step.

**Service fee:** a percentage of the produce value is charged on each order and shown as its own line. The deck leaves this as "[__]%, to be confirmed", so the default is **5%**. The admin can change it under *Admin → Overview*. Each order keeps the rate that applied when it was placed.

**Admin:** headline numbers (farmers, customers, live listings, paid order value, service fees earned), all orders, suspending or reactivating users, and the service fee setting.

**Mobile:** the site works at phone width and can be installed to the home screen (PWA).

## Payments: simulated until a gateway is chosen

`PAYMENT_MODE=simulated` (the default) approves payments instantly and no money moves. A mobile number ending in `0000` simulates a declined payment. To go live, implement `charge()` in [server/payments.js](server/payments.js) against the chosen provider: an MMO API, or a licensed aggregator on the National Switch Instant Payment System. Then set `PAYMENT_MODE=live`. Use the provider's hosted checkout for cards so card details never reach this server.

## Configuration

| Variable              | Default          | Purpose                                         |
|-----------------------|------------------|-------------------------------------------------|
| `PORT`                | `3000`           | HTTP port                                        |
| `DATA_DIR`            | `./data`         | Database and uploaded photos                     |
| `ADMIN_PHONE`         | `+23299000000`   | Admin login, used on first start only            |
| `ADMIN_PASSWORD`      | random, printed  | Admin password, used on first start only         |
| `SERVICE_FEE_PERCENT` | `5`              | Starting fee, until the admin changes it         |
| `PAYMENT_MODE`        | `simulated`      | `simulated` or `live`                            |

Back up the `data/` folder: it holds all accounts, orders and photos. In production, run behind HTTPS (for example nginx or Caddy as a reverse proxy) so the login cookie is sent securely.

## Project layout

```
server/index.js      API routes, order workflow, validation
server/db.js         SQLite schema and helpers
server/auth.js       password hashing (scrypt), sessions, login rate limit
server/payments.js   payment adapter (simulated / live hook)
server/seed.js       demo data
public/              the web/mobile app (no build step)
test/api.test.js     end-to-end API tests: npm test
```

## Not built yet

- Real payment gateway integration, and farmer payouts / settlement reports
- SMS or WhatsApp notifications when an order changes status (farmers currently check their dashboard)
- Password reset by SMS (the admin can help in the meantime)
- Ratings and reviews
