"use strict";
/**
 * Fena Payment Provider — MedusaJS v2 Module Provider
 *
 * Integrates the Fena Open Banking payment gateway with MedusaJS.
 *
 * Payment flow (redirect-based, mirrors WooCommerce plugin):
 * 1. initiatePayment → calls Fena create-and-process → returns payment link
 * 2. Customer redirected to Fena → selects bank → authorizes in banking app
 * 3. Customer redirected back with ?order_id=&payment_id=&status=
 * 4. Fena sends webhook → getWebhookActionAndData maps to Medusa actions
 * 5. authorizePayment → confirms via Fena API status check
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FENA_PROVIDER_ID = void 0;
const utils_1 = require("@medusajs/framework/utils");
const fena_client_1 = require("../../lib/fena-client");
// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────
/**
 * Resolve a key from an Awilix-style container without throwing on miss.
 * Awilix `cradle` proxies throw `AwilixResolutionError` for unregistered
 * keys, so a plain `container[key]` access can blow up the caller. We try
 * a list of candidate keys and return the first registered value, or
 * `undefined` if none resolve. Callers must still null-check the result.
 */
const safeResolve = (container, keys) => {
    for (const key of keys) {
        try {
            const value = container[key];
            if (value != null)
                return value;
        }
        catch {
            // unregistered key — try next
        }
    }
    return undefined;
};
/**
 * Safely extracts a string from payment session `data` by key.
 * Returns `undefined` if the key doesn't exist or isn't a string.
 */
function getDataString(data, key) {
    if (!data)
        return undefined;
    const value = data[key];
    return typeof value === "string" ? value : undefined;
}
/**
 * Format a Medusa address into a single readable string for Fena notes.
 */
