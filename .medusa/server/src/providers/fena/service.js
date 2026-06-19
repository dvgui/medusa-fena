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
     *   2. `session_id`, resolving cart metadata to candidate brand keys
     *      (`funnel` preferred over `storefront`, so same-channel funnels can
     *      route to their own merchant):
     *        - `cart_*` → cart.metadata via the cart module.
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
            const candidates = sessionId.startsWith("cart_")
                ? await this.resolveBrandKeysFromCartId(sessionId)
                : sessionId.startsWith("payses_")
                    ? await this.resolveBrandKeysFromPaymentSessionId(sessionId)
                    : [];
            for (const slug of candidates) {
                if (slug && this.brandContexts_.has(slug)) {
                    return this.brandContexts_.get(slug);
                }
            }
        }
        catch (err) {
            this.logger_.warn(`Fena: brand-resolve via ${sessionId} failed — ${(0, fena_client_1.getErrorMessage)(err)}; falling through to default merchant`);
        }
        return this.brandContexts_.get(DEFAULT_BRAND_SLUG);
    }
    /** Candidate brand keys from cart metadata, in priority order. The funnel
     *  slug comes first so same-sales-channel funnels that share a storefront
     *  slug (e.g. buyreta-uk.com, stamped `funnel: "buyretauk_com"`, sharing the
     *  `buyreta_uk` storefront) can route to their own merchant; the storefront
     *  slug is the fallback. resolveContext picks the first that is configured,
     *  so an unconfigured funnel transparently falls back to the storefront. */
    brandKeysFromMeta(meta) {
        const keys = [];
        if (typeof meta?.funnel === "string" && meta.funnel) {
            keys.push(meta.funnel);
        }
        if (typeof meta?.storefront === "string" && meta.storefront) {
            keys.push(meta.storefront);
        }
        return keys;
    }
    /** Cart id (cart_*) → candidate brand keys from cart.metadata. Returns an
     *  empty array if the cart isn't found, the cart module isn't registered in
     *  the current container scope, or no routing keys are present. */
    async resolveBrandKeysFromCartId(cartId) {
        const cartModule = safeResolve(this.container_, [
            utils_1.Modules.CART,
            "cartModuleService",
            "cartService",
        ]);
        if (!cartModule?.retrieveCart)
            return [];
        const cart = await cartModule.retrieveCart(cartId, {
            select: ["id", "metadata"],
        });
        return this.brandKeysFromMeta(cart?.metadata);
    }
    /** payment_session id (payses_*) → payment_collection → cart.metadata.
     *  Uses query.graph so we don't need the payment / cart modules to be
     *  injected into the provider scope (they're not in v2). */
    async resolveBrandKeysFromPaymentSessionId(sessionId) {
        const query = safeResolve(this.container_, [
            "query",
            "__query__",
            "remoteQuery",
        ]);
        if (!query?.graph)
            return [];
        const { data } = await query.graph({
            entity: "payment_session",
            fields: ["id", "payment_collection.cart.id", "payment_collection.cart.metadata"],
            filters: { id: sessionId },
        });
        const row = data[0];
        return this.brandKeysFromMeta(row?.payment_collection?.cart?.metadata);
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
                // A renewal-link customer pays the initial amount during the
                // same bank flow that authorizes the standing order, and that
                // payment never shows up in transactions[] — scan for it here
                // too so the renewal order isn't deferred to the next cycle.
                await this.emitSettledRenewalPayments(recurring, subscriptionIds, fenaPaymentId);
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
                // recurring's settled payments and emit one
                // subscription.fena_renewal_paid event per settled item.
                // The subscriber's fena_renewal_handled_txns set provides
                // idempotency, so re-emitting for already-handled txns is safe.
                await this.emitSettledRenewalPayments(recurring, subscriptionIds, fenaPaymentId);
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
    /**
     * Emit one `subscription.fena_renewal_paid` event per settled payment on
     * a recurring: completed entries from transactions[] PLUS the initial
     * payment when paid. Renewal links created with initialPaymentAmount
     * settle that first debit as `recurring.initialPayment` — it never
     * appears in transactions[], so scanning transactions alone misses it
     * entirely (orders were silently skipped until the next cycle's debit).
     *
     * Initial payments are keyed by their externalReference (stable, unique)
     * since the API exposes no transaction id for them. The subscriber's
     * fena_renewal_handled_txns set dedupes re-emits, and its initial-vs-
     * renewal classifier absorbs signup initial payments (paid within
     * minutes of subscription creation → recorded, no order).
     */
    async emitSettledRenewalPayments(recurring, subscriptionIds, fenaPaymentId) {
        const txns = (recurring.transactions || []);
        const settled = txns
            .filter((t) => (t.status || "").toLowerCase() === "completed" && t.id)
            .map((t) => ({
            key: t.id,
            amount: t.amount,
            paidAtIso: t.completedAt || t.createdAt || new Date().toISOString(),
        }));
        const ip = recurring.initialPayment;
        const ipPaidAt = ip?.completedAt || ip?.createdAt;
        // No timestamp → can't classify initial-vs-renewal downstream; skip
        // rather than risk a misdated emit creating a bogus order.
        if (ip && (ip.status || "").toLowerCase() === "paid" && ipPaidAt) {
            settled.push({
                key: ip.externalReference || `${recurring.id}-initial`,
                amount: ip.amount,
                paidAtIso: ipPaidAt,
            });
        }
        if (settled.length === 0) {
            this.logger_.info(`Fena subscription handler: no settled payments yet on ${fenaPaymentId} (${txns.length} txn(s) [${txns.map((t) => t.status).join(",")}], initialPayment=${ip ? ip.status : "none"}). Subscriber will retry when one settles.`);
            return;
        }
        const eventBus = safeResolve(this.container_, [utils_1.Modules.EVENT_BUS, "eventBusService", "__event_bus__"]);
        if (!eventBus) {
            this.logger_.warn(`Fena subscription handler: event bus not available — can't emit subscription.fena_renewal_paid for ${fenaPaymentId}`);
            return;
        }
        this.logger_.info(`Fena subscription handler: ${settled.length} settled payment(s) on ${fenaPaymentId} — emitting per-payment events`);
        for (const item of settled) {
            const amountStr = item.amount || recurring.recurringAmount || "0";
            try {
                await eventBus.emit({
                    name: "subscription.fena_renewal_paid",
                    data: {
                        subscription_ids: subscriptionIds,
                        fena_payment_id: fenaPaymentId,
                        fena_transaction_id: item.key,
                        amount: Number(amountStr),
                        paid_at_iso: item.paidAtIso,
                    },
                });
                this.logger_.info(`Fena subscription handler: emitted subscription.fena_renewal_paid for subs [${subscriptionIds.join(",")}] (txn=${item.key}, amount=${amountStr})`);
            }
            catch (emitErr) {
                this.logger_.error(`Fena subscription handler: emit failed for txn ${item.key} — ${(0, fena_client_1.getErrorMessage)(emitErr)}`);
            }
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