# ISP Desk

Offline-first, mobile-first management app for an internet service provider (ISP) in Pakistan.
Static PWA (no build step): HTML5 · ES modules · jQuery · Bootstrap 5 · Bootstrap Icons · IndexedDB · Service Worker.

It was converted from the earlier SaleAPP POS. The shell, login, router, database layer, backup and service worker were kept. Sales and purchases were replaced with subscribers, plans, monthly billing, collections, complaints, expenses and profit & loss.

## What it does

| Area | Features |
|---|---|
| **Dashboard** | This month's billed, collected and profit or loss. Collection ring. Six-month billed-vs-expenses chart. "Needs a call today" list with one-tap WhatsApp reminders. Quick actions. Low-stock and backup alerts. |
| **Customers** | Add, edit, search by name, mobile, CNIC, customer code or area. Status: pending install, active, suspended, disconnected. Connection details (PPPoE user, IP, ONU or router serial, area, install date). Balance, overdue and advance credit. History of invoices, payments, complaints and WhatsApp messages. Delete only when there is no history; otherwise disconnect. |
| **Plans & pricing** | Plans with speed (Mbps), monthly price and connection type. Custom price per customer. Hide a plan instead of deleting it when customers use it. Sample starter plans are provided and must be checked against your own rates. |
| **Monthly billing** | One-click monthly run for every active or suspended customer. Preview before creating anything. Safe to repeat: each customer is billed once per month. One-off invoices for installation, shifting, repairs or late fees (multiple lines). Invoice view, print, WhatsApp, void. |
| **Collections** | Record cash, JazzCash, Easypaisa, Raast/IBFT, bank transfer or other, with a transaction ID. Payments match the oldest open invoices first, and any extra becomes advance credit. Today's totals by method for end-of-day reconciliation. Receipt print and WhatsApp. Void a mistaken payment. |
| **Complaints & faults** | Log "no internet", "slow", "billing dispute", "shifting" or "other" tickets. Priority (high for area outages). Assign, start work, resolve with a note, reopen. Acknowledge the customer on WhatsApp. Ticket numbers TKT-000001. |
| **Inventory** | ONUs, routers, fibre drop cable, connectors and so on. Stock in, issue to a customer, low-stock alerts, stock value and per-item history. Negative stock is blocked unless allowed in settings. |
| **Expenses** | Bandwidth/IP transit, fibre and cable, tower rent, electricity and generator, fuel, salaries, repairs, licences and taxes, and more. Month filter and category totals. |
| **Profit & loss** | Monthly billed (revenue), collected, expenses, profit or loss (accrual), and cash flow. 12-month profit line that draws itself in. Month-by-month table. CSV export for the accountant. |
| **WhatsApp** | Overdue queue, all-unpaid queue, area outage notice, editable templates, message log, and optional browser notifications. See the limitation below. |
| **Backup & restore** | Download a JSON backup with checksum. Restore by validating first (structure, duplicates, required fields, record counts, checksum), then either merge or replace (replace requires typing REPLACE). |
| **Settings** | Business profile, PTA licence and NTN (shown on invoices), payment numbers (JazzCash, Easypaisa, Raast, bank), billing day, due days, advance-credit rule, sales-tax rate, WhatsApp country code, theme, and recent activity log. |

Login uses the existing eposwala API (`js/services/auth.js`), with roles Owner, Manager and Collector. Permissions are enforced in the UI and the service layer.

## Billing rules (enforced in the database layer)

- **One transaction per operation.** A run, a payment, a void or a stock move either completes fully or changes nothing.
- **One plan invoice per customer per month.** A unique index on `periodKey` (`customerId|YYYY-MM`) stops double billing, including if the run is repeated or two devices run it.
- **Voiding never erases a number.** Invoice and receipt numbers come from a counter inside the same transaction and stay gap-free. A voided invoice keeps its record and releases its billing month, so that month can be re-billed.
- **A paid invoice cannot be voided directly.** Void its payments first. Voiding a payment takes its amount back off every invoice it paid.
- **Balances are derived, not stored.** Outstanding, overdue and credit come from invoices and payments. Profit & loss comes from invoices, payments and expenses.
- **Due dates.** Invoices are dated on the billing day (default the 1st) and due after the due-days setting (default 10).

## WhatsApp: what it can and cannot do

- Each message **opens WhatsApp** (WhatsApp Web or the app) with the text filled in. **You press Send.** This works from a static web app without any server and needs no WhatsApp Business account.
- Queues let you tap down the list (overdue, all unpaid, one area). Every opened message is logged against the customer.
- Templates are editable under *WhatsApp → Templates* with placeholders such as `{name}`, `{balance}`, `{due}`, `{payment}`, `{ticket}`.
- Numbers are normalised: `0300 1234567` becomes `923001234567` for the `wa.me` link.

