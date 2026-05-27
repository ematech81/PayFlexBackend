# PayFlex Pricing Reference

> **For ops and engineering use only.** Never share internal costs with users.
> All prices are in Nigerian Naira (NGN). Last updated: 2026-05-26.

---

## How pricing works

All pricing logic lives in **`services/pricingService.js`** — the single source of truth.
No controller hardcodes a price. Every transaction stores:

| Field | Meaning |
|---|---|
| `userPaid` | What the user's wallet was debited |
| `providerCost` | What we pay the provider (VTpass or VTU Africa) |
| `providerFee` | Provider's flat transaction fee (included in `providerCost`) |
| `ourMargin` | `userPaid − providerCost` — our gross profit |
| `recipientFee` | Pay-for-someone-else surcharge (part of `ourMargin`) |
| `vtuAfricaCommission` | VTU Africa `comi` field — commission credited to our account |
| `pricingConfigVersion` | 8-char SHA-256 of the config at transaction time |

`pricingConfigVersion` means you can always trace exactly which price config produced a given transaction, even after a price change.

---

## Airtime (VTpass)

User tops up the face value. We buy at a discount from VTpass — the discount is our margin.

| Network | VTpass Discount | Our Markup | User Pays | Our Margin |
|---|---|---|---|---|
| MTN | 3% | 3% | Face value | 3% of amount |
| Airtel | 3.5% | 3.5% | Face value | 3.5% of amount |
| Glo | 3% | 3% | Face value | 3% of amount |
| 9mobile | 3% | 3% | Face value | 3% of amount |

**Pay-for-someone-else surcharge:** +₦20 per transaction (recipient fee).

**Example — MTN ₦1,000 (own number):**
- User pays: ₦1,000
- VTpass cost: ₦970
- Our margin: ₦30

**Example — MTN ₦1,000 (for someone else):**
- User pays: ₦1,020
- VTpass cost: ₦970
- Our margin: ₦50 (₦30 markup + ₦20 recipient fee)

---

## Data (VTpass)

Markup of **2.5%** over the VTpass plan cost, with a **₦20 minimum** margin floor.

| Scenario | VTpass Cost | Markup Applied | User Pays | Our Margin |
|---|---|---|---|---|
| Small bundle (₦300) | ₦300 | 2.5% = ₦7.50 → floored to ₦20 | ₦320 | ₦20 |
| Large bundle (₦5,000) | ₦5,000 | 2.5% = ₦125 | ₦5,125 | ₦125 |

**Pay-for-someone-else surcharge:** +₦20 per transaction.

---

## Cable TV (VTpass)

Cable is always treated as pay-for-someone-else (users pay their own or another decoder).

Markup of **2%** over VTpass cost, with a **₦50 minimum** floor. Convenience fee of **₦30** always applied.

| Bouquet | VTpass Cost | 2% Markup | +₦30 Fee | User Pays | Our Margin |
|---|---|---|---|---|---|
| DSTV Padi (₦2,500) | ₦2,500 | ₦50 | ₦30 | ₦2,580 | ₦80 |
| DSTV Compact (₦9,000) | ₦9,000 | ₦180 | ₦30 | ₦9,210 | ₦210 |
| GOtv Max (₦4,850) | ₦4,850 | ₦97 | ₦30 | ₦4,977 | ₦127 |

---

## Electricity (VTpass)

Same treatment as cable — always pay-for-someone-else.

Markup of **1.5%** over VTpass cost, with a **₦50 minimum** floor. Convenience fee of **₦30** always applied.

| Purchase | VTpass Cost | 1.5% Markup | +₦30 Fee | User Pays | Our Margin |
|---|---|---|---|---|---|
| ₦1,000 prepaid | ₦1,000 | ₦15 → floored to ₦50 | ₦30 | ₦1,080 | ₦80 |
| ₦5,000 prepaid | ₦5,000 | ₦75 | ₦30 | ₦5,105 | ₦105 |
| ₦20,000 prepaid | ₦20,000 | ₦300 | ₦30 | ₦20,330 | ₦330 |

---

## Exam PINs (VTU Africa)

Fixed selling prices. VTU Africa costs are fixed provider rates and are not env-overridable.

| Product | Selling Price | VTU Africa Cost | Our Margin | Product Code |
|---|---|---|---|---|
| WAEC Result Checker PIN | ₦4,500 | ₦4,000 | ₦500 | `waec / 1` |
| NECO Result Checker Token | ₦2,500 | ₦2,200 | ₦300 | `neco / 1` |
| NABTEB Result Checker PIN | ₦1,500 | ₦1,300 | ₦200 | `nabteb / 1` |
| JAMB UTME Registration PIN | ₦7,700 | ₦7,190 | ₦510 | `jamb / 1` |
| JAMB Direct Entry PIN | ₦6,200 | ₦5,700 | ₦500 | `jamb / 2` |