function formatAddress(address) {
    if (!address)
        return "";
    const parts = [
        address.first_name || address.last_name ? `${address.first_name || ""} ${address.last_name || ""}`.trim() : null,
        address.company,
        address.address_1,
        address.address_2,
        address.city,
        address.province,
        address.postal_code,
        address.country_code?.toUpperCase(),
        address.phone
    ].filter(Boolean);
    return parts.join(", ");
}
// ────────────────────────────────────────────────────────
// Provider identifier
// ────────────────────────────────────────────────────────
exports.FENA_PROVIDER_ID = "fena-ob";
// ────────────────────────────────────────────────────────
// Provider Service
// ────────────────────────────────────────────────────────
/** Sentinel slug key for the top-level (default) credential set. */
const DEFAULT_BRAND_SLUG = "__default__";
class FenaPaymentProviderService extends utils_1.AbstractPaymentProvider {
    constructor(container, options) {
        super(container, options);
        this.logger_ = container.logger;
        this.options_ = options;
        this.container_ = container;
        // Default merchant (UK + TG today). Always present so a brand-less
        // request — or a brand the operator hasn't onboarded yet — still
        // routes to a working Fena terminal.
        const defaultClient = new fena_client_1.FenaClient({
            terminalId: options.terminalId,
            terminalSecret: options.terminalSecret,
        });
        this.client_ = defaultClient;
        this.brandContexts_ = new Map();
        // Per-brand overrides. Each entry inherits non-credential fields
        // (paymentMethod, webhookUrl) from the top-level options so the
        // brand config only carries the bits that actually differ.
        const overrides = options.brandCredentials ?? {};
        for (const [slug, creds] of Object.entries(overrides)) {
            if (!creds.terminalId || !creds.terminalSecret) {
                this.logger_.warn(`Fena: brandCredentials[${slug}] missing terminalId/terminalSecret — skipping override (slug will fall through to default credentials)`);
                continue;
            }
            this.brandContexts_.set(slug, {
                client: new fena_client_1.FenaClient({
                    terminalId: creds.terminalId,
                    terminalSecret: creds.terminalSecret,
                }),
                opts: {
                    ...options,
                    terminalId: creds.terminalId,
                    terminalSecret: creds.terminalSecret,
                    bankAccountId: creds.bankAccountId ?? options.bankAccountId,
                    storeName: creds.storeName ?? options.storeName,
                    redirectUrl: creds.redirectUrl ?? options.redirectUrl,
                },
                slug,
            });
        }
        // Default goes LAST in iteration order so webhook reverse-lookup
        // gives brand merchants first dibs on a Fena payment id.
        this.brandContexts_.set(DEFAULT_BRAND_SLUG, {
            client: defaultClient,
            opts: options,
            slug: DEFAULT_BRAND_SLUG,
        });
        const overrideCount = this.brandContexts_.size - 1;
        this.logger_.info(overrideCount > 0
            ? `Fena Payment Provider initialized with ${overrideCount} brand override(s): ${[...this.brandContexts_.keys()].filter((s) => s !== DEFAULT_BRAND_SLUG).join(", ")}`
            : "Fena Payment Provider initialized (single-tenant)");
    }
    // ──────────────────────────────────────────────────────
    // Brand resolution helpers
    // ──────────────────────────────────────────────────────
    /**
     * Resolve which merchant (BrandContext) should handle a storefront-
     * initiated payment flow. Tries, in order:
     *   1. Explicit `brand_slug` stamped into input.data (we stamp this in
     *      initiatePayment so authorize/capture/etc. avoid the cart lookup).
     *   2. `session_id`:
     *        - `cart_*` → cart.metadata.storefront via the cart module.
     *        - `payses_*` → walk payment_session → payment_collection →
     *          cart via query.graph (Medusa's PaymentModule passes the
     *          payment_session id here, not the cart id).
     *   3. Default (top-level credentials).
     *
     * Never throws — falls through to the default merchant on any failure.
     */
    async resolveContext(input) {
        const explicit = typeof input.data?.brand_slug === "string"
            ? input.data.brand_slug
            : undefined;
        if (explicit && this.brandContexts_.has(explicit)) {
            return this.brandContexts_.get(explicit);
        }
        const sessionId = typeof input.data?.session_id === "string"
            ? input.data.session_id
            : undefined;
        if (!sessionId) {
            return this.brandContexts_.get(DEFAULT_BRAND_SLUG);
        }
        try {
            const slug = sessionId.startsWith("cart_")
                ? await this.resolveStorefrontFromCartId(sessionId)
                : sessionId.startsWith("payses_")
                    ? await this.resolveStorefrontFromPaymentSessionId(sessionId)
                    : undefined;
            if (slug && this.brandContexts_.has(slug)) {
                return this.brandContexts_.get(slug);
            }
        }
        catch (err) {
            this.logger_.warn(`Fena: brand-resolve via ${sessionId} failed — ${(0, fena_client_1.getErrorMessage)(err)}; falling through to default merchant`);
        }
        return this.brandContexts_.get(DEFAULT_BRAND_SLUG);
    }
    /** Cart id (cart_*) → cart.metadata.storefront. Returns undefined if
     *  the cart isn't found, the cart module isn't registered in the
     *  current container scope, or the storefront slug is missing. */
    async resolveStorefrontFromCartId(cartId) {
        const cartModule = safeResolve(this.container_, [
            utils_1.Modules.CART,
            "cartModuleService",
            "cartService",
        ]);
        if (!cartModule?.retrieveCart)
            return undefined;
        const cart = await cartModule.retrieveCart(cartId, {
            select: ["id", "metadata"],
        });
        const meta = cart?.metadata;
        return typeof meta?.storefront === "string"
            ? meta.storefront
            : undefined;
    }
    /** payment_session id (payses_*) → payment_collection → cart.metadata.
     *  Uses query.graph so we don't need the payment / cart modules to be
     *  injected into the provider scope (they're not in v2). */
    async resolveStorefrontFromPaymentSessionId(sessionId) {
        const query = safeResolve(this.container_, [
            "query",
            "__query__",
            "remoteQuery",
        ]);
        if (!query?.graph)
            return undefined;
        const { data } = await query.graph({
            entity: "payment_session",
            fields: ["id", "payment_collection.cart.id", "payment_collection.cart.metadata"],
            filters: { id: sessionId },
        });
        const row = data[0];
        const meta = row?.payment_collection?.cart?.metadata;
        return typeof meta?.storefront === "string"
            ? meta.storefront
            : undefined;
    }
    /**
     * Resolve the merchant that owns a specific Fena payment id by trying
     * each brand client. Used by the webhook handler (where the inbound
     * payload tells us a payment id but not which merchant it belongs to)
     * and any other code path that has a Fena id but no cart/session.
     *
     * Returns the first context whose client successfully retrieves the
     * payment, plus the fetched payment object so callers don't re-fetch.
     * Returns null only if NO merchant recognises the id — typically
     * because the webhook is for a payment from a Fena terminal we don't
     * have configured here (mis-routed dashboard config).
     */
    async resolveContextByFenaId(fenaPaymentId) {
        // Try single payment on each client
        for (const ctx of this.brandContexts_.values()) {
            try {
                const payment = await ctx.client.getPayment(fenaPaymentId);
                if (payment) {
                    return { ctx, payment, kind: "single" };
                }
            }
            catch {
                // Try next client (likely 404 from a non-owner merchant)
            }
        }
        // Try recurring payment on each client
        for (const ctx of this.brandContexts_.values()) {
            try {
                const payment = await ctx.client.getRecurringPayment(fenaPaymentId);
                if (payment) {
                    return { ctx, payment, kind: "recurring" };
                }
            }
            catch {
                // Try next client
            }
        }
        return null;
    }
    // ──────────────────────────────────────────────────────
    // initiatePayment
    // ──────────────────────────────────────────────────────
    /**
     * Creates a payment with Fena and returns the payment link.
     * The storefront should redirect the customer to this link, or
     * display it as a QR code.
     */
    async initiatePayment(input) {
        const { amount, currency_code, context } = input;
        try {
            // Passive sessions record an already-cleared bank-side debit
            // (e.g. cycle N of a standing order whose payment_made webhook
            // we just received). No new Fena charge needed — return a stub
            // session that references the existing fena_payment_id so the
            // subsequent authorizePayment passive-branch can short-circuit
            // straight to status=captured.
            if (input.data?.is_passive) {
                const existingFenaId = getDataString(input.data, "fena_payment_id") ||
                    getDataString(input.data, "fena_recurring_id");
                if (!existingFenaId) {
                    throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Fena passive session requires fena_payment_id in input.data");
                }
                this.logger_.info(`Fena: passive session (no new payment created) — referencing existing ${existingFenaId}`);
                return {
                    id: existingFenaId,
                    data: {
                        ...input.data,
                        fena_payment_id: existingFenaId,
                        is_passive: true,
                        currency_code,
                    },
                };
            }
            // Resolve which merchant set to use for this storefront's flow.
            // Per-brand routing keys off cart.metadata.storefront (set by the
            // storefront on cart create); we stamp the resolved slug into
            // the returned session data so authorize/capture/etc. avoid the
            // cart lookup on every subsequent call.
            const { client, opts, slug: brandSlug } = await this.resolveContext(input);
            const isRecurring = !!input.data?.is_recurring;
            const sessionId = getDataString(input.data, "session_id") ?? `cart_${Date.now()}`;
            const reference = sessionId.replace(/[^a-z0-9]/gi, "").slice(-12);
            const formattedAmount = Number(amount).toFixed(2);
            // Extract customer info: context.customer (logged-in) or input.data (guest)
            let customerEmail = context?.customer?.email || input.data?.email;
            const customerFirstName = context?.customer?.first_name || input.data?.first_name;
            const customerLastName = context?.customer?.last_name || input.data?.last_name;
            const customerNameFromData = input.data?.customer_name || input.data?.name;
            // Secondary fallback: none. We strictly rely on data passed from the storefront/workflow.
            // (Note: cross-module queries are restricted in v2 providers)
            if (!customerEmail) {
                this.logger_.warn(`Fena: No customer email provided for session: ${sessionId}`);
            }
            const customerName = (customerFirstName
                ? `${customerFirstName} ${customerLastName || ""}`.trim()
                : customerNameFromData);
            this.logger_.info(`Fena Debug — final customerEmail: ${customerEmail || "N/A"}, customerName: ${customerName || "N/A"}`);
            this.logger_.info(`Fena: Creating ${isRecurring ? "recurring " : ""}payment for ${sessionId} — Email: ${customerEmail || "N/A"}, Name: ${customerName || "N/A"}`);
            if (isRecurring) {
                // Determine frequency and period for recurring date calculation
                const frequency = input.data?.frequency || fena_client_1.FenaRecurringPaymentFrequency.OneMonth;
                // Calculate first standing order debit date = 1 cycle from now
                // (customer pays month 1 via initialPaymentAmount, standing order starts month 2)
                const startDate = new Date();
                switch (frequency) {
                    case fena_client_1.FenaRecurringPaymentFrequency.OneWeek:
                        startDate.setDate(startDate.getDate() + 7);
                        break;
                    case fena_client_1.FenaRecurringPaymentFrequency.OneMonth:
                        startDate.setMonth(startDate.getMonth() + 1);
                        break;
                    case fena_client_1.FenaRecurringPaymentFrequency.ThreeMonths:
                        startDate.setMonth(startDate.getMonth() + 3);
                        break;
                    case fena_client_1.FenaRecurringPaymentFrequency.OneYear:
                        startDate.setFullYear(startDate.getFullYear() + 1);
                        break;
                    default:
                        startDate.setMonth(startDate.getMonth() + 1);
                }
                // Fena requires the date to be a working day AND at least 6 working days out.
                // If it falls on a weekend, advance to Monday.
                const dayOfWeek = startDate.getDay();
                if (dayOfWeek === 0)
                    startDate.setDate(startDate.getDate() + 1); // Sunday → Monday
                if (dayOfWeek === 6)
                    startDate.setDate(startDate.getDate() + 2); // Saturday → Monday
                // Ensure at least 6 working days from now
                const minDate = new Date();
                let workDays = 0;
                while (workDays < 6) {
                    minDate.setDate(minDate.getDate() + 1);
                    const d = minDate.getDay();
                    if (d !== 0 && d !== 6)
                        workDays++;
                }
                if (startDate < minDate) {
                    startDate.setTime(minDate.getTime());
                }
                const shippingAddress = formatAddress(input.data?.shipping_address);
                const billingAddress = formatAddress(input.data?.billing_address);
                const response = await client.createAndProcessRecurringPayment({
                    reference,
                    recurringAmount: formattedAmount,
                    recurringPaymentDate: startDate.toISOString(),
                    numberOfPayments: 0, // Indefinite by default
                    frequency,
                    initialPaymentAmount: formattedAmount, // CHARGE IMMEDIATELY
                    bankAccount: opts.bankAccountId,
                    customerName: customerName || "Customer",
                    customerEmail: customerEmail || "unknown@example.com",
                });
                const payment = response.result;
                // Attach notes AFTER creation — create-and-process doesn't persist notes
                try {
                    await client.attachRecurringPaymentNote(payment.id, {
                        text: `medusa_session:${sessionId}`,
                        visibility: "restricted",
                    });
                    if (shippingAddress) {
                        await client.attachRecurringPaymentNote(payment.id, {
                            text: `Shipping: ${shippingAddress}`,
                            visibility: "restricted",
                        });
                    }
                    if (billingAddress) {
                        await client.attachRecurringPaymentNote(payment.id, {
                            text: `Billing: ${billingAddress}`,
                            visibility: "restricted",
                        });
                    }
                }
                catch (noteErr) {
                    this.logger_.warn(`Fena: Failed to attach notes to recurring ${payment.id}: ${(0, fena_client_1.getErrorMessage)(noteErr)}`);
                }
                return {
                    id: payment.id,
                    data: {
                        ...input.data,
                        fena_payment_id: payment.id,
                        fena_recurring_id: payment.id,
                        fena_payment_link: payment.link,
                        fena_qr_code_data: payment.qrCodeData,
                        fena_payment_status: payment.status,
                        fena_reference: reference,
                        is_recurring: true,
                        currency_code,
                        session_id: sessionId,
                        brand_slug: brandSlug,
                    },
                };
            }
            const shippingAddress = formatAddress(input.data?.shipping_address);
            const billingAddress = formatAddress(input.data?.billing_address);
            const notes = [];
            // Restricted (merchant-only) note carrying the Medusa session id so
            // webhooks can route back to the right payment_session. Restricted
            // visibility means the customer never sees this in the bank app.
            // Mirrors the pattern recurring payments already use.
            notes.push({ text: `medusa_session:${sessionId}`, visibility: "restricted" });
            if (shippingAddress)
                notes.push({ text: `Shipping: ${shippingAddress}`, visibility: "restricted" });
            if (billingAddress)
                notes.push({ text: `Billing: ${billingAddress}`, visibility: "restricted" });
            // Customer-facing description shown on the Fena page + bank app.
            // Generic by default; per-brand storeName overrides the default
            // so BUYELORA customers see "BUYELORA order — …" etc. The
            // traceable session id lives in the restricted note above, not
            // in the description.
            const storeName = opts.storeName?.trim();
            const description = storeName
                ? `${storeName} order — ref ${reference}`
                : `Order — ref ${reference}`;
            // Standard Single Payment
            const response = await client.createAndProcessPayment({
                reference,
                amount: formattedAmount,
                bankAccount: opts.bankAccountId,
                paymentMethod: opts.paymentMethod || fena_client_1.FenaPaymentMethod.FenaOB,
                customerName,
                customerEmail,
                customRedirectUrl: opts.redirectUrl
                    ? opts.redirectUrl.replace("{cart_id}", sessionId)
                    : undefined,
                description,
                notes,
            });
            const payment = response.result;
            this.logger_.info(`Fena: Payment created — ID: ${payment.id}, Link: ${payment.link} (brand=${brandSlug})`);
            return {
                id: payment.id,
                data: {
                    ...input.data,
                    fena_payment_id: payment.id,
                    fena_payment_link: payment.link,
                    fena_qr_code_data: payment.qrCodeData,
                    fena_payment_status: payment.status,
                    fena_reference: reference,
                    currency_code,
                    brand_slug: brandSlug,
                },
            };
        }
        catch (error) {
            const msg = (0, fena_client_1.getErrorMessage)(error);
            this.logger_.error(`Fena: initiatePayment failed — ${msg}`);
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, `Failed to initiate Fena payment: ${msg}`);
        }
    }
    // ──────────────────────────────────────────────────────
    // authorizePayment
    // ──────────────────────────────────────────────────────
    /**
     * Checks the payment status with Fena to confirm authorization.
     * Called after customer returns from the Fena redirect.
     */
    async authorizePayment(input) {
        const { data, context } = input;
        const fenaPaymentId = getDataString(data, "fena_payment_id") || getDataString(data, "fena_recurring_id");
        if (!fenaPaymentId) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Fena payment ID is required for authorization");
        }
        // Resolve which merchant client to use. The brand_slug stamped
        // during initiatePayment is the fast path; missing it (e.g. legacy
        // sessions created before per-brand routing) falls through to the
        // default client which is still correct for the single-tenant era.
        const { client } = await this.resolveContext(input);
        try {
            // Handle off-session renewals or passive records
            const isPassive = input.data?.is_passive || input.context?.is_passive;
            const isOffSession = input.data?.off_session || input.context?.off_session;
            if (isPassive || isOffSession) {
                this.logger_.info(`Fena: authorizePayment (${isPassive ? "passive" : "off-session"}) — confirming context ${fenaPaymentId}`);
                if (isPassive) {
                    return {
                        data: {
                            ...input.data,
                            fena_payment_status: "paid",
                        },
                        status: "captured",
                    };
                }
                // For standing orders, we just check if it's still active.
                // The actual money capture will happen via webhook when the bank pushes.
                const payment = await this.getPaymentOrRecurring(fenaPaymentId, client);
                const status = this.mapFenaStatusToMedusa(payment.status);
                return {
                    data: {
                        ...input.data,
                        fena_payment_status: payment.status,
                    },
                    status,
                };
            }
            const payment = await this.getPaymentOrRecurring(fenaPaymentId, client);
            // For recurring payments, Fena leaves the parent `status` at "sent" even after
            // the initial charge has cleared at the bank — the truth lives in
            // `initialPayment.status`. Treat a paid initial charge as authoritative so the
            // Medusa session can authorize on first-signup. Singles don't have this field,
            // so the optional chain is a no-op for the single-payment path.
            const initialPaidOnRecurring = payment.initialPayment?.status === "paid";
            const effectiveStatus = initialPaidOnRecurring ? "paid" : payment.status;
            const fenaStatus = effectiveStatus.toLowerCase();
            const confirmedStatuses = ["paid", "active", "payment-made", "payment-confirmed"];
            const isConfirmed = confirmedStatuses.includes(fenaStatus);
            const isSent = fenaStatus === "sent" || fenaStatus === fena_client_1.FenaPaymentStatus.Sent;
            this.logger_.info(`[v2.5] Fena: authorizePayment — ID: ${fenaPaymentId}, Fena status: ${payment.status}, initialPaid: ${initialPaidOnRecurring}, confirmed: ${isConfirmed}, isSent: ${isSent}`);
            return {
                data: {
                    ...input.data,
                    fena_payment_status: payment.status,
                },
                status: (isConfirmed ? "authorized" : "pending"),
            };
        }
        catch (error) {
            const msg = (0, fena_client_1.getErrorMessage)(error);
            this.logger_.error(`Fena: authorizePayment failed — ${msg}`);
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, `Failed to authorize Fena payment: ${msg}`);
        }
    }
    // ──────────────────────────────────────────────────────
    // capturePayment
    // ──────────────────────────────────────────────────────
    /**
     * Fena Open Banking payments are instant — "capture" happens automatically
     * when the customer authorizes the payment in their banking app.
     * We just verify the status here.
     */
    async capturePayment(input) {
        const fenaPaymentId = getDataString(input.data, "fena_payment_id") || getDataString(input.data, "fena_recurring_id");
        if (!fenaPaymentId) {
            return { data: input.data };
        }
        const { client } = await this.resolveContext(input);
        try {
            const payment = await this.getPaymentOrRecurring(fenaPaymentId, client);
            // Accept recurring.initialPayment.status === "paid" as capture confirmation —
            // same reasoning as authorizePayment (Fena leaves the recurring parent at "sent"
            // after the initial charge clears). Singles don't have initialPayment, so this
            // is a strict addition that never fires on the single-payment path.
            const initialPaidOnRecurring = payment.initialPayment?.status === "paid";
            if (initialPaidOnRecurring ||
                payment.status === fena_client_1.FenaPaymentStatus.Paid ||
                payment.status === "active" ||
                payment.status === "payment-made") {
                this.logger_.info(`Fena: Payment ${fenaPaymentId} confirmed as captured/active (initialPaid: ${initialPaidOnRecurring})`);
                return {
                    data: {
                        ...input.data,
                        fena_payment_status: payment.status,
                    },
                };
            }
            // Payment NOT confirmed by the bank yet — throw so Medusa does NOT
            // mark this as captured. The event-bus will retry the subscriber,
            // and when Fena sends the "paid" webhook, PaymentActions.SUCCESSFUL
            // will handle the capture automatically.
            const msg = `[v2.5] Fena: capturePayment — payment ${fenaPaymentId} status is "${payment.status}", not "paid" yet. Capture will be retried.`;
            this.logger_.warn(msg);
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.PAYMENT_REQUIRES_MORE_ERROR, msg);
        }
        catch (error) {
            // Re-throw intentional MedusaErrors (robust check for cross-module boundary issues)
            const isMedusaError = error instanceof utils_1.MedusaError ||
                error?.name === "MedusaError" ||
                error?.constructor?.name === "MedusaError";
            if (isMedusaError) {
                throw error;
            }
            this.logger_.error(`[v2.5] Fena: capturePayment failed — ${(0, fena_client_1.getErrorMessage)(error)}`);
            // Don't return success data if we failed – throw something to stop Medusa
            throw error;
        }
    }
    // ──────────────────────────────────────────────────────
    // cancelPayment
    // ──────────────────────────────────────────────────────
    /**
     * Cancels a payment. Fena's API doesn't have an explicit cancel endpoint
     * for single payments — we simply return the current data. The payment
     * will expire based on its due date.
     */
    async cancelPayment(input) {
        this.logger_.info(`Fena: cancelPayment — ID: ${getDataString(input.data, "fena_payment_id") ?? "unknown"}`);
        return {
            data: {
                ...input.data,
                fena_payment_status: fena_client_1.FenaPaymentStatus.Cancelled,
            },
        };
    }
    // ──────────────────────────────────────────────────────
    // deletePayment
    // ──────────────────────────────────────────────────────
    /**
     * Deletes a payment session. Called when a customer changes their
     * payment method during checkout.
     */
    async deletePayment(input) {
        this.logger_.info(`Fena: deletePayment — ID: ${getDataString(input.data, "fena_payment_id") ?? "unknown"}`);
        return { data: input.data };
    }
    // ──────────────────────────────────────────────────────
    // refundPayment
    // ──────────────────────────────────────────────────────
    /**
     * Refunds are handled through the Fena dashboard.
     * The API doesn't expose a direct refund endpoint for single payments.
     * We log the request and return the current data.
     */
    async refundPayment(input) {
        this.logger_.warn(`Fena: refundPayment — refunds must be processed via the Fena dashboard. Payment ID: ${getDataString(input.data, "fena_payment_id") ?? "unknown"}, Amount: ${input.amount}`);
        return {
            data: {
                ...input.data,
                refund_note: "Refund must be processed manually via the Fena merchant dashboard",
            },
        };
    }
    // ──────────────────────────────────────────────────────
    // retrievePayment
    // ──────────────────────────────────────────────────────
    /**
     * Retrieves payment details from Fena.
     */
    async retrievePayment(input) {
        const fenaPaymentId = getDataString(input.data, "fena_payment_id");
        if (!fenaPaymentId) {
            return { data: input.data };
        }
        const { client } = await this.resolveContext(input);
        try {
            const payment = await client.getPayment(fenaPaymentId);
            return {
                data: {
                    ...input.data,
                    fena_payment_id: payment.id,
                    fena_payment_status: payment.status,
                    fena_reference: payment.reference,
                    amount: payment.amount,
                    currency: payment.currency,
                },
            };
        }
        catch (error) {
            this.logger_.error(`Fena: retrievePayment failed — ${(0, fena_client_1.getErrorMessage)(error)}`);
            return { data: input.data };
        }
    }
    // ──────────────────────────────────────────────────────
    // updatePayment
    // ──────────────────────────────────────────────────────
    /**
     * Updates a payment session. For Fena, we don't update the external payment
     * — we just store the updated data. A new Fena payment will be created
     * if the amount changes significantly.
     */
    async updatePayment(input) {
        const { amount, currency_code } = input;
        this.logger_.info(`Fena: updatePayment — ID: ${getDataString(input.data, "fena_payment_id") ?? "unknown"}, amount: ${amount}`);
        // Medusa calls updatePayment for status-only changes (e.g.
        // "canceled") and during createPaymentSession reconciliation,
        // both of which omit amount/currency_code. Don't overwrite the
        // existing data with undefined — the entity's amount column is
        // NOT NULL and would otherwise throw.
        return {
            data: {
                ...input.data,
                ...(amount !== undefined ? { amount: amount.toString() } : {}),
                ...(currency_code !== undefined ? { currency_code } : {}),
            },
        };
    }
    // ──────────────────────────────────────────────────────
    // getPaymentStatus
    // ──────────────────────────────────────────────────────
    /**
     * Checks the current payment status via the Fena API.
     */
    async getPaymentStatus(input) {
        const fenaPaymentId = getDataString(input.data, "fena_payment_id");
        if (!fenaPaymentId) {
            return { status: "pending" };
        }
        const { client } = await this.resolveContext(input);
        try {
            const payment = await client.getPayment(fenaPaymentId);
            return { status: this.mapFenaStatusToMedusa(payment.status) };
        }
        catch (error) {
            this.logger_.error(`Fena: getPaymentStatus failed — ${(0, fena_client_1.getErrorMessage)(error)}`);
            return { status: "pending" };
        }
    }
    // ──────────────────────────────────────────────────────
    // getWebhookActionAndData
    // ──────────────────────────────────────────────────────
    /**
     * Processes incoming Fena webhook notifications.
     * Maps Fena payment statuses to Medusa payment actions.
     */
    async getWebhookActionAndData(payload) {
        try {
            const { data } = payload;
            // Validate incoming webhook data shape
            const webhookData = this.parseFenaWebhookData(data);
            if (!webhookData) {
                this.logger_.warn("Fena webhook: Missing or invalid payment data");
                return {
                    action: utils_1.PaymentActions.NOT_SUPPORTED,
                    data: {
                        session_id: "",
                        amount: new utils_1.BigNumber(0),
                    },
                };
            }
            const { id: fenaPaymentId, status: webhookStatus, amount, reference } = webhookData;
            this.logger_.info(`Fena webhook: Payment ${fenaPaymentId} — status: ${webhookStatus}, ref: ${reference}`);
            // The reference is only 12 chars (truncated). We need the full Medusa session ID.
            // We encoded it in the payment description as: [medusa_session:payses_...]
            // Call Fena API to get the full payment details and extract the session ID.
            let sessionId = "";
            // Use the authentic status from the API instead of trusting the webhook payload
            let authenticStatus = webhookStatus;
            // ── Recurring-payment webhook events ──────────────────────
            // Medusa's process-payment workflow requires a pre-existing
            // payment session, which doesn't exist for standing-order
            // renewals. We handle subscription side-effects here and
            // ALWAYS return NOT_SUPPORTED so Medusa's built-in flow
            // never runs (which would crash). Single-payment webhooks
            // are completely unaffected — they skip this block.
            const isRecurringEvent = webhookData.eventScope === "recurring-payments";
            if (isRecurringEvent) {
                this.logger_.info(`Fena webhook: recurring event "${webhookData.eventName}" for ${fenaPaymentId}`);
                // Handle subscription side-effects (safe — wrapped in try/catch)
                try {
                    await this.handleRecurringSubscriptionEvent(fenaPaymentId, webhookData.eventName || "", webhookData.status);
                }
                catch (err) {
                    this.logger_.error(`Fena webhook: subscription handler error — ${err.message}`);
                }
                return {
                    action: utils_1.PaymentActions.NOT_SUPPORTED,
                    data: {
                        session_id: "",
                        amount: new utils_1.BigNumber(amount || 0),
                    },
                };
            }
            // Webhook payloads don't carry the merchant integration id, so
            // we discover the owning brand by asking each configured client
            // in turn. The first one to return a payment owns the id; the
            // rest 404 cheaply. Result is cached in `resolvedByFenaId` and
            // reused for any later API call against this payment in this
            // handler invocation.
            const resolvedByFenaId = await this.resolveContextByFenaId(fenaPaymentId);
            const webhookClient = resolvedByFenaId?.ctx.client ?? this.client_;
            if (resolvedByFenaId) {
                this.logger_.info(`Fena webhook: payment ${fenaPaymentId} owned by brand=${resolvedByFenaId.ctx.slug}`);
            }
            else {
                this.logger_.warn(`Fena webhook: no configured merchant recognises payment ${fenaPaymentId} — proceeding with default client (may 404)`);
            }
            try {
                // Try Single Payment first
                try {
                    const payment = resolvedByFenaId?.kind === "single"
                        ? resolvedByFenaId.payment
                        : await webhookClient.getPayment(fenaPaymentId);
                    authenticStatus = payment.status;
                    // Prefer the restricted `medusa_session:` note (new
                    // payments). Fall back to the legacy description regex
                    // for in-flight payments created before the cleanup.
                    const noteSession = payment.notes?.find?.((n) => typeof n?.text === "string" &&
                        n.text.startsWith("medusa_session:"));
                    if (noteSession) {
                        sessionId = String(noteSession.text).slice("medusa_session:".length);
                        this.logger_.info(`Fena webhook: recovered session_id from note: ${sessionId}`);
                    }
                    else {
                        const descMatch = payment.description?.match(/\[medusa_session:([^\]]+)\]/);
                        if (descMatch) {
                            sessionId = descMatch[1];
                            this.logger_.info(`Fena webhook: recovered session_id from description (legacy): ${sessionId}`);
                        }
                    }
                }
                catch (e) {
                    // Try Recurring Payment
                    const recurring = resolvedByFenaId?.kind === "recurring"
                        ? resolvedByFenaId.payment
                        : await webhookClient.getRecurringPayment(fenaPaymentId);
                    authenticStatus = recurring.status;
                    // Search in notes for medusa_session (stored as { text: "medusa_session:xxx" })
                    const sessionNote = recurring.transactions?.[0]?.notes?.find((n) => n.text?.startsWith("medusa_session:")) ||
                        recurring.notes?.find((n) => n.text?.startsWith("medusa_session:"));
                    if (sessionNote) {
                        const match = sessionNote.text.match(/medusa_session:(.+)/);
                        sessionId = match?.[1] || "";
                        this.logger_.info(`Fena webhook: recovered session_id from recurring notes: ${sessionId}`);
                    }
                }
                if (!sessionId) {
                    // Initial-charge of a new subscription fires on a Fena-auto-created
                    // child single-payment that we can't tag at creation time (the recurring
                    // endpoint doesn't return the child's id in any response). Reverse-lookup
                    // Medusa's pending Fena sessions by fena_reference + amount as a safety
                    // net. Only used when the description/note tag is missing, so singles
                    // (which always carry the tag) never reach this code path.
                    //
                    // The matching session is always brand-new at this point (seconds-to-minutes
                    // old, freshly created during the customer's checkout), so sorting pending
                    // sessions by created_at DESC puts our target at the top of the result set.
                    // A small take value is enough — we just need to see the newest first.
                    try {
                        const paymentSessionService = this.container_["paymentSessionService"];
                        if (!paymentSessionService) {
                            throw new Error("paymentSessionService not available in provider container");
                        }
                        const pendingSessions = await paymentSessionService.list({ status: "pending" }, { take: 50, order: { created_at: "DESC" } });
                        const webhookAmount = Number(amount || 0);
                        const match = pendingSessions.find((s) => s.provider_id?.toLowerCase().includes("fena") &&
                            s.data?.fena_reference === reference &&
                            Number(s.amount) === webhookAmount);
                        if (match?.id) {
                            sessionId = match.id;
                            this.logger_.info(`Fena webhook: recovered session_id via reverse lookup (fena_reference=${reference}, amount=${webhookAmount}): ${sessionId} (scanned ${pendingSessions.length} pending)`);
                        }
                        else {
                            this.logger_.warn(`Fena webhook: reverse lookup found no match (ref=${reference}, amount=${webhookAmount}, scanned ${pendingSessions.length} pending)`);
                        }
                    }
                    catch (lookupErr) {
                        this.logger_.warn(`Fena webhook: reverse lookup failed — ${lookupErr.message}`);
                    }
                }
                if (!sessionId) {
                    sessionId = reference || "";
                    this.logger_.warn(`Fena webhook: no session_id found, using reference fallback: ${sessionId}`);
                }
            }
            catch (err) {
                sessionId = reference || "";
            }
            this.logger_.info(`Fena webhook: resolved session_id: ${sessionId}, authentic_status: ${authenticStatus}`);
            const payloadData = {
                session_id: sessionId,
                amount: new utils_1.BigNumber(amount || 0),
            };
            const normalizedStatus = authenticStatus.toLowerCase();
            // Map authentic Fena payment status to Medusa payment actions
            switch (normalizedStatus) {
                case "active":
                case "payment-made":
                case "payment-confirmed":
                case "paid":
                case fena_client_1.FenaPaymentStatus.Paid: {
                    // Orphan-paid recovery: a paid webhook that points
                    // at a missing/canceled Medusa session would crash
                    // core's authorize step. Emit an app-handled event
                    // and return NOT_SUPPORTED so core skips its flow.
                    const orphanEmitted = await this.maybeEmitFenaOrphanPaid({
                        sessionId,
                        fenaPaymentId,
                        fenaReference: reference || "",
                        amount: Number(amount || 0),
                        currencyCode: webhookData.currency || "GBP",
                    });
                    if (orphanEmitted) {
                        return {
                            action: utils_1.PaymentActions.NOT_SUPPORTED,
                            data: payloadData,
                        };
                    }
                    return {
                        action: utils_1.PaymentActions.SUCCESSFUL,
                        data: payloadData,
                    };
                }
                case "sent":
                case fena_client_1.FenaPaymentStatus.Sent:
                    // "sent" = payment request sent to bank. Return NOT_SUPPORTED to
                    // avoid triggering Medusa's authorization workflow prematurely. 
                    this.logger_.info(`[v2.5] Fena webhook: status "sent" — returning NOT_SUPPORTED.`);
                    return {
                        action: utils_1.PaymentActions.NOT_SUPPORTED,
                        data: payloadData,
                    };
                case "pending":
                case fena_client_1.FenaPaymentStatus.Pending:
                    // Truly pending — not yet sent to bank. Return NOT_SUPPORTED
                    // to avoid triggering Medusa's authorization workflow prematurely. 
                    this.logger_.info(`[v2.5] Fena webhook: status "pending" — returning NOT_SUPPORTED.`);
                    return {
                        action: utils_1.PaymentActions.NOT_SUPPORTED,
                        data: payloadData,
                    };
                case "payment-missed":
                case "cancelled":
                case fena_client_1.FenaPaymentStatus.Cancelled:
                case fena_client_1.FenaPaymentStatus.Rejected:
                    return {
                        action: utils_1.PaymentActions.FAILED,
                        data: payloadData,
                    };
                case "refunded":
                case "partial-refund":
                case fena_client_1.FenaPaymentStatus.Refunded:
                case fena_client_1.FenaPaymentStatus.PartialRefund:
                    return {
                        action: utils_1.PaymentActions.SUCCESSFUL,
                        data: payloadData,
                    };
                default:
                    this.logger_.info(`Fena webhook: Unhandled status "${normalizedStatus}" for payment ${fenaPaymentId}`);
                    return {
                        action: utils_1.PaymentActions.NOT_SUPPORTED,
                        data: payloadData,
                    };
            }
        }
        catch (error) {
            this.logger_.error(`Fena webhook: Error processing webhook — ${(0, fena_client_1.getErrorMessage)(error)}`);
            return {
                action: utils_1.PaymentActions.FAILED,
                data: {
                    session_id: "",
                    amount: new utils_1.BigNumber(0),
                },
            };
        }
    }
    // ──────────────────────────────────────────────────────
    // Recurring subscription event handler
    // ──────────────────────────────────────────────────────
    /**
     * Handles recurring-payment webhook events for subscriptions
     * managed via the cron renewal flow. Resolves Medusa services
     * from the container to update subscription state.
     *
     * This method is safe to call from getWebhookActionAndData:
     * - It only does simple CRUD (no order creation)
     * - It's fully wrapped in try/catch by the caller
     * - It never affects the return value (always NOT_SUPPORTED)
     */
    async handleRecurringSubscriptionEvent(fenaPaymentId, eventName, status) {
        // 1. Resolve owning merchant (try each brand client) then fetch
        //    the recurring payment from that merchant's Fena terminal.
        //    Without per-brand routing the wrong merchant's secret would
        //    return 404 for every brand-override subscription.
        const resolved = await this.resolveContextByFenaId(fenaPaymentId);
        if (!resolved || resolved.kind !== "recurring") {
            this.logger_.info(`Fena subscription handler: could not fetch recurring ${fenaPaymentId} on any configured merchant, skipping`);
            return;
        }
        const recurring = resolved.payment;
        // 2. Find medusa_subscription:xxx note
        const notes = recurring.notes || [];
        const subNote = notes.find((n) => n.text?.startsWith("medusa_subscription:"));
        if (!subNote) {
            this.logger_.info(`Fena subscription handler: no medusa_subscription note for ${fenaPaymentId}, skipping`);
            return;
        }
        // Note format: "medusa_subscription:id1" or "medusa_subscription:id1,id2" (multiple subs from same order)
        const subscriptionIds = subNote.text.replace("medusa_subscription:", "").split(",").filter(Boolean);
        this.logger_.info(`Fena subscription handler: event="${eventName}" status="${status}" for subscriptions ${subscriptionIds.join(", ")}`);
        // 3. Resolve Medusa services from container
        const subscriptionModule = safeResolve(this.container_, ["subscriptionModuleService"]);
        const notificationModule = safeResolve(this.container_, [utils_1.Modules.NOTIFICATION]);
        const query = safeResolve(this.container_, ["query", "__query__", "remoteQuery"]);
        if (!subscriptionModule || !query) {
            this.logger_.warn(`Fena subscription handler: subscription module or query not available, skipping`);
            return;
        }
        // 4. Fetch all subscriptions in the group
        const { data: subs } = await query.graph({
            entity: "subscription",
            fields: ["id", "status", "metadata", "interval", "period", "subscription_date"],
            filters: { id: subscriptionIds },
        });
        const subscriptions = (subs || []).map((s) => s);
        if (subscriptions.length === 0) {
            this.logger_.warn(`Fena subscription handler: no subscriptions found for IDs ${subscriptionIds.join(",")}`);
            return;
        }
        // Use first subscription for metadata (they all share the same order)
        const subscription = subscriptions[0];
        const metadata = subscription.metadata || {};
        // 5. Handle based on event
        switch (eventName) {
            case "status-update": {
                const normalizedStatus = (status || "").toLowerCase();
                if (normalizedStatus === "active") {
                    // Standing order is now active — reactivate ALL subscriptions in the group
                    const tomorrow = new Date();
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    for (const sub of subscriptions) {
                        const subMeta = sub.metadata || {};
                        await subscriptionModule.updateSubscriptions({
                            id: sub.id,
                            status: "active",
                            next_order_date: tomorrow,
                            metadata: {
                                ...subMeta,
                                fena_payment_id: subMeta.fena_renewal_id || fenaPaymentId,
                            },
                        });
                    }
                    this.logger_.info(`Fena subscription handler: reactivated ${subscriptions.length} subscriptions, next_order_date=${tomorrow.toISOString().split("T")[0]}`);
                }
                else {
                    this.logger_.info(`Fena subscription handler: status-update to "${normalizedStatus}", no action`);
                }
                break;
            }
            case "payment_made": {
                // payment_made fires on transaction CREATION at the bank,
                // not on completion — Fena pre-queues the next cycle as a
                // pending transaction the moment the previous one clears
                // (so noon-ish "payment_made" webhooks are routinely about
                // the NEXT cycle, not the one that just settled).
                //
                // Treat this event as a wake-up signal: re-scan the
                // recurring's transactions and emit one
                // subscription.fena_renewal_paid event per transaction whose
                // status === "completed". The subscriber's
                // fena_renewal_handled_txns set provides idempotency, so
                // re-emitting for already-handled txns is safe.
                const txns = (recurring.transactions || []);
                const completedTxns = txns.filter((t) => (t.status || "").toLowerCase() === "completed" && t.id);
                const eventBus = safeResolve(this.container_, [utils_1.Modules.EVENT_BUS, "eventBusService", "__event_bus__"]);
                if (!eventBus) {
                    this.logger_.warn(`Fena subscription handler: event bus not available — can't emit subscription.fena_renewal_paid for ${fenaPaymentId}`);
                    break;
                }
                if (completedTxns.length === 0) {
                    this.logger_.info(`Fena subscription handler: payment_made for ${fenaPaymentId} but no completed transactions yet (have ${txns.length} txn(s) with statuses [${txns.map((t) => t.status).join(",")}]). Subscriber will retry when a transaction completes.`);
                    break;
                }
                this.logger_.info(`Fena subscription handler: ${completedTxns.length} completed transaction(s) on ${fenaPaymentId} — emitting per-txn events`);
                for (const txn of completedTxns) {
                    const amountStr = txn.amount || recurring.recurringAmount || "0";
                    const paidAtIso = txn.completedAt || txn.createdAt || new Date().toISOString();
                    try {
                        await eventBus.emit({
                            name: "subscription.fena_renewal_paid",
                            data: {
                                subscription_ids: subscriptionIds,
                                fena_payment_id: fenaPaymentId,
                                fena_transaction_id: txn.id,
                                amount: Number(amountStr),
                                paid_at_iso: paidAtIso,
                            },
                        });
                        this.logger_.info(`Fena subscription handler: emitted subscription.fena_renewal_paid for subs [${subscriptionIds.join(",")}] (txn=${txn.id}, amount=${amountStr})`);
                    }
                    catch (emitErr) {
                        this.logger_.error(`Fena subscription handler: emit failed for txn ${txn.id} — ${(0, fena_client_1.getErrorMessage)(emitErr)}`);
                    }
                }
                break;
            }
            case "payment-missed": {
                // Standing order payment failed — send reminder email
                const renewalLink = metadata.fena_renewal_link;
                if (!renewalLink) {
                    this.logger_.warn(`Fena subscription handler: no renewal link for ${subscriptionIds.join(",")}, can't send reminder`);
                    break;
                }
                if (!notificationModule) {
                    this.logger_.warn(`Fena subscription handler: notification module not available, can't send reminder`);
                    break;
                }
                // Fetch order data for email content
                const originalOrderId = metadata.original_order_id;
                if (!originalOrderId)
                    break;
                try {
                    const { data: orders } = await query.graph({
                        entity: "order",
                        fields: ["id", "email", "customer.first_name", "customer.last_name", "items.*"],
                        filters: { id: originalOrderId },
                    });
                    const order = orders?.[0];
                    if (!order?.email)
                        break;
                    const subItem = order.items?.find((i) => i.variant_id === metadata.variant_id);
                    const customerName = [order.customer?.first_name, order.customer?.last_name]
                        .filter(Boolean).join(" ") || "Customer";
                    await notificationModule.createNotifications({
                        to: order.email,
                        channel: "email",
                        template: "subscription-reminder",
                        data: {
                            customer_name: customerName,
                            product_name: subItem?.title || "your product",
                            renewal_amount: recurring.recurringAmount || "0.00",
                            payment_url: renewalLink,
                            subject: "Payment missed — please update your subscription",
                        },
                    });
                    this.logger_.info(`Fena subscription handler: sent payment-missed reminder to ${order.email}`);
                }
                catch (emailErr) {
                    this.logger_.error(`Fena subscription handler: failed to send reminder — ${(0, fena_client_1.getErrorMessage)(emailErr)}`);
                }
                break;
            }
            default:
                this.logger_.info(`Fena subscription handler: unhandled event "${eventName}" for ${subscriptionIds.join(",")}`);
        }
    }
    // ──────────────────────────────────────────────────────
    // Orphan-paid event emit
    // ──────────────────────────────────────────────────────
    /**
     * If a paid webhook references a payment_session that is missing,
     * canceled, or soft-deleted in Medusa, emit `payment.fena_orphan_paid`
     * so the host app's recovery workflow can take over.
     *
     * Returns `true` when an orphan was detected and the event emitted —
     * the caller should return NOT_SUPPORTED so Medusa core does not try
     * (and fail) to authorize the missing session.
     *
     * Returns `false` for healthy sessions (caller proceeds with
     * SUCCESSFUL) and on any unexpected error (caller proceeds; we never
     * want orphan-detection to mask legitimate paid webhooks).
     */
    async maybeEmitFenaOrphanPaid(args) {
        try {
            const paymentSessionService = safeResolve(this.container_, ["paymentSessionService"]);
            const query = safeResolve(this.container_, ["query", "__query__", "remoteQuery"]);
            let isOrphan;
            let probeOutcome;
            if (paymentSessionService) {
                try {
                    const session = await paymentSessionService.retrieve(args.sessionId, { select: ["id", "status", "deleted_at"] });
                    probeOutcome = session
                        ? {
                            kind: "found",
                            status: session.status,
                            deletedAt: session.deleted_at,
                        }
                        : { kind: "missing" };
                }
                catch (e) {
                    const msg = (0, fena_client_1.getErrorMessage)(e);
                    // Medusa internal services throw a NotFoundError for missing rows.
                    if (/not found/i.test(msg)) {
                        probeOutcome = { kind: "missing" };
                    }
                    else {
                        probeOutcome = {
                            kind: "unverified",
                            reason: `paymentSessionService.retrieve threw: ${msg}`,
                        };
                    }
                }
            }
            else if (query) {
                const { data: sessions } = await query.graph({
                    entity: "payment_session",
                    fields: ["id", "status", "deleted_at"],
                    filters: { id: args.sessionId },
                });
                const session = sessions?.[0];
                probeOutcome = session
                    ? {
                        kind: "found",
                        status: session.status,
                        deletedAt: session.deleted_at,
                    }
                    : { kind: "missing" };
            }
            else {
                probeOutcome = {
                    kind: "unverified",
                    reason: "neither paymentSessionService nor query registered in payment-provider scope",
                };
            }
            if (probeOutcome.kind === "found") {
                const deleted = probeOutcome.deletedAt != null;
                const canceled = probeOutcome.status === "canceled";
                isOrphan = deleted || canceled;
                if (isOrphan) {
                    this.logger_.warn(`Fena orphan-check: session ${args.sessionId} status=${probeOutcome.status} deleted_at=${probeOutcome.deletedAt} — treating fena_payment_id ${args.fenaPaymentId} as orphan-paid`);
                }
            }
            else if (probeOutcome.kind === "missing") {
                isOrphan = true;
                this.logger_.warn(`Fena orphan-check: session ${args.sessionId} missing — treating fena_payment_id ${args.fenaPaymentId} as orphan-paid`);
            }
            else {
                // Cannot verify session state from this scope. Emit
                // optimistically: the recovery workflow is idempotent on
                // fena_payment_id and exits cleanly via `alreadyHasOrder`
                // when the cart was already converted to an order. Without
                // emitting here, a paid webhook against a deleted session
                // silently fails Medusa core's authorize step and the order
                // is never created — the bug that motivated this safety net.
                isOrphan = true;
                this.logger_.warn(`Fena orphan-check: cannot verify session ${args.sessionId} (${probeOutcome.reason}); emitting payment.fena_orphan_paid optimistically — recovery workflow is idempotent`);
            }
            if (!isOrphan) {
                return false;
            }
            // Fetch the Fena payment to get customer email/name and the
            // canonical timestamp. Best-effort — if the API call fails we
            // still emit with what we have so the recovery workflow can
            // try to match the cart by reference + amount.
            let customerEmail = "";
            let customerName;
            let capturedAtIso = new Date().toISOString();
            try {
                // Find which merchant owns this id (per-brand routing).
                const resolved = await this.resolveContextByFenaId(args.fenaPaymentId);
                const fenaPayment = resolved?.kind === "single"
                    ? resolved.payment
                    : await this.client_.getPayment(args.fenaPaymentId);
                customerEmail = fenaPayment.customerEmail || "";
                customerName = fenaPayment.customerName;
                capturedAtIso = fenaPayment.createdAt
                    ? new Date(fenaPayment.createdAt).toISOString()
                    : capturedAtIso;
            }
            catch (e) {
                this.logger_.warn(`Fena orphan-check: getPayment(${args.fenaPaymentId}) failed — ${(0, fena_client_1.getErrorMessage)(e)}. Emitting with empty customerEmail.`);
            }
            const eventBus = safeResolve(this.container_, [utils_1.Modules.EVENT_BUS, "eventBusService", "__event_bus__"]);
            if (!eventBus) {
                this.logger_.error(`Fena orphan-check: event bus not available — cannot emit payment.fena_orphan_paid for ${args.fenaPaymentId}`);
                return false;
            }
            await eventBus.emit({
                name: "payment.fena_orphan_paid",
                data: {
                    fenaPaymentId: args.fenaPaymentId,
                    fenaReference: args.fenaReference,
                    amount: args.amount,
                    currencyCode: args.currencyCode,
                    customerEmail,
                    customerName,
                    capturedAtIso,
                    missingSessionId: args.sessionId,
                },
            });
            this.logger_.info(`Fena orphan-check: emitted payment.fena_orphan_paid for ${args.fenaPaymentId} (ref=${args.fenaReference}, email=${customerEmail || "unknown"})`);
            return true;
        }
        catch (e) {
            this.logger_.error(`Fena orphan-check: unexpected error — ${(0, fena_client_1.getErrorMessage)(e)}. Falling through to SUCCESSFUL.`);
            return false;
        }
    }
    // ──────────────────────────────────────────────────────
    // Private helpers
    // ──────────────────────────────────────────────────────
    /**
     * Validates and extracts webhook data from the raw payload.
     * Returns null if the data doesn't match expected shape.
     */
    parseFenaWebhookData(data) {
        if (typeof data !== "object" || data === null)
            return null;
        const id = (data.id || data.recurring_id);
        const status = (data.status || data.statusName);
        const eventScope = data.eventScope;
        const eventName = data.eventName;
        if (typeof id !== "string" || (typeof status !== "string" && !eventName))
            return null;
        return {
            id,
            status: (status || eventName),
            reference: (typeof data.reference === "string" ? data.reference : "") ||
                (typeof data.invoiceRefNumber === "string" ? data.invoiceRefNumber : ""),
            amount: (typeof data.amount === "string" ? data.amount : "") ||
                (typeof data.recurringAmount === "string" ? data.recurringAmount : "0"),
            currency: typeof data.currency === "string" ? data.currency : "GBP",
            eventScope,
            eventName,
            notes: data.notes
        };
    }
    // ──────────────────────────────────────────────────────
    // Account Holder (Medusa v2.5+)
    // ──────────────────────────────────────────────────────
    /**
     * Creates an account holder in Fena (Managed Entity).
     */
    async createAccountHolder({ context, data }) {
        const { account_holder, customer } = context;
        if (account_holder?.data?.id) {
            return { id: account_holder.data.id };
        }
        if (!customer) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Missing customer data for Fena Account Holder creation.");
        }
        try {
            this.logger_.info(`Fena: creating local account holder for ${customer.email}`);
            const managedEntity = await this.client_.createManagedEntity({
                name: `${customer.first_name} ${customer.last_name || ""}`.trim() || customer.email,
                type: fena_client_1.FenaManagedEntityType.Consumer,
            });
            return {
                id: managedEntity.id,
                data: managedEntity,
            };
        }
        catch (error) {
            this.logger_.error(`Fena: createAccountHolder failed — ${(0, fena_client_1.getErrorMessage)(error)}`);
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, `Failed to create Fena Managed Entity: ${(0, fena_client_1.getErrorMessage)(error)}`);
        }
    }
    /**
     * Saves a payment method for an account holder.
     * For Fena recurring, this is the Standing Order authorization.
     */
    async savePaymentMethod({ context, data }) {
        const fenaPaymentId = getDataString(data, "fena_payment_id");
        if (!fenaPaymentId) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Missing Fena payment ID to save payment method.");
        }
        return {
            id: fenaPaymentId,
            data: {
                ...data,
                fena_saved_payment_id: fenaPaymentId,
            },
        };
    }
    /**
     * Lists saved payment methods for an account holder.
     */
    async listPaymentMethods(context) {
        // Return saved payment methods if available in Medusa account holder data
        return [];
    }
    /**
     * Deletes an account holder in Fena.
     */
    async deleteAccountHolder(context) {
        // Optional: delete managed entity in Fena if desired
        return {};
    }
    /**
     * Maps Fena payment statuses to Medusa PaymentSessionStatus values.
     */
    mapFenaStatusToMedusa(fenaStatus) {
        const normalizedStatus = fenaStatus.toLowerCase();
        switch (normalizedStatus) {
            case "active":
            case "payment-made":
            case "payment-confirmed":
            case "paid":
            case fena_client_1.FenaPaymentStatus.Paid:
                return "captured";
            case "sent":
            case "pending":
            case "draft":
            case "overdue":
            case fena_client_1.FenaPaymentStatus.Sent:
            case fena_client_1.FenaPaymentStatus.Pending:
            case fena_client_1.FenaPaymentStatus.Draft:
            case fena_client_1.FenaPaymentStatus.Overdue:
                return "pending";
            case "payment-missed":
            case fena_client_1.FenaPaymentStatus.Rejected:
                return "error";
            case "cancelled":
            case fena_client_1.FenaPaymentStatus.Cancelled:
                return "canceled";
            case fena_client_1.FenaPaymentStatus.Refunded:
            case fena_client_1.FenaPaymentStatus.PartialRefund:
            case fena_client_1.FenaPaymentStatus.RefundStarted:
                return "captured";
            default:
                return "pending";
        }
    }
    /**
     * Retrieve either a single payment or a recurring payment using a
     * specific brand client. Per-brand routing requires the caller to
     * supply the right client (resolved via `resolveContext` or
     * `resolveContextByFenaId`) — using `this.client_` here would always
     * hit the default merchant and 404 on every brand-override payment.
     */
    async getPaymentOrRecurring(id, client = this.client_) {
        try {
            // Check if it's a single payment first
            return await client.getPayment(id);
        }
        catch (e) {
            // Try recurring
            try {
                return await client.getRecurringPayment(id);
            }
            catch (recurringError) {
                throw new Error(`Failed to retrieve payment or recurring payment with ID ${id}`);
            }
        }
    }
}
FenaPaymentProviderService.identifier = exports.FENA_PROVIDER_ID;
exports.default = FenaPaymentProviderService;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvZmVuYS9zZXJ2aWNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7R0FXRzs7O0FBRUgscURBTWtDO0FBaUNsQyx1REFVOEI7QUE0RDlCLDJEQUEyRDtBQUMzRCxVQUFVO0FBQ1YsMkRBQTJEO0FBRTNEOzs7Ozs7R0FNRztBQUNILE1BQU0sV0FBVyxHQUFHLENBQ2hCLFNBQWtDLEVBQ2xDLElBQXVCLEVBQ1YsRUFBRTtJQUNmLEtBQUssTUFBTSxHQUFHLElBQUksSUFBSSxFQUFFLENBQUM7UUFDckIsSUFBSSxDQUFDO1lBQ0QsTUFBTSxLQUFLLEdBQUcsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFBO1lBQzVCLElBQUksS0FBSyxJQUFJLElBQUk7Z0JBQUUsT0FBTyxLQUFVLENBQUE7UUFDeEMsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLDhCQUE4QjtRQUNsQyxDQUFDO0lBQ0wsQ0FBQztJQUNELE9BQU8sU0FBUyxDQUFBO0FBQ3BCLENBQUMsQ0FBQTtBQUVEOzs7R0FHRztBQUNILFNBQVMsYUFBYSxDQUNsQixJQUF5QyxFQUN6QyxHQUFXO0lBRVgsSUFBSSxDQUFDLElBQUk7UUFBRSxPQUFPLFNBQVMsQ0FBQTtJQUMzQixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUE7SUFDdkIsT0FBTyxPQUFPLEtBQUssS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFBO0FBQ3hELENBQUM7QUFFRDs7R0FFRztBQUNILFNBQVMsYUFBYSxDQUFDLE9BQVk7SUFDL0IsSUFBSSxDQUFDLE9BQU87UUFBRSxPQUFPLEVBQUUsQ0FBQTtJQUN2QixNQUFNLEtBQUssR0FBRztRQUNWLE9BQU8sQ0FBQyxVQUFVLElBQUksT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFD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