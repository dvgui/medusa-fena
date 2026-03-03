# Fena Payment Plugin for MedusaJS v2

Integrate [Fena](https://fena.co) Open Banking payments into your MedusaJS v2 store. Customers pay directly from their bank account — instant settlement, no card fees.

## Features

- **Open Banking redirect flow** — customer selects their bank and authorizes payment
- **QR code support** — display a QR code for mobile payments
- **Webhook handling** — automatic payment status updates
- **Instant payments** — no separate capture step needed
- **Zero external dependencies** — uses native `fetch`, no SDK required

## Installation

```bash
npm install fena-plugin
```

## Configuration

Add the plugin to your `medusa-config.ts`:

```ts
// medusa-config.ts
import { defineConfig } from "@medusajs/framework/utils"

export default defineConfig({
  // ... other config
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "fena-plugin/providers/fena",
            id: "fena-ob",
            options: {
              terminalId: process.env.FENA_TERMINAL_ID!,
              terminalSecret: process.env.FENA_TERMINAL_SECRET!,
              bankAccountId: process.env.FENA_BANK_ACCOUNT_ID,   // optional — uses default if omitted
              sandbox: process.env.FENA_SANDBOX === "true",       // optional — defaults to false
              redirectUrl: process.env.FENA_REDIRECT_URL,         // optional — overrides Fena dashboard setting
            },
          },
        ],
      },
    },
  ],
})
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FENA_TERMINAL_ID` | ✅ | Integration ID from [Fena Dashboard](https://dashboard.fena.co) → API Keys |
| `FENA_TERMINAL_SECRET` | ✅ | Integration Secret (UUID format) |
| `FENA_BANK_ACCOUNT_ID` | ❌ | Specific bank account ID. Uses your default if omitted. |
| `FENA_SANDBOX` | ❌ | Set to `"true"` for sandbox mode |
| `FENA_REDIRECT_URL` | ❌ | Where to redirect customers after payment |

## Enable in Admin

1. Go to your Medusa Admin → **Settings** → **Regions**
2. Select a region
3. Add **pp_fena_ob** as a payment provider

## Webhook Setup

The plugin exposes a webhook endpoint at:

```
POST https://your-medusa-backend.com/fena/webhooks
```

Configure this URL in your [Fena Dashboard](https://dashboard.fena.co) under your API key's webhook settings.

## How It Works

```
Customer → Checkout → Selects Fena → Redirected to Fena
    → Picks bank → Authorizes in banking app
    → Redirected back to your store
    → Fena sends webhook → Order completes
```

1. **`initiatePayment`** — creates a Fena payment and returns a redirect URL + QR code data
2. Customer is redirected to Fena's payment page
3. Customer selects their bank and authorizes the payment
4. Customer is redirected back to your store with `?payment_id=&status=` query params
5. Fena sends a webhook notification → plugin maps it to Medusa payment actions
6. **`authorizePayment`** — verifies the payment status with Fena's API

---

## Storefront Integration (Next.js Starter)

The following examples show how to integrate Fena into the [MedusaJS Next.js Starter Storefront](https://docs.medusajs.com/resources/nextjs-starter). The storefront uses a `paymentInfoMap` and provider-detection helpers in `@lib/constants` to decide which UI to render for each provider.

### Step 1: Register Fena in Constants

Add Fena to `paymentInfoMap` and create a helper in your storefront's `src/lib/constants.tsx`:

```tsx
// src/lib/constants.tsx

// Add to paymentInfoMap:
export const paymentInfoMap: Record<string, { title: string; icon: React.JSX.Element }> = {
  // ... existing providers (pp_stripe_stripe, pp_paypal_paypal, etc.)
  pp_fena_ob: {
    title: "Pay by Bank (Fena)",
    icon: <CreditCard />,   // or a custom Fena icon
  },
}

// Add the provider-detection helper:
export const isFena = (providerId?: string) => {
  return providerId?.startsWith("pp_fena")
}
```

### Step 2: Handle Payment Session Initiation

In `src/modules/checkout/components/payment/index.tsx`, the `handleSubmit` function already calls `initiatePaymentSession` for non-Stripe providers.

When a user selects Fena and clicks "Continue to review", the storefront calls:

```ts
await initiatePaymentSession(cart, {
  provider_id: "pp_fena_ob",
})
```

This triggers the plugin's `initiatePayment` method, which creates the Fena payment and stores the redirect URL and QR code in the session data. **No changes needed here** — the default storefront flow handles this.

### Step 3: Add Fena Payment Button

In `src/modules/checkout/components/payment-button/index.tsx`, add a Fena case to the provider switch:

```tsx
"use client"

import { isFena, isManual, isStripeLike } from "@lib/constants"
import { placeOrder } from "@lib/data/cart"
import { HttpTypes } from "@medusajs/types"
import { Button } from "@medusajs/ui"
import React, { useState } from "react"
import ErrorMessage from "../error-message"

// Inside the PaymentButton component, add to the switch:

const PaymentButton: React.FC<PaymentButtonProps> = ({
  cart,
  "data-testid": dataTestId,
}) => {
  const notReady =
    !cart ||
    !cart.shipping_address ||
    !cart.billing_address ||
    !cart.email ||
    (cart.shipping_methods?.length ?? 0) < 1

  const paymentSession = cart.payment_collection?.payment_sessions?.[0]

  switch (true) {
    case isStripeLike(paymentSession?.provider_id):
      return (
        <StripePaymentButton
          notReady={notReady}
          cart={cart}
          data-testid={dataTestId}
        />
      )
    // ───── ADD THIS CASE ─────
    case isFena(paymentSession?.provider_id):
      return (
        <FenaPaymentButton
          notReady={notReady}
          cart={cart}
          data-testid={dataTestId}
        />
      )
    // ─────────────────────────
    case isManual(paymentSession?.provider_id):
      return (
        <ManualTestPaymentButton notReady={notReady} data-testid={dataTestId} />
      )
    default:
      return <Button disabled>Select a payment method</Button>
  }
}
```

Then define the `FenaPaymentButton` component in the same file:

```tsx
const FenaPaymentButton = ({
  cart,
  notReady,
  "data-testid": dataTestId,
}: {
  cart: HttpTypes.StoreCart
  notReady: boolean
  "data-testid"?: string
}) => {
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const paymentSession = cart.payment_collection?.payment_sessions?.find(
    (s) => s.provider_id === "pp_fena_ob"
  )

  const paymentLink = paymentSession?.data?.fena_payment_link as
    | string
    | undefined

  const handlePayment = () => {
    if (!paymentLink) {
      setErrorMessage("Payment link not available. Please try again.")
      return
    }

    setSubmitting(true)
    // Redirect to Fena's payment page.
    // The customer will authorize the payment, then Fena redirects
    // back to FENA_REDIRECT_URL (configured in medusa-config.ts).
    window.location.href = paymentLink
  }

  return (
    <>
      <Button
        disabled={notReady || !paymentLink}
        onClick={handlePayment}
        size="large"
        isLoading={submitting}
        data-testid={dataTestId}
      >
        Pay with Fena
      </Button>
      <ErrorMessage
        error={errorMessage}
        data-testid="fena-payment-error-message"
      />
    </>
  )
}
```

### Step 4: Return URL Callback

After the customer completes (or cancels) payment on Fena's page, they are redirected back to your storefront. Create a callback API route to handle this:

```ts
// src/app/api/fena-callback/[cartId]/route.ts

import { placeOrder, retrieveCart } from "@lib/data/cart"
import { NextRequest, NextResponse } from "next/server"

type Params = Promise<{ cartId: string }>

export async function GET(req: NextRequest, { params }: { params: Params }) {
  const { cartId } = await params
  const { origin, searchParams } = req.nextUrl

  const paymentId = searchParams.get("payment_id")
  const status = searchParams.get("status")
  const countryCode = searchParams.get("country_code") || "gb"

  // Retrieve the cart and validate the payment session
  const cart = await retrieveCart(cartId)

  if (!cart) {
    return NextResponse.redirect(`${origin}/${countryCode}`)
  }

  // Verify the payment session belongs to this cart
  const paymentSession = cart.payment_collection?.payment_sessions?.find(
    (s) => s.data?.fena_payment_id === paymentId
  )

  if (!paymentSession) {
    return NextResponse.redirect(
      `${origin}/${countryCode}/cart?step=review&error=payment_not_found`
    )
  }

  // If payment was successful, place the order
  if (status === "paid" || status === "pending") {
    try {
      const order = await placeOrder(cartId)
      return NextResponse.redirect(
        `${origin}/${countryCode}/order/${order.id}/confirmed`
      )
    } catch {
      return NextResponse.redirect(
        `${origin}/${countryCode}/cart?step=review&error=order_failed`
      )
    }
  }

  // Payment was cancelled or rejected
  return NextResponse.redirect(
    `${origin}/${countryCode}/cart?step=review&error=payment_failed`
  )
}
```

Then set your redirect URL to point to this route:

```env
FENA_REDIRECT_URL=https://your-storefront.com/api/fena-callback/{cart_id}?country_code=gb
```

> **Note:** Replace `{cart_id}` with the actual cart ID in your `initiatePayment` flow, or pass it as part of the Fena payment reference.

### Step 5: QR Code Display (Optional)

If you want to show a QR code for mobile payments alongside the redirect button, add this to the payment step or review step:

```tsx
"use client"

import { HttpTypes } from "@medusajs/types"

const FenaQRCode = ({ cart }: { cart: HttpTypes.StoreCart }) => {
  const paymentSession = cart.payment_collection?.payment_sessions?.find(
    (s) => s.provider_id === "pp_fena_ob"
  )

  const qrCodeUrl = paymentSession?.data?.fena_qr_code_data as
    | string
    | undefined

  if (!qrCodeUrl) return null

  return (
    <div className="flex flex-col items-center gap-y-2 py-4">
      <p className="txt-medium text-ui-fg-subtle">
        Or scan to pay with your banking app:
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qrCodeUrl} alt="Scan to pay" width={200} height={200} />
    </div>
  )
}

export default FenaQRCode
```

---

## Payment Session Data Reference

After `initiatePayment`, the payment session `data` object contains:

| Key | Type | Description |
|-----|------|-------------|
| `fena_payment_id` | `string` | Fena's unique payment ID |
| `fena_payment_link` | `string` | Redirect URL for the payment page |
| `fena_qr_code_data` | `string` | URL to QR code PNG image |
| `fena_payment_status` | `string` | Current Fena payment status |
| `fena_reference` | `string` | Payment reference (format: `medusa-{sessionId}`) |
| `currency_code` | `string` | ISO currency code |

## Limitations

- **Refunds** — must be processed manually via the [Fena Dashboard](https://dashboard.fena.co). The Fena API does not expose a refund endpoint for single payments.
- **Cancellation** — Fena doesn't have an explicit cancel endpoint. Payments expire based on their due date.
- **Currency** — Fena currently supports GBP (British Pounds) for Open Banking payments.

## Plugin Structure

```
fena-plugin/
├── src/
│   ├── lib/fena-client/        # Fena API client (internal mini-SDK)
│   │   ├── types.ts            # TypeScript types & enums
│   │   ├── utils.ts            # Error handling utilities
│   │   ├── client.ts           # HTTP client class
│   │   └── index.ts            # Barrel export
│   ├── providers/fena/         # MedusaJS Payment Provider
│   │   ├── service.ts          # AbstractPaymentProvider implementation
│   │   └── index.ts            # Module registration
│   └── api/fena/webhooks/
│       └── route.ts            # Webhook endpoint
└── package.json
```

## Development

```bash
# Install dependencies
npm install

# Build the plugin
npm run build

# Watch mode
npm run dev
```

## API Reference

The internal Fena client can be imported directly if needed:

```ts
import { FenaClient, FENA_DEFAULT_BASE_URL } from "fena-plugin/lib/fena-client"

const client = new FenaClient({
  terminalId: "your-terminal-id",
  terminalSecret: "your-terminal-secret",
  baseUrl: "https://custom-proxy.com", // optional override
})

// Create and process a payment
const response = await client.createAndProcessPayment({
  reference: "order-123",
  amount: "9.50",
  customerEmail: "customer@example.com",
})

console.log(response.result.link)       // redirect URL
console.log(response.result.qrCodeData) // QR code image URL

// Check payment status
const payment = await client.getPayment("payment-id")
console.log(payment.status) // "paid" | "sent" | "pending" | ...
```

## License

MIT