**Pay-for-someone-else surcharge:** +₦50 per transaction (flat, not per PIN).

**Example — 2× WAEC PINs for someone else:**
- User pays: (₦4,500 × 2) + ₦50 = ₦9,050
- VTU Africa cost: ₦4,000 × 2 = ₦8,000
- Our margin: ₦1,050

---

## Betting Wallet Funding (VTU Africa)

VTU Africa charges us a flat ₦20 fee per transaction regardless of amount.
We pass this through to the user plus our own margin.

### Fee tiers

| Amount Range | VTU Fee | Our Margin | Total Service Fee | User Pays |
|---|---|---|---|---|
| ₦500 and above (normal) | ₦20 | ₦10 | ₦30 | amount + ₦30 |
| ₦100–₦499 (micro) | ₦20 | ₦30 | ₦50 | amount + ₦50 |
| Below ₦100 | — | — | — | **Rejected** |

> **Why higher micro margin?** Amounts below ₦500 are disproportionately expensive to process (fixed VTU fee is a larger % of the transaction) and are a common pattern in abuse/test scenarios. The higher fee discourages frivolous micro-transactions.

**Pay-for-someone-else surcharge:** +₦20 per transaction.

### Examples

| Amount | Tier | User Pays | VTU Africa Debit | Our Margin |
|---|---|---|---|---|
| ₦100 | Micro | ₦150 | ₦120 | ₦30 |
| ₦200 | Micro | ₦250 | ₦220 | ₦30 |
| ₦500 | Normal | ₦530 | ₦520 | ₦10 |
| ₦1,000 | Normal | ₦1,030 | ₦1,020 | ₦10 |
| ₦5,000 | Normal | ₦5,030 | ₦5,020 | ₦10 |

---

## Pay-for-Someone-Else fees

Flat surcharge per transaction when the beneficiary is not the paying user.
This is a convenience fee for bill payment — recipients receive services, never Naira.

| Service | Recipient Fee |
|---|---|
| Airtime / Data | ₦20 |
| Cable TV / Electricity | ₦30 (always applied) |
| Exam PINs | ₦50 |
| Betting wallet funding | ₦20 |

---

## VTU Africa commission (`comi`)

VTU Africa credits a small commission per transaction back to our merchant wallet.
This is **additional** to our service fee margin — it's passive income on top.

- Stored per transaction as `vtuAfricaCommission`
- Internal only — **never exposed in user-facing API responses**
- Reported in `/api/admin/revenue/summary` under `totalCommission`
- Commission rates are set by VTU Africa and not configurable on our end

---

## Revenue tracking on transactions

Every transaction document (across all three collections) stores:

```
provider             "vtpass" | "vtu-africa" | "kora-pay"
userPaid             Final amount debited from user wallet
providerCost         Amount paid to provider (includes providerFee)
providerFee          Provider's flat fee component
recipientFee         Pay-for-someone-else component (0 if own use)
ourMargin            userPaid − providerCost
marginType           "markup" | "service_fee" | "mixed" | "unknown"
forSomeoneElse       true if beneficiary ≠ paying user
vtuAfricaCommission  VTU Africa comi field (0 for non-VTU providers)
pricingConfigVersion 8-char config hash at transaction time
```

Pre-pricing-system transactions have `marginType: "unknown"` and numeric fields at `0`. This is expected — do not backfill them.

---

## Changing prices

1. Update the relevant `PRICING_*` env var in your deployment environment.
2. Restart the server — prices load once at startup.
3. The `pricingConfigVersion` will change, stamping all new transactions with the new config hash.
4. Old transactions retain their original config version — prices are locked at creation time.
5. Run `/api/admin/revenue/summary` to verify the new margins are landing correctly.

---

## Admin endpoints

All require `Authorization: Bearer <admin-token>` with `roles: ['admin']`.

| Endpoint | Description |
|---|---|
| `GET /api/admin/revenue/summary` | KPIs for date range: totals, byService, byProvider |
| `GET /api/admin/revenue/daily` | Day-by-day breakdown |
| `GET /api/admin/revenue/monthly` | Month-by-month breakdown (default: last 12 months) |
| `GET /api/admin/revenue/by-service` | Per-service margin, sorted by margin desc |
| `GET /api/admin/revenue/by-provider` | VTpass vs VTU Africa split |
| `GET /api/admin/revenue/top-users` | Top revenue-generating users (`?limit=20`) |
| `GET /api/admin/revenue/pay-for-others` | forSomeoneElse=true transactions only |
| `GET /api/admin/revenue/wallet-float` | Total NGN held in user wallets |

**Query parameters (all date-range endpoints):**
- `from` — ISO 8601 date (default: first of current month)
- `to` — ISO 8601 date (default: now)