**Not possible in a static app:**

- **Automatic sending** and **receiving WhatsApp messages** into the app. That needs the WhatsApp Business Cloud API, a server to hold the access token and receive webhooks, and a Meta-approved business. This is the main piece to add next if you want fully automatic reminders.
- Reading your WhatsApp Web notifications. Browsers do not let a web page read another tab or app.

## Pakistan context used in the design

Public reporting on Pakistani telecom billing, the 2025 PTCL WhatsApp bill-payment launch, and recent fibre-cut outages pointed to these pain points, and the app addresses them:

- **Wrong or disputed bills.** Customers dispute charges, and manual invoicing causes errors. Each invoice shows its lines, the plan, due date and payments applied, and the audit log records changes.
- **Collections through wallets and bank.** JazzCash, Easypaisa, Raast and bank transfer are recorded with a reference, and receipts are printable and shareable.
- **Late payment and suspension.** The overdue queue, reminders and per-customer suspend and reactivate status make it easier to chase payments.
- **Outages and fibre cuts.** Complaints are logged with priority, and one message can be sent per area to tell customers the team is working on it.
- **Cash handling by collectors.** Today's totals by method make end-of-day cash reconciliation simple.

Check the current PTA licence and sales-tax treatment of internet services with your accountant and enter the rate in Settings. The app does not decide the tax rate for you.

## Data and storage

| Where | What |
|---|---|
| IndexedDB `ispdesk_db` | Plans, subscribers, invoices, payments, expenses, inventory, stock moves, complaints, WhatsApp message log, audit log, counters |
| LocalStorage | Settings (`ispdesk.settings`), session (`ispdesk.session`), device preferences (`ispdesk.pref.*`), and the shared device id |

Everything is stored on the device. There is no cloud sync between devices. Use **Backup & Restore** regularly (the dashboard reminds you after 7 days).

**Old POS data.** The previous POS app used the IndexedDB database `disterp_pos`. ISP Desk uses a new database, so existing POS sales are not loaded into it and the old database is left untouched.

**Shared origin.** All apps on `designer-haxxan.github.io` share one origin. ISP Desk uses the namespace `ispdesk` (`APP_ID` in `js/config.js` and `service-worker.js`) so it does not collide with other apps. Change `APP_ID` if you copy this for another business.

## Setup

### 1. Configure

Edit `js/config.js` if the login API or support number differs.

After first sign-in, go to **Settings** and fill in:

- Business name, helpline, office address, PTA licence number and NTN.
- JazzCash, Easypaisa, Raast and bank details. These appear on every invoice and reminder.
- Billing day, due days, sales-tax rate (confirm with your accountant).

Then go to **Plans & pricing**, replace the sample plans with your real rates, and add your customers.

### 2. Run locally

The app needs HTTP (ES modules and service worker). Any static server works, for example:

```bash
python -m http.server 8765
```

Then open http://localhost:8765. Login from localhost works once the eposwala API allows that origin (see CORS below).

### 3. Deploy

GitHub Pages from branch `main`, folder `/ (root)`. `.nojekyll` keeps the files unchanged. HTTPS is required for the service worker.

**CORS:** `https://eposwala.com/api/login` currently allows only its own origin. Other origins need `Access-Control-Allow-Origin` and a preflight that accepts `content-type`.

**Updates.** When any file changes, bump `VERSION` in `service-worker.js`. Installed copies refresh the next time they are opened online. Without a bump, cached files keep being served.

## Backup & restore

- **Export** downloads one JSON file with `format`, `backupVersion`, `schemaVersion`, `createdAt`, `counts`, `checksum`, `settings` and `data`. No passwords or session tokens are included.
- **Import** checks the file before anything changes: format and version, required fields, duplicate IDs, record counts against the header (detects truncation), checksum (detects tampering), and shows what it contains.
- **Merge** adds missing records and updates newer ones (counters keep the higher value). **Replace** erases this device's data first and needs the word REPLACE.

## Known limitations

- Data lives on the device. There is no multi-device sync, so keep backups and avoid running two devices as the main desk.
- No automatic WhatsApp sending or receiving (see above).
- No integration with RADIUS, PPPoE servers or OLTs. Usernames and IPs are recorded by hand.
- The offline session gate is client-side. Anyone with the device and developer tools can read IndexedDB, so use device lock screens.
- Late fees are added as one-off invoices, not automatically. Plan prices are shown on the invoice as entered.
- Cost of inventory is recorded per item and not charged automatically as an expense, to avoid counting it twice. Log supplier bills under Expenses.
