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
        this.logger_.info(`[FENADBG] resolveContext entry brand_slug=${JSON.stringify(input.data?.brand_slug)} session_id=${JSON.stringify(input.data?.session_id)} explicitMatch=${!!(explicit && this.brandContexts_.has(explicit))} dataKeys=${JSON.stringify(Object.keys(input.data ?? {}))}`);
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
            this.logger_.info(`[FENADBG] resolveContext sessionId=${sessionId} candidates=${JSON.stringify(candidates)} configured=${JSON.stringify([...this.brandContexts_.keys()])}`);
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
        this.logger_.info(`[FENADBG] payses walk sessionId=${sessionId} queryOk=${!!query?.graph} gotRow=${!!row} cartId=${row?.payment_collection?.cart?.id} cartMeta=${JSON.stringify(row?.payment_collection?.cart?.metadata)}`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvZmVuYS9zZXJ2aWNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7R0FXRzs7O0FBRUgscURBTWtDO0FBaUNsQyx1REFVOEI7QUE0RDlCLDJEQUEyRDtBQUMzRCxVQUFVO0FBQ1YsMkRBQTJEO0FBRTNEOzs7Ozs7R0FNRztBQUNILE1BQU0sV0FBVyxHQUFHLENBQ2hCLFNBQWtDLEVBQ2xDLElBQXVCLEVBQ1YsRUFBRTtJQUNmLEtBQUssTUFBTSxHQUFHLElBQUksSUFBSSxFQUFFLENBQUM7UUFDckIsSUFBSSxDQUFDO1lBQ0QsTUFBTSxLQUFLLEdBQUcsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFBO1lBQzVCLElBQUksS0FBSyxJQUFJLElBQUk7Z0JBQUUsT0FBTyxLQUFVLENBQUE7UUFDeEMsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLDhCQUE4QjtRQUNsQyxDQUFDO0lBQ0wsQ0FBQztJQUNELE9BQU8sU0FBUyxDQUFBO0FBQ3BCLENBQUMsQ0FBQTtBQUVEOzs7R0FHRztBQUNILFNBQVMsYUFBYSxDQUNsQixJQUF5QyxFQUN6QyxHQUFXO0lBRVgsSUFBSSxDQUFDLElBQUk7UUFBRSxPQUFPLFNBQVMsQ0FBQTtJQUMzQixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUE7SUFDdkIsT0FBTyxPQUFPLEtBQUssS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFBO0FBQ3hELENBQUM7QUFFRDs7R0FFRztBQUNILFNBQVMsYUFBYSxDQUFDLE9BQVk7SUFDL0IsSUFBSSxDQUFDLE9BQU87UUFBRSxPQUFPLEVBQUUsQ0FBQTtJQUN2QixNQUFNLEtBQUssR0FBRztRQUNWLE9BQU8sQ0FBQyxVQUFVLElBQUksT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsR0FBRyxPQUFPLENBQUMsVUFBVSxJQUFJLEVBQUUsSUFBSSxPQUFPLENBQUMsU0FBUyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJO1FBQ2hILE9BQU8sQ0FBQyxPQUFPO1FBQ2YsT0FBTyxDQUFDLFNBQVM7UUFDakIsT0FBTyxDQUFDLFNBQVM7UUFDakIsT0FBTyxDQUFDLElBQUk7UUFDWixPQUFPLENBQUMsUUFBUTtRQUNoQixPQUFPLENBQUMsV0FBVztRQUNuQixPQUFPLENBQUMsWUFBWSxFQUFFLFdBQVcsRUFBRTtRQUNuQyxPQUFPLENBQUMsS0FBSztLQUNoQixDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQTtJQUNqQixPQUFPLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUE7QUFDM0IsQ0FBQztBQUVELDJEQUEyRDtBQUMzRCxzQkFBc0I7QUFDdEIsMkRBQTJEO0FBRTlDLFFBQUEsZ0JBQWdCLEdBQUcsU0FBUyxDQUFBO0FBRXpDLDJEQUEyRDtBQUMzRCxtQkFBbUI7QUFDbkIsMkRBQTJEO0FBRTNELG9FQUFvRTtBQUNwRSxNQUFNLGtCQUFrQixHQUFHLGFBQWEsQ0FBQTtBQVl4QyxNQUFNLDBCQUEyQixTQUFRLCtCQUFtRDtJQWN4RixZQUNJLFNBQStCLEVBQy9CLE9BQW1DO1FBRW5DLEtBQUssQ0FBQyxTQUFTLEVBQUUsT0FBTyxDQUFDLENBQUE7UUFFekIsSUFBSSxDQUFDLE9BQU8sR0FBRyxTQUFTLENBQUMsTUFBTSxDQUFBO1FBQy9CLElBQUksQ0FBQyxRQUFRLEdBQUcsT0FBTyxDQUFBO1FBQ3ZCLElBQUksQ0FBQyxVQUFVLEdBQUcsU0FBUyxDQUFBO1FBRTNCLG1FQUFtRTtRQUNuRSxpRUFBaUU7UUFDakUscUNBQXFDO1FBQ3JDLE1BQU0sYUFBYSxHQUFHLElBQUksd0JBQVUsQ0FBQztZQUNqQyxVQUFVLEVBQUUsT0FBTyxDQUFDLFVBQVU7WUFDOUIsY0FBYyxFQUFFLE9BQU8sQ0FBQyxjQUFjO1NBQ3pDLENBQUMsQ0FBQTtRQUNGLElBQUksQ0FBQyxPQUFPLEdBQUcsYUFBYSxDQUFBO1FBQzVCLElBQUksQ0FBQyxjQUFjLEdBQUcsSUFBSSxHQUFHLEVBQUUsQ0FBQTtRQUUvQixpRUFBaUU7UUFDakUsZ0VBQWdFO1FBQ2hFLDJEQUEyRDtRQUMzRCxNQUFNLFNBQVMsR0FBRyxPQUFPLENBQUMsZ0JBQWdCLElBQUksRUFBRSxDQUFBO1FBQ2hELEtBQUssTUFBTSxDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7WUFDcEQsSUFBSSxDQUFDLEtBQUssQ0FBQyxVQUFVLElBQUksQ0FBQyxLQUFLLENBQUMsY0FBYyxFQUFFLENBQUM7Z0JBQzdDLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLDBCQUEwQixJQUFJLHlHQUF5RyxDQUMxSSxDQUFBO2dCQUNELFNBQVE7WUFDWixDQUFDO1lBQ0QsSUFBSSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFO2dCQUMxQixNQUFNLEVBQUUsSUFBSSx3QkFBVSxDQUFDO29CQUNuQixVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7b0JBQzVCLGNBQWMsRUFBRSxLQUFLLENBQUMsY0FBYztpQkFDdkMsQ0FBQztnQkFDRixJQUFJLEVBQUU7b0JBQ0YsR0FBRyxPQUFPO29CQUNWLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVTtvQkFDNUIsY0FBYyxFQUFFLEtBQUssQ0FBQyxjQUFjO29CQUNwQyxhQUFhLEVBQUUsS0FBSyxDQUFDLGFBQWEsSUFBSSxPQUFPLENBQUMsYUFBYTtvQkFDM0QsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTLElBQUksT0FBTyxDQUFDLFNBQVM7b0JBQy9DLFdBQVcsRUFBRSxLQUFLLENBQUMsV0FBVyxJQUFJLE9BQU8sQ0FBQyxXQUFXO2lCQUN4RDtnQkFDRCxJQUFJO2FBQ1AsQ0FBQyxDQUFBO1FBQ04sQ0FBQztRQUNELGlFQUFpRTtRQUNqRSx5REFBeUQ7UUFDekQsSUFBSSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsa0JBQWtCLEVBQUU7WUFDeEMsTUFBTSxFQUFFLGFBQWE7WUFDckIsSUFBSSxFQUFFLE9BQU87WUFDYixJQUFJLEVBQUUsa0JBQWtCO1NBQzNCLENBQUMsQ0FBQTtRQUVGLE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsSUFBSSxHQUFHLENBQUMsQ0FBQTtRQUNsRCxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FDYixhQUFhLEdBQUcsQ0FBQztZQUNiLENBQUMsQ0FBQywwQ0FBMEMsYUFBYSx1QkFBdUIsQ0FBQyxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsS0FBSyxrQkFBa0IsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRTtZQUNwSyxDQUFDLENBQUMsbURBQW1ELENBQzVELENBQUE7SUFDTCxDQUFDO0lBRUQseURBQXlEO0lBQ3pELDJCQUEyQjtJQUMzQix5REFBeUQ7SUFFekQ7Ozs7Ozs7Ozs7Ozs7OztPQWVHO0lBQ08sS0FBSyxDQUFDLGNBQWMsQ0FBQyxLQUU5QjtRQUNHLE1BQU0sUUFBUSxHQUNWLE9BQU8sS0FBSyxDQUFDLElBQUksRUFBRSxVQUFVLEtBQUssUUFBUTtZQUN0QyxDQUFDLENBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxVQUFxQjtZQUNuQyxDQUFDLENBQUMsU0FBUyxDQUFBO1FBQ25CLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLDZDQUE2QyxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsVUFBVSxDQUFDLGVBQWUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLFVBQVUsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLENBQUMsUUFBUSxJQUFJLElBQUksQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxDQUFDLGFBQWEsSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDLENBQUMsRUFBRSxDQUMxUSxDQUFBO1FBQ0QsSUFBSSxRQUFRLElBQUksSUFBSSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQztZQUNoRCxPQUFPLElBQUksQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBRSxDQUFBO1FBQzdDLENBQUM7UUFFRCxNQUFNLFNBQVMsR0FDWCxPQUFPLEtBQUssQ0FBQyxJQUFJLEVBQUUsVUFBVSxLQUFLLFFBQVE7WUFDdEMsQ0FBQyxDQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsVUFBcUI7WUFDbkMsQ0FBQyxDQUFDLFNBQVMsQ0FBQTtRQUNuQixJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7WUFDYixPQUFPLElBQUksQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLGtCQUFrQixDQUFFLENBQUE7UUFDdkQsQ0FBQztRQUVELElBQUksQ0FBQztZQUNELE1BQU0sVUFBVSxHQUFHLFNBQVMsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDO2dCQUM1QyxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsMEJBQTBCLENBQUMsU0FBUyxDQUFDO2dCQUNsRCxDQUFDLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQyxTQUFTLENBQUM7b0JBQy9CLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxvQ0FBb0MsQ0FBQyxTQUFTLENBQUM7b0JBQzVELENBQUMsQ0FBQyxFQUFFLENBQUE7WUFDVixJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FDYixzQ0FBc0MsU0FBUyxlQUFlLElBQUksQ0FBQyxTQUFTLENBQUMsVUFBVSxDQUFDLGVBQWUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FDM0osQ0FBQTtZQUNELEtBQUssTUFBTSxJQUFJLElBQUksVUFBVSxFQUFFLENBQUM7Z0JBQzVCLElBQUksSUFBSSxJQUFJLElBQUksQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7b0JBQ3hDLE9BQU8sSUFBSSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFFLENBQUE7Z0JBQ3pDLENBQUM7WUFDTCxDQUFDO1FBQ0wsQ0FBQztRQUFDLE9BQU8sR0FBWSxFQUFFLENBQUM7WUFDcEIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2IsMkJBQTJCLFNBQVMsYUFBYSxJQUFBLDZCQUFlLEVBQUMsR0FBRyxDQUFDLHVDQUF1QyxDQUMvRyxDQUFBO1FBQ0wsQ0FBQztRQUVELE9BQU8sSUFBSSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsa0JBQWtCLENBQUUsQ0FBQTtJQUN2RCxDQUFDO0lBRUQ7Ozs7O2dGQUs0RTtJQUNwRSxpQkFBaUIsQ0FDckIsSUFBeUM7UUFFekMsTUFBTSxJQUFJLEdBQWEsRUFBRSxDQUFBO1FBQ3pCLElBQUksT0FBTyxJQUFJLEVBQUUsTUFBTSxLQUFLLFFBQVEsSUFBSSxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDbEQsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBZ0IsQ0FBQyxDQUFBO1FBQ3BDLENBQUM7UUFDRCxJQUFJLE9BQU8sSUFBSSxFQUFFLFVBQVUsS0FBSyxRQUFRLElBQUksSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQzFELElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQW9CLENBQUMsQ0FBQTtRQUN4QyxDQUFDO1FBQ0QsT0FBTyxJQUFJLENBQUE7SUFDZixDQUFDO0lBRUQ7O3VFQUVtRTtJQUMzRCxLQUFLLENBQUMsMEJBQTBCLENBQ3BDLE1BQWM7UUFFZCxNQUFNLFVBQVUsR0FBUSxXQUFXLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRTtZQUNqRCxlQUFPLENBQUMsSUFBSTtZQUNaLG1CQUFtQjtZQUNuQixhQUFhO1NBQ2hCLENBQUMsQ0FBQTtRQUNGLElBQUksQ0FBQyxVQUFVLEVBQUUsWUFBWTtZQUFFLE9BQU8sRUFBRSxDQUFBO1FBQ3hDLE1BQU0sSUFBSSxHQUFHLE1BQU0sVUFBVSxDQUFDLFlBQVksQ0FBQyxNQUFNLEVBQUU7WUFDL0MsTUFBTSxFQUFFLENBQUMsSUFBSSxFQUFFLFVBQVUsQ0FBQztTQUM3QixDQUFDLENBQUE7UUFDRixPQUFPLElBQUksQ0FBQyxpQkFBaUIsQ0FDekIsSUFBSSxFQUFFLFFBQStDLENBQ3hELENBQUE7SUFDTCxDQUFDO0lBRUQ7O2dFQUU0RDtJQUNwRCxLQUFLLENBQUMsb0NBQW9DLENBQzlDLFNBQWlCO1FBRWpCLE1BQU0sS0FBSyxHQUFRLFdBQVcsQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFO1lBQzVDLE9BQU87WUFDUCxXQUFXO1lBQ1gsYUFBYTtTQUNoQixDQUFDLENBQUE7UUFDRixJQUFJLENBQUMsS0FBSyxFQUFFLEtBQUs7WUFBRSxPQUFPLEVBQUUsQ0FBQTtRQUM1QixNQUFNLEVBQUUsSUFBSSxFQUFFLEdBQUcsTUFBTSxLQUFLLENBQUMsS0FBSyxDQUFDO1lBQy9CLE1BQU0sRUFBRSxpQkFBaUI7WUFDekIsTUFBTSxFQUFFLENBQUMsSUFBSSxFQUFFLDRCQUE0QixFQUFFLGtDQUFrQyxDQUFDO1lBQ2hGLE9BQU8sRUFBRSxFQUFFLEVBQUUsRUFBRSxTQUFTLEVBQUU7U0FDN0IsQ0FBQyxDQUFBO1FBQ0YsTUFBTSxHQUFHLEdBQUksSUFBYyxDQUFDLENBQUMsQ0FBQyxDQUFBO1FBQzlCLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLG1DQUFtQyxTQUFTLFlBQVksQ0FBQyxDQUFDLEtBQUssRUFBRSxLQUFLLFdBQVcsQ0FBQyxDQUFDLEdBQUcsV0FBVyxHQUFHLEVBQUUsa0JBQWtCLEVBQUUsSUFBSSxFQUFFLEVBQUUsYUFBYSxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsRUFBRSxrQkFBa0IsRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLEVBQUUsQ0FDM00sQ0FBQTtRQUNELE9BQU8sSUFBSSxDQUFDLGlCQUFpQixDQUN6QixHQUFHLEVBQUUsa0JBQWtCLEVBQUUsSUFBSSxFQUFFLFFBRWhCLENBQ2xCLENBQUE7SUFDTCxDQUFDO0lBRUQ7Ozs7Ozs7Ozs7O09BV0c7SUFDTyxLQUFLLENBQUMsc0JBQXNCLENBQ2xDLGFBQXFCO1FBRXJCLG9DQUFvQztRQUNwQyxLQUFLLE1BQU0sR0FBRyxJQUFJLElBQUksQ0FBQyxjQUFjLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQztZQUM3QyxJQUFJLENBQUM7Z0JBQ0QsTUFBTSxPQUFPLEdBQUcsTUFBTSxHQUFHLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQTtnQkFDMUQsSUFBSSxPQUFPLEVBQUUsQ0FBQztvQkFDVixPQUFPLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLENBQUE7Z0JBQzNDLENBQUM7WUFDTCxDQUFDO1lBQUMsTUFBTSxDQUFDO2dCQUNMLHlEQUF5RDtZQUM3RCxDQUFDO1FBQ0wsQ0FBQztRQUNELHVDQUF1QztRQUN2QyxLQUFLLE1BQU0sR0FBRyxJQUFJLElBQUksQ0FBQyxjQUFjLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQztZQUM3QyxJQUFJLENBQUM7Z0JBQ0QsTUFBTSxPQUFPLEdBQUcsTUFBTSxHQUFHLENBQUMsTUFBTSxDQUFDLG1CQUFtQixDQUFDLGFBQWEsQ0FBQyxDQUFBO2dCQUNuRSxJQUFJLE9BQU8sRUFBRSxDQUFDO29CQUNWLE9BQU8sRUFBRSxHQUFHLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUUsQ0FBQTtnQkFDOUMsQ0FBQztZQUNMLENBQUM7WUFBQyxNQUFNLENBQUM7Z0JBQ0wsa0JBQWtCO1lBQ3RCLENBQUM7UUFDTCxDQUFDO1FBQ0QsT0FBTyxJQUFJLENBQUE7SUFDZixDQUFDO0lBRUQseURBQXlEO0lBQ3pELGtCQUFrQjtJQUNsQix5REFBeUQ7SUFFekQ7Ozs7T0FJRztJQUNILEtBQUssQ0FBQyxlQUFlLENBQ2pCLEtBQTJCO1FBRTNCLE1BQU0sRUFBRSxNQUFNLEVBQUUsYUFBYSxFQUFFLE9BQU8sRUFBRSxHQUFHLEtBQUssQ0FBQTtRQUVoRCxJQUFJLENBQUM7WUFDRCw2REFBNkQ7WUFDN0QsK0RBQStEO1lBQy9ELCtEQUErRDtZQUMvRCw4REFBOEQ7WUFDOUQsK0RBQStEO1lBQy9ELCtCQUErQjtZQUMvQixJQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFLENBQUM7Z0JBQ3pCLE1BQU0sY0FBYyxHQUNoQixhQUFhLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxpQkFBaUIsQ0FBQztvQkFDNUMsYUFBYSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLENBQUMsQ0FBQTtnQkFDbEQsSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO29CQUNsQixNQUFNLElBQUksbUJBQVcsQ0FDakIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUM5Qiw2REFBNkQsQ0FDaEUsQ0FBQTtnQkFDTCxDQUFDO2dCQUNELElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLHlFQUF5RSxjQUFjLEVBQUUsQ0FDNUYsQ0FBQTtnQkFDRCxPQUFPO29CQUNILEVBQUUsRUFBRSxjQUFjO29CQUNsQixJQUFJLEVBQUU7d0JBQ0YsR0FBRyxLQUFLLENBQUMsSUFBSTt3QkFDYixlQUFlLEVBQUUsY0FBYzt3QkFDL0IsVUFBVSxFQUFFLElBQUk7d0JBQ2hCLGFBQWE7cUJBQ2hCO2lCQUNKLENBQUE7WUFDTCxDQUFDO1lBRUQsZ0VBQWdFO1lBQ2hFLGtFQUFrRTtZQUNsRSw4REFBOEQ7WUFDOUQsZ0VBQWdFO1lBQ2hFLHdDQUF3QztZQUN4QyxNQUFNLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLEdBQUcsTUFBTSxJQUFJLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFBO1lBRTFFLE1BQU0sV0FBVyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLFlBQVksQ0FBQTtZQUM5QyxNQUFNLFNBQVMsR0FBRyxhQUFhLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxZQUFZLENBQUMsSUFBSSxRQUFRLElBQUksQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFBO1lBQ2pGLE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxPQUFPLENBQUMsYUFBYSxFQUFFLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFBO1lBQ2pFLE1BQU0sZUFBZSxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUE7WUFFakQsNEVBQTRFO1lBQzVFLElBQUksYUFBYSxHQUFHLE9BQU8sRUFBRSxRQUFRLEVBQUUsS0FBSyxJQUFLLEtBQUssQ0FBQyxJQUFZLEVBQUUsS0FBSyxDQUFBO1lBQzFFLE1BQU0saUJBQWlCLEdBQUcsT0FBTyxFQUFFLFFBQVEsRUFBRSxVQUFVLElBQUssS0FBSyxDQUFDLElBQVksRUFBRSxVQUFVLENBQUE7WUFDMUYsTUFBTSxnQkFBZ0IsR0FBRyxPQUFPLEVBQUUsUUFBUSxFQUFFLFNBQVMsSUFBSyxLQUFLLENBQUMsSUFBWSxFQUFFLFNBQVMsQ0FBQTtZQUN2RixNQUFNLG9CQUFvQixHQUFJLEtBQUssQ0FBQyxJQUFZLEVBQUUsYUFBYSxJQUFLLEtBQUssQ0FBQyxJQUFZLEVBQUUsSUFBSSxDQUFBO1lBRTVGLDBGQUEwRjtZQUMxRiw4REFBOEQ7WUFDOUQsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO2dCQUNqQixJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxpREFBaUQsU0FBUyxFQUFFLENBQUMsQ0FBQTtZQUNuRixDQUFDO1lBRUQsTUFBTSxZQUFZLEdBQUcsQ0FBQyxpQkFBaUI7Z0JBQ25DLENBQUMsQ0FBQyxHQUFHLGlCQUFpQixJQUFJLGdCQUFnQixJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksRUFBRTtnQkFDekQsQ0FBQyxDQUFDLG9CQUFvQixDQUF1QixDQUFBO1lBRWpELElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLHFDQUFxQyxhQUFhLElBQUksS0FBSyxtQkFBbUIsWUFBWSxJQUFJLEtBQUssRUFBRSxDQUFDLENBQUE7WUFFeEgsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2Isa0JBQWtCLFdBQVcsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxFQUFFLGVBQWUsU0FBUyxhQUFhLGFBQWEsSUFBSSxLQUFLLFdBQVcsWUFBWSxJQUFJLEtBQUssRUFBRSxDQUNqSixDQUFBO1lBRUQsSUFBSSxXQUFXLEVBQUUsQ0FBQztnQkFDZCxnRUFBZ0U7Z0JBQ2hFLE1BQU0sU0FBUyxHQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUUsU0FBMkMsSUFBSSwyQ0FBNkIsQ0FBQyxRQUFRLENBQUE7Z0JBRXBILCtEQUErRDtnQkFDL0Qsa0ZBQWtGO2dCQUNsRixNQUFNLFNBQVMsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFBO2dCQUM1QixRQUFRLFNBQVMsRUFBRSxDQUFDO29CQUNoQixLQUFLLDJDQUE2QixDQUFDLE9BQU87d0JBQ3RDLFNBQVMsQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLE9BQU8sRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFBO3dCQUMxQyxNQUFLO29CQUNULEtBQUssMkNBQTZCLENBQUMsUUFBUTt3QkFDdkMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsUUFBUSxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUE7d0JBQzVDLE1BQUs7b0JBQ1QsS0FBSywyQ0FBNkIsQ0FBQyxXQUFXO3dCQUMxQyxTQUFTLENBQUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxRQUFRLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQTt3QkFDNUMsTUFBSztvQkFDVCxLQUFLLDJDQUE2QixDQUFDLE9BQU87d0JBQ3RDLFNBQVMsQ0FBQyxXQUFXLENBQUMsU0FBUyxDQUFDLFdBQVcsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFBO3dCQUNsRCxNQUFLO29CQUNUO3dCQUNJLFNBQVMsQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLFFBQVEsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFBO2dCQUNwRCxDQUFDO2dCQUVELDhFQUE4RTtnQkFDOUUsK0NBQStDO2dCQUMvQyxNQUFNLFNBQVMsR0FBRyxTQUFTLENBQUMsTUFBTSxFQUFFLENBQUE7Z0JBQ3BDLElBQUksU0FBUyxLQUFLLENBQUM7b0JBQUUsU0FBUyxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsT0FBTyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUEsQ0FBQyxrQkFBa0I7Z0JBQ2xGLElBQUksU0FBUyxLQUFLLENBQUM7b0JBQUUsU0FBUyxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsT0FBTyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUEsQ0FBQyxvQkFBb0I7Z0JBRXBGLDBDQUEwQztnQkFDMUMsTUFBTSxPQUFPLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQTtnQkFDMUIsSUFBSSxRQUFRLEdBQUcsQ0FBQyxDQUFBO2dCQUNoQixPQUFPLFFBQVEsR0FBRyxDQUFDLEVBQUUsQ0FBQztvQkFDbEIsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUE7b0JBQ3RDLE1BQU0sQ0FBQyxHQUFHLE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQTtvQkFDMUIsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDO3dCQUFFLFFBQVEsRUFBRSxDQUFBO2dCQUN0QyxDQUFDO2dCQUNELElBQUksU0FBUyxHQUFHLE9BQU8sRUFBRSxDQUFDO29CQUN0QixTQUFTLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFBO2dCQUN4QyxDQUFDO2dCQUVELE1BQU0sZUFBZSxHQUFHLGFBQWEsQ0FBRSxLQUFLLENBQUMsSUFBWSxFQUFFLGdCQUFnQixDQUFDLENBQUE7Z0JBQzVFLE1BQU0sY0FBYyxHQUFHLGFBQWEsQ0FBRSxLQUFLLENBQUMsSUFBWSxFQUFFLGVBQWUsQ0FBQyxDQUFBO2dCQUUxRSxNQUFNLFFBQVEsR0FBRyxNQUFNLE1BQU0sQ0FBQyxnQ0FBZ0MsQ0FBQztvQkFDM0QsU0FBUztvQkFDVCxlQUFlLEVBQUUsZUFBZTtvQkFDaEMsb0JBQW9CLEVBQUUsU0FBUyxDQUFDLFdBQVcsRUFBRTtvQkFDN0MsZ0JBQWdCLEVBQUUsQ0FBQyxFQUFFLHdCQUF3QjtvQkFDN0MsU0FBUztvQkFDVCxvQkFBb0IsRUFBRSxlQUFlLEVBQUUscUJBQXFCO29CQUM1RCxXQUFXLEVBQUUsSUFBSSxDQUFDLGFBQWE7b0JBQy9CLFlBQVksRUFBRSxZQUFZLElBQUksVUFBVTtvQkFDeEMsYUFBYSxFQUFFLGFBQWEsSUFBSSxxQkFBcUI7aUJBQ3hELENBQUMsQ0FBQTtnQkFFRixNQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsTUFBTSxDQUFBO2dCQUUvQix5RUFBeUU7Z0JBQ3pFLElBQUksQ0FBQztvQkFDRCxNQUFNLE1BQU0sQ0FBQywwQkFBMEIsQ0FBQyxPQUFPLENBQUMsRUFBRSxFQUFFO3dCQUNoRCxJQUFJLEVBQUUsa0JBQWtCLFNBQVMsRUFBRTt3QkFDbkMsVUFBVSxFQUFFLFlBQVk7cUJBQzNCLENBQUMsQ0FBQTtvQkFDRixJQUFJLGVBQWUsRUFBRSxDQUFDO3dCQUNsQixNQUFNLE1BQU0sQ0FBQywwQkFBMEIsQ0FBQyxPQUFPLENBQUMsRUFBRSxFQUFFOzRCQUNoRCxJQUFJLEVBQUUsYUFBYSxlQUFlLEVBQUU7NEJBQ3BDLFVBQVUsRUFBRSxZQUFZO3lCQUMzQixDQUFDLENBQUE7b0JBQ04sQ0FBQztvQkFDRCxJQUFJLGNBQWMsRUFBRSxDQUFDO3dCQUNqQixNQUFNLE1BQU0sQ0FBQywwQkFBMEIsQ0FBQyxPQUFPLENBQUMsRUFBRSxFQUFFOzRCQUNoRCxJQUFJLEVBQUUsWUFBWSxjQUFjLEVBQUU7NEJBQ2xDLFVBQVUsRUFBRSxZQUFZO3lCQUMzQixDQUFDLENBQUE7b0JBQ04sQ0FBQztnQkFDTCxDQUFDO2dCQUFDLE9BQU8sT0FBZ0IsRUFBRSxDQUFDO29CQUN4QixJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyw2Q0FBNkMsT0FBTyxDQUFDLEVBQUUsS0FBSyxJQUFBLDZCQUFlLEVBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxDQUFBO2dCQUM3RyxDQUFDO2dCQUNELE9BQU87b0JBQ0gsRUFBRSxFQUFFLE9BQU8sQ0FBQyxFQUFFO29CQUNkLElBQUksRUFBRTt3QkFDRixHQUFHLEtBQUssQ0FBQyxJQUFJO3dCQUNiLGVBQWUsRUFBRSxPQUFPLENBQUMsRUFBRTt3QkFDM0IsaUJBQWlCLEVBQUUsT0FBTyxDQUFDLEVBQUU7d0JBQzdCLGlCQUFpQixFQUFFLE9BQU8sQ0FBQyxJQUFJO3dCQUMvQixpQkFBaUIsRUFBRSxPQUFPLENBQUMsVUFBVTt3QkFDckMsbUJBQW1CLEVBQUUsT0FBTyxDQUFDLE1BQU07d0JBQ25DLGNBQWMsRUFBRSxTQUFTO3dCQUN6QixZQUFZLEVBQUUsSUFBSTt3QkFDbEIsYUFBYTt3QkFDYixVQUFVLEVBQUUsU0FBUzt3QkFDckIsVUFBVSxFQUFFLFNBQVM7cUJBQ3hCO2lCQUNKLENBQUE7WUFDTCxDQUFDO1lBR0QsTUFBTSxlQUFlLEdBQUcsYUFBYSxDQUFFLEtBQUssQ0FBQyxJQUFZLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQTtZQUM1RSxNQUFNLGNBQWMsR0FBRyxhQUFhLENBQUUsS0FBSyxDQUFDLElBQVksRUFBRSxlQUFlLENBQUMsQ0FBQTtZQUUxRSxNQUFNLEtBQUssR0FBVSxFQUFFLENBQUE7WUFDdkIsb0VBQW9FO1lBQ3BFLG1FQUFtRTtZQUNuRSxpRUFBaUU7WUFDakUsc0RBQXNEO1lBQ3RELEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsa0JBQWtCLFNBQVMsRUFBRSxFQUFFLFVBQVUsRUFBRSxZQUFZLEVBQUUsQ0FBQyxDQUFBO1lBQzdFLElBQUksZUFBZTtnQkFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLGFBQWEsZUFBZSxFQUFFLEVBQUUsVUFBVSxFQUFFLFlBQVksRUFBRSxDQUFDLENBQUE7WUFDbkcsSUFBSSxjQUFjO2dCQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsWUFBWSxjQUFjLEVBQUUsRUFBRSxVQUFVLEVBQUUsWUFBWSxFQUFFLENBQUMsQ0FBQTtZQUVoRyxpRUFBaUU7WUFDakUsZ0VBQWdFO1lBQ2hFLDBEQUEwRDtZQUMxRCwrREFBK0Q7WUFDL0Qsc0JBQXNCO1lBQ3RCLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFTLEVBQUUsSUFBSSxFQUFFLENBQUE7WUFDeEMsTUFBTSxXQUFXLEdBQUcsU0FBUztnQkFDekIsQ0FBQyxDQUFDLEdBQUcsU0FBUyxnQkFBZ0IsU0FBUyxFQUFFO2dCQUN6QyxDQUFDLENBQUMsZUFBZSxTQUFTLEVBQUUsQ0FBQTtZQUVoQywwQkFBMEI7WUFDMUIsTUFBTSxRQUFRLEdBQUcsTUFBTSxNQUFNLENBQUMsdUJBQXVCLENBQUM7Z0JBQ2xELFNBQVM7Z0JBQ1QsTUFBTSxFQUFFLGVBQWU7Z0JBQ3ZCLFdBQVcsRUFBRSxJQUFJLENBQUMsYUFBYTtnQkFDL0IsYUFBYSxFQUFFLElBQUksQ0FBQyxhQUFhLElBQUksK0JBQWlCLENBQUMsTUFBTTtnQkFDN0QsWUFBWTtnQkFDWixhQUFhO2dCQUNiLGlCQUFpQixFQUFFLElBQUksQ0FBQyxXQUFXO29CQUMvQixDQUFDLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsV0FBVyxFQUFFLFNBQVMsQ0FBQztvQkFDbEQsQ0FBQyxDQUFDLFNBQVM7Z0JBQ2YsV0FBVztnQkFDWCxLQUFLO2FBQ1IsQ0FBQyxDQUFBO1lBRUYsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQTtZQUUvQixJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FDYiwrQkFBK0IsT0FBTyxDQUFDLEVBQUUsV0FBVyxPQUFPLENBQUMsSUFBSSxXQUFXLFNBQVMsR0FBRyxDQUMxRixDQUFBO1lBRUQsT0FBTztnQkFDSCxFQUFFLEVBQUUsT0FBTyxDQUFDLEVBQUU7Z0JBQ2QsSUFBSSxFQUFFO29CQUNGLEdBQUcsS0FBSyxDQUFDLElBQUk7b0JBQ2IsZUFBZSxFQUFFLE9BQU8sQ0FBQyxFQUFFO29CQUMzQixpQkFBaUIsRUFBRSxPQUFPLENBQUMsSUFBSTtvQkFDL0IsaUJBQWlCLEVBQUUsT0FBTyxDQUFDLFVBQVU7b0JBQ3JDLG1CQUFtQixFQUFFLE9BQU8sQ0FBQyxNQUFNO29CQUNuQyxjQUFjLEVBQUUsU0FBUztvQkFDekIsYUFBYTtvQkFDYixVQUFVLEVBQUUsU0FBUztpQkFDeEI7YUFDSixDQUFBO1FBQ0wsQ0FBQztRQUFDLE9BQU8sS0FBYyxFQUFFLENBQUM7WUFDdEIsTUFBTSxHQUFHLEdBQUcsSUFBQSw2QkFBZSxFQUFDLEtBQUssQ0FBQyxDQUFBO1lBQ2xDLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLGtDQUFrQyxHQUFHLEVBQUUsQ0FBQyxDQUFBO1lBQzNELE1BQU0sSUFBSSxtQkFBVyxDQUNqQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxnQkFBZ0IsRUFDbEMsb0NBQW9DLEdBQUcsRUFBRSxDQUM1QyxDQUFBO1FBQ0wsQ0FBQztJQUNMLENBQUM7SUFFRCx5REFBeUQ7SUFDekQsbUJBQW1CO0lBQ25CLHlEQUF5RDtJQUV6RDs7O09BR0c7SUFDSCxLQUFLLENBQUMsZ0JBQWdCLENBQ2xCLEtBQTRCO1FBRTVCLE1BQU0sRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLEdBQUcsS0FBSyxDQUFBO1FBQy9CLE1BQU0sYUFBYSxHQUFHLGFBQWEsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLENBQUMsSUFBSSxhQUFhLENBQUMsSUFBSSxFQUFFLG1CQUFtQixDQUFDLENBQUE7UUFFeEcsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ2pCLE1BQU0sSUFBSSxtQkFBVyxDQUNqQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLCtDQUErQyxDQUNsRCxDQUFBO1FBQ0wsQ0FBQztRQUVELCtEQUErRDtRQUMvRCxtRUFBbUU7UUFDbkUsa0VBQWtFO1FBQ2xFLG1FQUFtRTtRQUNuRSxNQUFNLEVBQUUsTUFBTSxFQUFFLEdBQUcsTUFBTSxJQUFJLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFBO1FBRW5ELElBQUksQ0FBQztZQUNELGlEQUFpRDtZQUNqRCxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsSUFBSSxFQUFFLFVBQVUsSUFBSyxLQUFLLENBQUMsT0FBZSxFQUFFLFVBQVUsQ0FBQTtZQUM5RSxNQUFNLFlBQVksR0FBRyxLQUFLLENBQUMsSUFBSSxFQUFFLFdBQVcsSUFBSyxLQUFLLENBQUMsT0FBZSxFQUFFLFdBQVcsQ0FBQTtZQUVuRixJQUFJLFNBQVMsSUFBSSxZQUFZLEVBQUUsQ0FBQztnQkFDNUIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsMkJBQTJCLFNBQVMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxhQUFhLDBCQUEwQixhQUFhLEVBQUUsQ0FBQyxDQUFBO2dCQUU1SCxJQUFJLFNBQVMsRUFBRSxDQUFDO29CQUNaLE9BQU87d0JBQ0gsSUFBSSxFQUFFOzRCQUNGLEdBQUcsS0FBSyxDQUFDLElBQUk7NEJBQ2IsbUJBQW1CLEVBQUUsTUFBTTt5QkFDOUI7d0JBQ0QsTUFBTSxFQUFFLFVBQWtDO3FCQUM3QyxDQUFBO2dCQUNMLENBQUM7Z0JBRUQsMkRBQTJEO2dCQUMzRCx5RUFBeUU7Z0JBQ3pFLE1BQU0sT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDLHFCQUFxQixDQUFDLGFBQWEsRUFBRSxNQUFNLENBQUMsQ0FBQTtnQkFDdkUsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLHFCQUFxQixDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQTtnQkFFekQsT0FBTztvQkFDSCxJQUFJLEVBQUU7d0JBQ0YsR0FBRyxLQUFLLENBQUMsSUFBSTt3QkFDYixtQkFBbUIsRUFBRSxPQUFPLENBQUMsTUFBTTtxQkFDdEM7b0JBQ0QsTUFBTTtpQkFDVCxDQUFBO1lBQ0wsQ0FBQztZQUVELE1BQU0sT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDLHFCQUFxQixDQUFDLGFBQWEsRUFBRSxNQUFNLENBQUMsQ0FBQTtZQUV2RSwrRUFBK0U7WUFDL0Usa0VBQWtFO1lBQ2xFLCtFQUErRTtZQUMvRSwrRUFBK0U7WUFDL0UsZ0VBQWdFO1lBQ2hFLE1BQU0sc0JBQXNCLEdBQ3ZCLE9BQWdDLENBQUMsY0FBYyxFQUFFLE1BQU0sS0FBSyxNQUFNLENBQUE7WUFDdkUsTUFBTSxlQUFlLEdBQUcsc0JBQXNCLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQTtZQUN4RSxNQUFNLFVBQVUsR0FBRyxlQUFlLENBQUMsV0FBVyxFQUFFLENBQUE7WUFDaEQsTUFBTSxpQkFBaUIsR0FBRyxDQUFDLE1BQU0sRUFBRSxRQUFRLEVBQUUsY0FBYyxFQUFFLG1CQUFtQixDQUFDLENBQUE7WUFDakYsTUFBTSxXQUFXLEdBQUcsaUJBQWlCLENBQUMsUUFBUSxDQUFDLFVBQVUsQ0FBQyxDQUFBO1lBQzFELE1BQU0sTUFBTSxHQUFHLFVBQVUsS0FBSyxNQUFNLElBQUksVUFBVSxLQUFLLCtCQUFpQixDQUFDLElBQUksQ0FBQTtZQUU3RSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FDYix1Q0FBdUMsYUFBYSxrQkFBa0IsT0FBTyxDQUFDLE1BQU0sa0JBQWtCLHNCQUFzQixnQkFBZ0IsV0FBVyxhQUFhLE1BQU0sRUFBRSxDQUMvSyxDQUFBO1lBRUQsT0FBTztnQkFDSCxJQUFJLEVBQUU7b0JBQ0YsR0FBRyxLQUFLLENBQUMsSUFBSTtvQkFDYixtQkFBbUIsRUFBRSxPQUFPLENBQUMsTUFBTTtpQkFDdEM7Z0JBQ0QsTUFBTSxFQUFFLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBeUI7YUFDM0UsQ0FBQTtRQUNMLENBQUM7UUFBQyxPQUFPLEtBQWMsRUFBRSxDQUFDO1lBQ3RCLE1BQU0sR0FBRyxHQUFHLElBQUEsNkJBQWUsRUFBQyxLQUFLLENBQUMsQ0FBQTtZQUNsQyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxtQ0FBbUMsR0FBRyxFQUFFLENBQUMsQ0FBQTtZQUM1RCxNQUFNLElBQUksbUJBQVcsQ0FDakIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLEVBQ2xDLHFDQUFxQyxHQUFHLEVBQUUsQ0FDN0MsQ0FBQTtRQUNMLENBQUM7SUFDTCxDQUFDO0lBRUQseURBQXlEO0lBQ3pELGlCQUFpQjtJQUNqQix5REFBeUQ7SUFFekQ7Ozs7T0FJRztJQUNILEtBQUssQ0FBQyxjQUFjLENBQ2hCLEtBQTBCO1FBRTFCLE1BQU0sYUFBYSxHQUFHLGFBQWEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGlCQUFpQixDQUFDLElBQUksYUFBYSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLENBQUMsQ0FBQTtRQUVwSCxJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7WUFDakIsT0FBTyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUE7UUFDL0IsQ0FBQztRQUVELE1BQU0sRUFBRSxNQUFNLEVBQUUsR0FBRyxNQUFNLElBQUksQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFDLENBQUE7UUFFbkQsSUFBSSxDQUFDO1lBQ0QsTUFBTSxPQUFPLEdBQUcsTUFBTSxJQUFJLENBQUMscUJBQXFCLENBQUMsYUFBYSxFQUFFLE1BQU0sQ0FBQyxDQUFBO1lBRXZFLDhFQUE4RTtZQUM5RSxpRkFBaUY7WUFDakYsK0VBQStFO1lBQy9FLG9FQUFvRTtZQUNwRSxNQUFNLHNCQUFzQixHQUN2QixPQUFnQyxDQUFDLGNBQWMsRUFBRSxNQUFNLEtBQUssTUFBTSxDQUFBO1lBRXZFLElBQ0ksc0JBQXNCO2dCQUN0QixPQUFPLENBQUMsTUFBTSxLQUFLLCtCQUFpQixDQUFDLElBQUk7Z0JBQ3pDLE9BQU8sQ0FBQyxNQUFNLEtBQUssUUFBUTtnQkFDM0IsT0FBTyxDQUFDLE1BQU0sS0FBSyxjQUFjLEVBQ25DLENBQUM7Z0JBQ0MsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2IsaUJBQWlCLGFBQWEsK0NBQStDLHNCQUFzQixHQUFHLENBQ3pHLENBQUE7Z0JBQ0QsT0FBTztvQkFDSCxJQUFJLEVBQUU7d0JBQ0YsR0FBRyxLQUFLLENBQUMsSUFBSTt3QkFDYixtQkFBbUIsRUFBRSxPQUFPLENBQUMsTUFBTTtxQkFDdEM7aUJBQ0osQ0FBQTtZQUNMLENBQUM7WUFFRCxtRUFBbUU7WUFDbkUsa0VBQWtFO1lBQ2xFLG9FQUFvRTtZQUNwRSx5Q0FBeUM7WUFDekMsTUFBTSxHQUFHLEdBQUcseUNBQXlDLGFBQWEsZUFBZSxPQUFPLENBQUMsTUFBTSw2Q0FBNkMsQ0FBQTtZQUM1SSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQTtZQUN0QixNQUFNLElBQUksbUJBQVcsQ0FBQyxtQkFBVyxDQUFDLEtBQUssQ0FBQywyQkFBMkIsRUFBRSxHQUFHLENBQUMsQ0FBQTtRQUM3RSxDQUFDO1FBQUMsT0FBTyxLQUFjLEVBQUUsQ0FBQztZQUN0QixvRkFBb0Y7WUFDcEYsTUFBTSxhQUFhLEdBQUcsS0FBSyxZQUFZLG1CQUFXO2dCQUM3QyxLQUFhLEVBQUUsSUFBSSxLQUFLLGFBQWE7Z0JBQ3JDLEtBQWEsRUFBRSxXQUFXLEVBQUUsSUFBSSxLQUFLLGFBQWEsQ0FBQTtZQUV2RCxJQUFJLGFBQWEsRUFBRSxDQUFDO2dCQUNoQixNQUFNLEtBQUssQ0FBQTtZQUNmLENBQUM7WUFFRCxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyx3Q0FBd0MsSUFBQSw2QkFBZSxFQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQTtZQUNwRiwwRUFBMEU7WUFDMUUsTUFBTSxLQUFLLENBQUE7UUFDZixDQUFDO0lBQ0wsQ0FBQztJQUVELHlEQUF5RDtJQUN6RCxnQkFBZ0I7SUFDaEIseURBQXlEO0lBRXpEOzs7O09BSUc7SUFDSCxLQUFLLENBQUMsYUFBYSxDQUNmLEtBQXlCO1FBRXpCLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLDZCQUE2QixhQUFhLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxpQkFBaUIsQ0FBQyxJQUFJLFNBQVMsRUFBRSxDQUMzRixDQUFBO1FBQ0QsT0FBTztZQUNILElBQUksRUFBRTtnQkFDRixHQUFHLEtBQUssQ0FBQyxJQUFJO2dCQUNiLG1CQUFtQixFQUFFLCtCQUFpQixDQUFDLFNBQVM7YUFDbkQ7U0FDSixDQUFBO0lBQ0wsQ0FBQztJQUVELHlEQUF5RDtJQUN6RCxnQkFBZ0I7SUFDaEIseURBQXlEO0lBRXpEOzs7T0FHRztJQUNILEtBQUssQ0FBQyxhQUFhLENBQ2YsS0FBeUI7UUFFekIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2IsNkJBQTZCLGFBQWEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGlCQUFpQixDQUFDLElBQUksU0FBUyxFQUFFLENBQzNGLENBQUE7UUFDRCxPQUFPLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQTtJQUMvQixDQUFDO0lBRUQseURBQXlEO0lBQ3pELGdCQUFnQjtJQUNoQix5REFBeUQ7SUFFekQ7Ozs7T0FJRztJQUNILEtBQUssQ0FBQyxhQUFhLENBQ2YsS0FBeUI7UUFFekIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2IsdUZBQXVGLGFBQWEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGlCQUFpQixDQUFDLElBQUksU0FBUyxhQUFhLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FDOUssQ0FBQTtRQUNELE9BQU87WUFDSCxJQUFJLEVBQUU7Z0JBQ0YsR0FBRyxLQUFLLENBQUMsSUFBSTtnQkFDYixXQUFXLEVBQ1AsbUVBQW1FO2FBQzFFO1NBQ0osQ0FBQTtJQUNMLENBQUM7SUFFRCx5REFBeUQ7SUFDekQsa0JBQWtCO0lBQ2xCLHlEQUF5RDtJQUV6RDs7T0FFRztJQUNILEtBQUssQ0FBQyxlQUFlLENBQ2pCLEtBQTJCO1FBRTNCLE1BQU0sYUFBYSxHQUFHLGFBQWEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGlCQUFpQixDQUFDLENBQUE7UUFFbEUsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ2pCLE9BQU8sRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFBO1FBQy9CLENBQUM7UUFFRCxNQUFNLEVBQUUsTUFBTSxFQUFFLEdBQUcsTUFBTSxJQUFJLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFBO1FBRW5ELElBQUksQ0FBQztZQUNELE1BQU0sT0FBTyxHQUFHLE1BQU0sTUFBTSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQTtZQUN0RCxPQUFPO2dCQUNILElBQUksRUFBRTtvQkFDRixHQUFHLEtBQUssQ0FBQyxJQUFJO29CQUNiLGVBQWUsRUFBRSxPQUFPLENBQUMsRUFBRTtvQkFDM0IsbUJBQW1CLEVBQUUsT0FBTyxDQUFDLE1BQU07b0JBQ25DLGNBQWMsRUFBRSxPQUFPLENBQUMsU0FBUztvQkFDakMsTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFNO29CQUN0QixRQUFRLEVBQUUsT0FBTyxDQUFDLFFBQVE7aUJBQzdCO2FBQ0osQ0FBQTtRQUNMLENBQUM7UUFBQyxPQUFPLEtBQWMsRUFBRSxDQUFDO1lBQ3RCLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLGtDQUFrQyxJQUFBLDZCQUFlLEVBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFBO1lBQzlFLE9BQU8sRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFBO1FBQy9CLENBQUM7SUFDTCxDQUFDO0lBRUQseURBQXlEO0lBQ3pELGdCQUFnQjtJQUNoQix5REFBeUQ7SUFFekQ7Ozs7T0FJRztJQUNILEtBQUssQ0FBQyxhQUFhLENBQ2YsS0FBeUI7UUFFekIsTUFBTSxFQUFFLE1BQU0sRUFBRSxhQUFhLEVBQUUsR0FBRyxLQUFLLENBQUE7UUFFdkMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2IsNkJBQTZCLGFBQWEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGlCQUFpQixDQUFDLElBQUksU0FBUyxhQUFhLE1BQU0sRUFBRSxDQUM5RyxDQUFBO1FBRUQsMkRBQTJEO1FBQzNELDhEQUE4RDtRQUM5RCwrREFBK0Q7UUFDL0QsK0RBQStEO1FBQy9ELHNDQUFzQztRQUN0QyxPQUFPO1lBQ0gsSUFBSSxFQUFFO2dCQUNGLEdBQUcsS0FBSyxDQUFDLElBQUk7Z0JBQ2IsR0FBRyxDQUFDLE1BQU0sS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQyxRQUFRLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7Z0JBQzlELEdBQUcsQ0FBQyxhQUFhLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLGFBQWEsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7YUFDNUQ7U0FDSixDQUFBO0lBQ0wsQ0FBQztJQUVELHlEQUF5RDtJQUN6RCxtQkFBbUI7SUFDbkIseURBQXlEO0lBRXpEOztPQUVHO0lBQ0gsS0FBSyxDQUFDLGdCQUFnQixDQUNsQixLQUE0QjtRQUU1QixNQUFNLGFBQWEsR0FBRyxhQUFhLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxpQkFBaUIsQ0FBQyxDQUFBO1FBRWxFLElBQUksQ0FBQyxhQUFhLEVBQUUsQ0FBQztZQUNqQixPQUFPLEVBQUUsTUFBTSxFQUFFLFNBQWlDLEVBQUUsQ0FBQTtRQUN4RCxDQUFDO1FBRUQsTUFBTSxFQUFFLE1BQU0sRUFBRSxHQUFHLE1BQU0sSUFBSSxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsQ0FBQTtRQUVuRCxJQUFJLENBQUM7WUFDRCxNQUFNLE9BQU8sR0FBRyxNQUFNLE1BQU0sQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLENBQUE7WUFDdEQsT0FBTyxFQUFFLE1BQU0sRUFBRSxJQUFJLENBQUMscUJBQXFCLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUE7UUFDakUsQ0FBQztRQUFDLE9BQU8sS0FBYyxFQUFFLENBQUM7WUFDdEIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsbUNBQW1DLElBQUEsNkJBQWUsRUFBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUE7WUFDL0UsT0FBTyxFQUFFLE1BQU0sRUFBRSxTQUFpQyxFQUFFLENBQUE7UUFDeEQsQ0FBQztJQUNMLENBQUM7SUFFRCx5REFBeUQ7SUFDekQsMEJBQTBCO0lBQzFCLHlEQUF5RDtJQUV6RDs7O09BR0c7SUFDSCxLQUFLLENBQUMsdUJBQXVCLENBQ3pCLE9BQTBDO1FBRTFDLElBQUksQ0FBQztZQUNELE1BQU0sRUFBRSxJQUFJLEVBQUUsR0FBRyxPQUFPLENBQUE7WUFFeEIsdUNBQXVDO1lBQ3ZDLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLENBQUMsQ0FBQTtZQUVuRCxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7Z0JBQ2YsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsK0NBQStDLENBQUMsQ0FBQTtnQkFDbEUsT0FBTztvQkFDSCxNQUFNLEVBQUUsc0JBQWMsQ0FBQyxhQUFhO29CQUNwQyxJQUFJLEVBQUU7d0JBQ0YsVUFBVSxFQUFFLEVBQUU7d0JBQ2QsTUFBTSxFQUFFLElBQUksaUJBQVMsQ0FBQyxDQUFDLENBQUM7cUJBQzNCO2lCQUNKLENBQUE7WUFDTCxDQUFDO1lBRUQsTUFBTSxFQUFFLEVBQUUsRUFBRSxhQUFhLEVBQUUsTUFBTSxFQUFFLGFBQWEsRUFBRSxNQUFNLEVBQUUsU0FBUyxFQUFFLEdBQUcsV0FBVyxDQUFBO1lBRW5GLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLHlCQUF5QixhQUFhLGNBQWMsYUFBYSxVQUFVLFNBQVMsRUFBRSxDQUN6RixDQUFBO1lBRUQsa0ZBQWtGO1lBQ2xGLDJFQUEyRTtZQUMzRSw0RUFBNEU7WUFDNUUsSUFBSSxTQUFTLEdBQUcsRUFBRSxDQUFBO1lBQ2xCLGdGQUFnRjtZQUNoRixJQUFJLGVBQWUsR0FBRyxhQUFhLENBQUE7WUFFbkMsNkRBQTZEO1lBQzdELDREQUE0RDtZQUM1RCwwREFBMEQ7WUFDMUQseURBQXlEO1lBQ3pELHdEQUF3RDtZQUN4RCwwREFBMEQ7WUFDMUQsb0RBQW9EO1lBQ3BELE1BQU0sZ0JBQWdCLEdBQUcsV0FBVyxDQUFDLFVBQVUsS0FBSyxvQkFBb0IsQ0FBQTtZQUV4RSxJQUFJLGdCQUFnQixFQUFFLENBQUM7Z0JBQ25CLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLGtDQUFrQyxXQUFXLENBQUMsU0FBUyxTQUFTLGFBQWEsRUFBRSxDQUNsRixDQUFBO2dCQUVELGlFQUFpRTtnQkFDakUsSUFBSSxDQUFDO29CQUNELE1BQU0sSUFBSSxDQUFDLGdDQUFnQyxDQUN2QyxhQUFhLEVBQ2IsV0FBVyxDQUFDLFNBQVMsSUFBSSxFQUFFLEVBQzNCLFdBQVcsQ0FBQyxNQUFnQixDQUMvQixDQUFBO2dCQUNMLENBQUM7Z0JBQUMsT0FBTyxHQUFRLEVBQUUsQ0FBQztvQkFDaEIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2QsOENBQThDLEdBQUcsQ0FBQyxPQUFPLEVBQUUsQ0FDOUQsQ0FBQTtnQkFDTCxDQUFDO2dCQUVELE9BQU87b0JBQ0gsTUFBTSxFQUFFLHNCQUFjLENBQUMsYUFBYTtvQkFDcEMsSUFBSSxFQUFFO3dCQUNGLFVBQVUsRUFBRSxFQUFFO3dCQUNkLE1BQU0sRUFBRSxJQUFJLGlCQUFTLENBQUMsTUFBTSxJQUFJLENBQUMsQ0FBQztxQkFDckM7aUJBQ0osQ0FBQTtZQUNMLENBQUM7WUFFRCwrREFBK0Q7WUFDL0QsZ0VBQWdFO1lBQ2hFLDhEQUE4RDtZQUM5RCwrREFBK0Q7WUFDL0QsNkRBQTZEO1lBQzdELHNCQUFzQjtZQUN0QixNQUFNLGdCQUFnQixHQUFHLE1BQU0sSUFBSSxDQUFDLHNCQUFzQixDQUFDLGFBQWEsQ0FBQyxDQUFBO1lBQ3pFLE1BQU0sYUFBYSxHQUFHLGdCQUFnQixFQUFFLEdBQUcsQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE9BQU8sQ0FBQTtZQUNsRSxJQUFJLGdCQUFnQixFQUFFLENBQUM7Z0JBQ25CLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLHlCQUF5QixhQUFhLG1CQUFtQixnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLENBQ3ZGLENBQUE7WUFDTCxDQUFDO2lCQUFNLENBQUM7Z0JBQ0osSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2IsMkRBQTJELGFBQWEsNkNBQTZDLENBQ3hILENBQUE7WUFDTCxDQUFDO1lBRUQsSUFBSSxDQUFDO2dCQUNELDJCQUEyQjtnQkFDM0IsSUFBSSxDQUFDO29CQUNELE1BQU0sT0FBTyxHQUNULGdCQUFnQixFQUFFLElBQUksS0FBSyxRQUFRO3dCQUMvQixDQUFDLENBQUMsZ0JBQWdCLENBQUMsT0FBTzt3QkFDMUIsQ0FBQyxDQUFDLE1BQU0sYUFBYSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQTtvQkFDdkQsZUFBZSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUE7b0JBRWhDLG9EQUFvRDtvQkFDcEQsdURBQXVEO29CQUN2RCxxREFBcUQ7b0JBQ3JELE1BQU0sV0FBVyxHQUFJLE9BQWUsQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLENBQzlDLENBQUMsQ0FBTSxFQUFFLEVBQUUsQ0FDUCxPQUFPLENBQUMsRUFBRSxJQUFJLEtBQUssUUFBUTt3QkFDM0IsQ0FBQyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsaUJBQWlCLENBQUMsQ0FDM0MsQ0FBQTtvQkFDRCxJQUFJLFdBQVcsRUFBRSxDQUFDO3dCQUNkLFNBQVMsR0FBRyxNQUFNLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssQ0FDdEMsaUJBQWlCLENBQUMsTUFBTSxDQUMzQixDQUFBO3dCQUNELElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLGlEQUFpRCxTQUFTLEVBQUUsQ0FDL0QsQ0FBQTtvQkFDTCxDQUFDO3lCQUFNLENBQUM7d0JBQ0osTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLFdBQVcsRUFBRSxLQUFLLENBQ3hDLDZCQUE2QixDQUNoQyxDQUFBO3dCQUNELElBQUksU0FBUyxFQUFFLENBQUM7NEJBQ1osU0FBUyxHQUFHLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQTs0QkFDeEIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2IsaUVBQWlFLFNBQVMsRUFBRSxDQUMvRSxDQUFBO3dCQUNMLENBQUM7b0JBQ0wsQ0FBQztnQkFDTCxDQUFDO2dCQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7b0JBQ1Qsd0JBQXdCO29CQUN4QixNQUFNLFNBQVMsR0FDWCxnQkFBZ0IsRUFBRSxJQUFJLEtBQUssV0FBVzt3QkFDbEMsQ0FBQyxDQUFDLGdCQUFnQixDQUFDLE9BQU87d0JBQzFCLENBQUMsQ0FBQyxNQUFNLGFBQWEsQ0FBQyxtQkFBbUIsQ0FBQyxhQUFhLENBQUMsQ0FBQTtvQkFDaEUsZUFBZSxHQUFHLFNBQVMsQ0FBQyxNQUFNLENBQUE7b0JBRWxDLGdGQUFnRjtvQkFDaEYsTUFBTSxXQUFXLEdBQUcsU0FBUyxDQUFDLFlBQVksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFNLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsVUFBVSxDQUFDLGlCQUFpQixDQUFDLENBQUM7d0JBQzFHLFNBQWlCLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQU0sRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxVQUFVLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxDQUFBO29CQUVyRixJQUFJLFdBQVcsRUFBRSxDQUFDO3dCQUNkLE1BQU0sS0FBSyxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLHFCQUFxQixDQUFDLENBQUE7d0JBQzNELFNBQVMsR0FBRyxLQUFLLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUE7d0JBQzVCLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLDREQUE0RCxTQUFTLEVBQUUsQ0FBQyxDQUFBO29CQUM5RixDQUFDO2dCQUNMLENBQUM7Z0JBRUQsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO29CQUNiLG9FQUFvRTtvQkFDcEUseUVBQXlFO29CQUN6RSwwRUFBMEU7b0JBQzFFLHdFQUF3RTtvQkFDeEUsc0VBQXNFO29CQUN0RSwyREFBMkQ7b0JBQzNELEVBQUU7b0JBQ0YsNkVBQTZFO29CQUM3RSwyRUFBMkU7b0JBQzNFLDRFQUE0RTtvQkFDNUUsdUVBQXVFO29CQUN2RSxJQUFJLENBQUM7d0JBQ0QsTUFBTSxxQkFBcUIsR0FBUSxJQUFJLENBQUMsVUFBVSxDQUFDLHVCQUF1QixDQUFDLENBQUE7d0JBQzNFLElBQUksQ0FBQyxxQkFBcUIsRUFBRSxDQUFDOzRCQUN6QixNQUFNLElBQUksS0FBSyxDQUFDLDJEQUEyRCxDQUFDLENBQUE7d0JBQ2hGLENBQUM7d0JBQ0QsTUFBTSxlQUFlLEdBQVUsTUFBTSxxQkFBcUIsQ0FBQyxJQUFJLENBQzNELEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxFQUNyQixFQUFFLElBQUksRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEVBQUUsVUFBVSxFQUFFLE1BQU0sRUFBRSxFQUFFLENBQzlDLENBQUE7d0JBQ0QsTUFBTSxhQUFhLEdBQUcsTUFBTSxDQUFDLE1BQU0sSUFBSSxDQUFDLENBQUMsQ0FBQTt3QkFDekMsTUFBTSxLQUFLLEdBQUcsZUFBZSxDQUFDLElBQUksQ0FDOUIsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUNGLENBQUMsQ0FBQyxXQUFXLEVBQUUsV0FBVyxFQUFFLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQzs0QkFDN0MsQ0FBQyxDQUFDLElBQUksRUFBRSxjQUFjLEtBQUssU0FBUzs0QkFDcEMsTUFBTSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxhQUFhLENBQ3pDLENBQUE7d0JBQ0QsSUFBSSxLQUFLLEVBQUUsRUFBRSxFQUFFLENBQUM7NEJBQ1osU0FBUyxHQUFHLEtBQUssQ0FBQyxFQUFFLENBQUE7NEJBQ3BCLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLHlFQUF5RSxTQUFTLFlBQVksYUFBYSxNQUFNLFNBQVMsYUFBYSxlQUFlLENBQUMsTUFBTSxXQUFXLENBQzNLLENBQUE7d0JBQ0wsQ0FBQzs2QkFBTSxDQUFDOzRCQUNKLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLG9EQUFvRCxTQUFTLFlBQVksYUFBYSxhQUFhLGVBQWUsQ0FBQyxNQUFNLFdBQVcsQ0FDdkksQ0FBQTt3QkFDTCxDQUFDO29CQUNMLENBQUM7b0JBQUMsT0FBTyxTQUFjLEVBQUUsQ0FBQzt3QkFDdEIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2IseUNBQXlDLFNBQVMsQ0FBQyxPQUFPLEVBQUUsQ0FDL0QsQ0FBQTtvQkFDTCxDQUFDO2dCQUNMLENBQUM7Z0JBRUQsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO29CQUNiLFNBQVMsR0FBRyxTQUFTLElBQUksRUFBRSxDQUFBO29CQUMzQixJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxnRUFBZ0UsU0FBUyxFQUFFLENBQUMsQ0FBQTtnQkFDbEcsQ0FBQztZQUNMLENBQUM7WUFBQyxPQUFPLEdBQVEsRUFBRSxDQUFDO2dCQUNoQixTQUFTLEdBQUcsU0FBUyxJQUFJLEVBQUUsQ0FBQTtZQUMvQixDQUFDO1lBRUQsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsc0NBQXNDLFNBQVMsdUJBQXVCLGVBQWUsRUFBRSxDQUFDLENBQUE7WUFFMUcsTUFBTSxXQUFXLEdBQUc7Z0JBQ2hCLFVBQVUsRUFBRSxTQUFTO2dCQUNyQixNQUFNLEVBQUUsSUFBSSxpQkFBUyxDQUFDLE1BQU0sSUFBSSxDQUFDLENBQUM7YUFDckMsQ0FBQTtZQUVELE1BQU0sZ0JBQWdCLEdBQUcsZUFBZSxDQUFDLFdBQVcsRUFBRSxDQUFBO1lBRXRELDhEQUE4RDtZQUM5RCxRQUFRLGdCQUFnQixFQUFFLENBQUM7Z0JBQ3ZCLEtBQUssUUFBUSxDQUFDO2dCQUNkLEtBQUssY0FBYyxDQUFDO2dCQUNwQixLQUFLLG1CQUFtQixDQUFDO2dCQUN6QixLQUFLLE1BQU0sQ0FBQztnQkFDWixLQUFLLCtCQUFpQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7b0JBQzFCLG1EQUFtRDtvQkFDbkQsbURBQW1EO29CQUNuRCxtREFBbUQ7b0JBQ25ELG1EQUFtRDtvQkFDbkQsTUFBTSxhQUFhLEdBQUcsTUFBTSxJQUFJLENBQUMsdUJBQXVCLENBQUM7d0JBQ3JELFNBQVM7d0JBQ1QsYUFBYTt3QkFDYixhQUFhLEVBQUUsU0FBUyxJQUFJLEVBQUU7d0JBQzlCLE1BQU0sRUFBRSxNQUFNLENBQUMsTUFBTSxJQUFJLENBQUMsQ0FBQzt3QkFDM0IsWUFBWSxFQUFFLFdBQVcsQ0FBQyxRQUFRLElBQUksS0FBSztxQkFDOUMsQ0FBQyxDQUFBO29CQUNGLElBQUksYUFBYSxFQUFFLENBQUM7d0JBQ2hCLE9BQU87NEJBQ0gsTUFBTSxFQUFFLHNCQUFjLENBQUMsYUFBYTs0QkFDcEMsSUFBSSxFQUFFLFdBQVc7eUJBQ3BCLENBQUE7b0JBQ0wsQ0FBQztvQkFDRCxPQUFPO3dCQUNILE1BQU0sRUFBRSxzQkFBYyxDQUFDLFVBQVU7d0JBQ2pDLElBQUksRUFBRSxXQUFXO3FCQUNwQixDQUFBO2dCQUNMLENBQUM7Z0JBRUQsS0FBSyxNQUFNLENBQUM7Z0JBQ1osS0FBSywrQkFBaUIsQ0FBQyxJQUFJO29CQUN2QixpRUFBaUU7b0JBQ2pFLGlFQUFpRTtvQkFDakUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsK0RBQStELENBQUMsQ0FBQTtvQkFDbEYsT0FBTzt3QkFDSCxNQUFNLEVBQUUsc0JBQWMsQ0FBQyxhQUFhO3dCQUNwQyxJQUFJLEVBQUUsV0FBVztxQkFDcEIsQ0FBQTtnQkFFTCxLQUFLLFNBQVMsQ0FBQztnQkFDZixLQUFLLCtCQUFpQixDQUFDLE9BQU87b0JBQzFCLDZEQUE2RDtvQkFDN0Qsb0VBQW9FO29CQUNwRSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxrRUFBa0UsQ0FBQyxDQUFBO29CQUNyRixPQUFPO3dCQUNILE1BQU0sRUFBRSxzQkFBYyxDQUFDLGFBQWE7d0JBQ3BDLElBQUksRUFBRSxXQUFXO3FCQUNwQixDQUFBO2dCQUVMLEtBQUssZ0JBQWdCLENBQUM7Z0JBQ3RCLEtBQUssV0FBVyxDQUFDO2dCQUNqQixLQUFLLCtCQUFpQixDQUFDLFNBQVMsQ0FBQztnQkFDakMsS0FBSywrQkFBaUIsQ0FBQyxRQUFRO29CQUMzQixPQUFPO3dCQUNILE1BQU0sRUFBRSxzQkFBYyxDQUFDLE1BQU07d0JBQzdCLElBQUksRUFBRSxXQUFXO3FCQUNwQixDQUFBO2dCQUVMLEtBQUssVUFBVSxDQUFDO2dCQUNoQixLQUFLLGdCQUFnQixDQUFDO2dCQUN0QixLQUFLLCtCQUFpQixDQUFDLFFBQVEsQ0FBQztnQkFDaEMsS0FBSywrQkFBaUIsQ0FBQyxhQUFhO29CQUNoQyxPQUFPO3dCQUNILE1BQU0sRUFBRSxzQkFBYyxDQUFDLFVBQVU7d0JBQ2pDLElBQUksRUFBRSxXQUFXO3FCQUNwQixDQUFBO2dCQUVMO29CQUNJLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLG1DQUFtQyxnQkFBZ0IsaUJBQWlCLGFBQWEsRUFBRSxDQUN0RixDQUFBO29CQUNELE9BQU87d0JBQ0gsTUFBTSxFQUFFLHNCQUFjLENBQUMsYUFBYTt3QkFDcEMsSUFBSSxFQUFFLFdBQVc7cUJBQ3BCLENBQUE7WUFDVCxDQUFDO1FBQ0wsQ0FBQztRQUFDLE9BQU8sS0FBYyxFQUFFLENBQUM7WUFDdEIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2QsNENBQTRDLElBQUEsNkJBQWUsRUFBQyxLQUFLLENBQUMsRUFBRSxDQUN2RSxDQUFBO1lBQ0QsT0FBTztnQkFDSCxNQUFNLEVBQUUsc0JBQWMsQ0FBQyxNQUFNO2dCQUM3QixJQUFJLEVBQUU7b0JBQ0YsVUFBVSxFQUFFLEVBQUU7b0JBQ2QsTUFBTSxFQUFFLElBQUksaUJBQVMsQ0FBQyxDQUFDLENBQUM7aUJBQzNCO2FBQ0osQ0FBQTtRQUNMLENBQUM7SUFDTCxDQUFDO0lBRUQseURBQXlEO0lBQ3pELHVDQUF1QztJQUN2Qyx5REFBeUQ7SUFFekQ7Ozs7Ozs7OztPQVNHO0lBQ0ssS0FBSyxDQUFDLGdDQUFnQyxDQUMxQyxhQUFxQixFQUNyQixTQUFpQixFQUNqQixNQUFjO1FBRWQsZ0VBQWdFO1FBQ2hFLCtEQUErRDtRQUMvRCxpRUFBaUU7UUFDakUsdURBQXVEO1FBQ3ZELE1BQU0sUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDLHNCQUFzQixDQUFDLGFBQWEsQ0FBQyxDQUFBO1FBQ2pFLElBQUksQ0FBQyxRQUFRLElBQUksUUFBUSxDQUFDLElBQUksS0FBSyxXQUFXLEVBQUUsQ0FBQztZQUM3QyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyx3REFBd0QsYUFBYSx1Q0FBdUMsQ0FBQyxDQUFBO1lBQy9ILE9BQU07UUFDVixDQUFDO1FBQ0QsTUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLE9BQStCLENBQUE7UUFFMUQsdUNBQXVDO1FBQ3ZDLE1BQU0sS0FBSyxHQUFHLFNBQVMsQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFBO1FBQ25DLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsVUFBVSxDQUFDLHNCQUFzQixDQUFDLENBQUMsQ0FBQTtRQUM3RSxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7WUFDWCxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyw4REFBOEQsYUFBYSxZQUFZLENBQUMsQ0FBQTtZQUMxRyxPQUFNO1FBQ1YsQ0FBQztRQUVELDBHQUEwRztRQUMxRyxNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxzQkFBc0IsRUFBRSxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFBO1FBQ25HLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLHFDQUFxQyxTQUFTLGFBQWEsTUFBTSx1QkFBdUIsZUFBZSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUE7UUFFdkksNENBQTRDO1FBQzVDLE1BQU0sa0JBQWtCLEdBQUcsV0FBVyxDQUVuQyxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUMsMkJBQTJCLENBQUMsQ0FBQyxDQUFBO1FBQ2xELE1BQU0sa0JBQWtCLEdBQUcsV0FBVyxDQUVuQyxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUMsZUFBTyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUE7UUFDM0MsTUFBTSxLQUFLLEdBQUcsV0FBVyxDQUV0QixJQUFJLENBQUMsVUFBVSxFQUFFLENBQUMsT0FBTyxFQUFFLFdBQVcsRUFBRSxhQUFhLENBQUMsQ0FBQyxDQUFBO1FBRTFELElBQUksQ0FBQyxrQkFBa0IsSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ2hDLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLGlGQUFpRixDQUFDLENBQUE7WUFDcEcsT0FBTTtRQUNWLENBQUM7UUFFRCwwQ0FBMEM7UUFDMUMsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsR0FBRyxNQUFNLEtBQUssQ0FBQyxLQUFLLENBQUM7WUFDckMsTUFBTSxFQUFFLGNBQWM7WUFDdEIsTUFBTSxFQUFFLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFFBQVEsRUFBRSxtQkFBbUIsQ0FBQztZQUMvRSxPQUFPLEVBQUUsRUFBRSxFQUFFLEVBQUUsZUFBZSxFQUFFO1NBQ25DLENBQUMsQ0FBQTtRQVdGLE1BQU0sYUFBYSxHQUFHLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBa0MsQ0FBQyxDQUFBO1FBQ2pGLElBQUksYUFBYSxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUM3QixJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyw2REFBNkQsZUFBZSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUE7WUFDM0csT0FBTTtRQUNWLENBQUM7UUFFRCxzRUFBc0U7UUFDdEUsTUFBTSxZQUFZLEdBQUcsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFBO1FBQ3JDLE1BQU0sUUFBUSxHQUFHLFlBQVksQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFBO1FBRTVDLDJCQUEyQjtRQUMzQixRQUFRLFNBQVMsRUFBRSxDQUFDO1lBQ2hCLEtBQUssZUFBZSxDQUFDLENBQUMsQ0FBQztnQkFDbkIsTUFBTSxnQkFBZ0IsR0FBRyxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUMsQ0FBQyxXQUFXLEVBQUUsQ0FBQTtnQkFFckQsSUFBSSxnQkFBZ0IsS0FBSyxRQUFRLEVBQUUsQ0FBQztvQkFDaEMsMkVBQTJFO29CQUMzRSxNQUFNLFFBQVEsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFBO29CQUMzQixRQUFRLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxPQUFPLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQTtvQkFFeEMsS0FBSyxNQUFNLEdBQUcsSUFBSSxhQUFhLEVBQUUsQ0FBQzt3QkFDOUIsTUFBTSxPQUFPLEdBQUcsR0FBRyxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUE7d0JBQ2xDLE1BQU0sa0JBQWtCLENBQUMsbUJBQW1CLENBQUM7NEJBQ3pDLEVBQUUsRUFBRSxHQUFHLENBQUMsRUFBRTs0QkFDVixNQUFNLEVBQUUsUUFBUTs0QkFDaEIsZUFBZSxFQUFFLFFBQVE7NEJBQ3pCLFFBQVEsRUFBRTtnQ0FDTixHQUFHLE9BQU87Z0NBQ1YsZUFBZSxFQUFFLE9BQU8sQ0FBQyxlQUFlLElBQUksYUFBYTs2QkFDNUQ7eUJBQ0osQ0FBQyxDQUFBO29CQUNOLENBQUM7b0JBRUQsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2IsMENBQTBDLGFBQWEsQ0FBQyxNQUFNLG1DQUFtQyxRQUFRLENBQUMsV0FBVyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQzFJLENBQUE7Z0JBQ0wsQ0FBQztxQkFBTSxDQUFDO29CQUNKLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLGdEQUFnRCxnQkFBZ0IsY0FBYyxDQUNqRixDQUFBO2dCQUNMLENBQUM7Z0JBRUQsNkRBQTZEO2dCQUM3RCw4REFBOEQ7Z0JBQzlELDhEQUE4RDtnQkFDOUQsNkRBQTZEO2dCQUM3RCxNQUFNLElBQUksQ0FBQywwQkFBMEIsQ0FDakMsU0FBUyxFQUNULGVBQWUsRUFDZixhQUFhLENBQ2hCLENBQUE7Z0JBQ0QsTUFBSztZQUNULENBQUM7WUFFRCxLQUFLLGNBQWMsQ0FBQyxDQUFDLENBQUM7Z0JBQ2xCLDBEQUEwRDtnQkFDMUQsMERBQTBEO2dCQUMxRCx5REFBeUQ7Z0JBQ3pELDJEQUEyRDtnQkFDM0Qsa0RBQWtEO2dCQUNsRCxFQUFFO2dCQUNGLG9EQUFvRDtnQkFDcEQsNENBQTRDO2dCQUM1Qyx5REFBeUQ7Z0JBQ3pELDBEQUEwRDtnQkFDMUQsZ0VBQWdFO2dCQUNoRSxNQUFNLElBQUksQ0FBQywwQkFBMEIsQ0FDakMsU0FBUyxFQUNULGVBQWUsRUFDZixhQUFhLENBQ2hCLENBQUE7Z0JBQ0QsTUFBSztZQUNULENBQUM7WUFFRCxLQUFLLGdCQUFnQixDQUFDLENBQUMsQ0FBQztnQkFDcEIsc0RBQXNEO2dCQUN0RCxNQUFNLFdBQVcsR0FBRyxRQUFRLENBQUMsaUJBQWlCLENBQUE7Z0JBQzlDLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztvQkFDZixJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxrREFBa0QsZUFBZSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsdUJBQXVCLENBQUMsQ0FBQTtvQkFDckgsTUFBSztnQkFDVCxDQUFDO2dCQUVELElBQUksQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO29CQUN0QixJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxtRkFBbUYsQ0FBQyxDQUFBO29CQUN0RyxNQUFLO2dCQUNULENBQUM7Z0JBRUQscUNBQXFDO2dCQUNyQyxNQUFNLGVBQWUsR0FBRyxRQUFRLENBQUMsaUJBQWlCLENBQUE7Z0JBQ2xELElBQUksQ0FBQyxlQUFlO29CQUFFLE1BQUs7Z0JBRTNCLElBQUksQ0FBQztvQkFDRCxNQUFNLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxHQUFHLE1BQU0sS0FBSyxDQUFDLEtBQUssQ0FBQzt3QkFDdkMsTUFBTSxFQUFFLE9BQU87d0JBQ2YsTUFBTSxFQUFFLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxvQkFBb0IsRUFBRSxTQUFTLENBQUM7d0JBQy9FLE9BQU8sRUFBRSxFQUFFLEVBQUUsRUFBRSxlQUFlLEVBQUU7cUJBQ25DLENBQUMsQ0FBQTtvQkFTRixNQUFNLEtBQUssR0FBRyxNQUFNLEVBQUUsQ0FBQyxDQUFDLENBQXVDLENBQUE7b0JBQy9ELElBQUksQ0FBQyxLQUFLLEVBQUUsS0FBSzt3QkFBRSxNQUFLO29CQUV4QixNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLFVBQVUsS0FBSyxRQUFRLENBQUMsVUFBVSxDQUFDLENBQUE7b0JBQzlFLE1BQU0sWUFBWSxHQUFHLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxVQUFVLEVBQUUsS0FBSyxDQUFDLFFBQVEsRUFBRSxTQUFTLENBQUM7eUJBQ3ZFLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksVUFBVSxDQUFBO29CQUU1QyxNQUFNLGtCQUFrQixDQUFDLG1CQUFtQixDQUFDO3dCQUN6QyxFQUFFLEVBQUUsS0FBSyxDQUFDLEtBQUs7d0JBQ2YsT0FBTyxFQUFFLE9BQU87d0JBQ2hCLFFBQVEsRUFBRSx1QkFBdUI7d0JBQ2pDLElBQUksRUFBRTs0QkFDRixhQUFhLEVBQUUsWUFBWTs0QkFDM0IsWUFBWSxFQUFFLE9BQU8sRUFBRSxLQUFLLElBQUksY0FBYzs0QkFDOUMsY0FBYyxFQUFFLFNBQVMsQ0FBQyxlQUFlLElBQUksTUFBTTs0QkFDbkQsV0FBVyxFQUFFLFdBQVc7NEJBQ3hCLE9BQU8sRUFBRSxrREFBa0Q7eUJBQzlEO3FCQUNKLENBQUMsQ0FBQTtvQkFFRixJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyw4REFBOEQsS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUE7Z0JBQ2xHLENBQUM7Z0JBQUMsT0FBTyxRQUFpQixFQUFFLENBQUM7b0JBQ3pCLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLHdEQUF3RCxJQUFBLDZCQUFlLEVBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFBO2dCQUMzRyxDQUFDO2dCQUNELE1BQUs7WUFDVCxDQUFDO1lBRUQ7Z0JBQ0ksSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsK0NBQStDLFNBQVMsU0FBUyxlQUFlLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQTtRQUN2SCxDQUFDO0lBQ0wsQ0FBQztJQUVEOzs7Ozs7Ozs7Ozs7O09BYUc7SUFDSyxLQUFLLENBQUMsMEJBQTBCLENBQ3BDLFNBQStCLEVBQy9CLGVBQXlCLEVBQ3pCLGFBQXFCO1FBRXJCLE1BQU0sSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLFlBQVksSUFBSSxFQUFFLENBTXhDLENBQUE7UUFDRixNQUFNLE9BQU8sR0FBK0QsSUFBSTthQUMzRSxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUMsQ0FBQyxXQUFXLEVBQUUsS0FBSyxXQUFXLElBQUksQ0FBQyxDQUFDLEVBQUUsQ0FBQzthQUNyRSxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7WUFDVCxHQUFHLEVBQUUsQ0FBQyxDQUFDLEVBQVk7WUFDbkIsTUFBTSxFQUFFLENBQUMsQ0FBQyxNQUFNO1lBQ2hCLFNBQVMsRUFBRSxDQUFDLENBQUMsV0FBVyxJQUFJLENBQUMsQ0FBQyxTQUFTLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUU7U0FDdEUsQ0FBQyxDQUFDLENBQUE7UUFFUCxNQUFNLEVBQUUsR0FBRyxTQUFTLENBQUMsY0FBYyxDQUFBO1FBQ25DLE1BQU0sUUFBUSxHQUFHLEVBQUUsRUFBRSxXQUFXLElBQUksRUFBRSxFQUFFLFNBQVMsQ0FBQTtRQUNqRCxvRUFBb0U7UUFDcEUsMkRBQTJEO1FBQzNELElBQUksRUFBRSxJQUFJLENBQUMsRUFBRSxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUMsQ0FBQyxXQUFXLEVBQUUsS0FBSyxNQUFNLElBQUksUUFBUSxFQUFFLENBQUM7WUFDL0QsT0FBTyxDQUFDLElBQUksQ0FBQztnQkFDVCxHQUFHLEVBQUUsRUFBRSxDQUFDLGlCQUFpQixJQUFJLEdBQUcsU0FBUyxDQUFDLEVBQUUsVUFBVTtnQkFDdEQsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNO2dCQUNqQixTQUFTLEVBQUUsUUFBUTthQUN0QixDQUFDLENBQUE7UUFDTixDQUFDO1FBRUQsSUFBSSxPQUFPLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ3ZCLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLHlEQUF5RCxhQUFhLEtBQUssSUFBSSxDQUFDLE1BQU0sWUFBWSxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxxQkFBcUIsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxNQUFNLDRDQUE0QyxDQUNoTyxDQUFBO1lBQ0QsT0FBTTtRQUNWLENBQUM7UUFFRCxNQUFNLFFBQVEsR0FBRyxXQUFXLENBTXhCLElBQUksQ0FBQyxVQUFVLEVBQ2YsQ0FBQyxlQUFPLENBQUMsU0FBUyxFQUFFLGlCQUFpQixFQUFFLGVBQWUsQ0FBQyxDQUMxRCxDQUFBO1FBRUQsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ1osSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2Isc0dBQXNHLGFBQWEsRUFBRSxDQUN4SCxDQUFBO1lBQ0QsT0FBTTtRQUNWLENBQUM7UUFFRCxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FDYiw4QkFBOEIsT0FBTyxDQUFDLE1BQU0sMEJBQTBCLGFBQWEsZ0NBQWdDLENBQ3RILENBQUE7UUFFRCxLQUFLLE1BQU0sSUFBSSxJQUFJLE9BQU8sRUFBRSxDQUFDO1lBQ3pCLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxNQUFNLElBQUksU0FBUyxDQUFDLGVBQWUsSUFBSSxHQUFHLENBQUE7WUFDakUsSUFBSSxDQUFDO2dCQUNELE1BQU0sUUFBUSxDQUFDLElBQUksQ0FBQztvQkFDaEIsSUFBSSxFQUFFLGdDQUFnQztvQkFDdEMsSUFBSSxFQUFFO3dCQUNGLGdCQUFnQixFQUFFLGVBQWU7d0JBQ2pDLGVBQWUsRUFBRSxhQUFhO3dCQUM5QixtQkFBbUIsRUFBRSxJQUFJLENBQUMsR0FBRzt3QkFDN0IsTUFBTSxFQUFFLE1BQU0sQ0FBQyxTQUFTLENBQUM7d0JBQ3pCLFdBQVcsRUFBRSxJQUFJLENBQUMsU0FBUztxQkFDOUI7aUJBQ0osQ0FBQyxDQUFBO2dCQUNGLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLCtFQUErRSxlQUFlLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxVQUFVLElBQUksQ0FBQyxHQUFHLFlBQVksU0FBUyxHQUFHLENBQ3JKLENBQUE7WUFDTCxDQUFDO1lBQUMsT0FBTyxPQUFnQixFQUFFLENBQUM7Z0JBQ3hCLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUNkLGtEQUFrRCxJQUFJLENBQUMsR0FBRyxNQUFNLElBQUEsNkJBQWUsRUFBQyxPQUFPLENBQUMsRUFBRSxDQUM3RixDQUFBO1lBQ0wsQ0FBQztRQUNMLENBQUM7SUFDTCxDQUFDO0lBRUQseURBQXlEO0lBQ3pELHlCQUF5QjtJQUN6Qix5REFBeUQ7SUFFekQ7Ozs7Ozs7Ozs7OztPQVlHO0lBQ0ssS0FBSyxDQUFDLHVCQUF1QixDQUFDLElBTXJDO1FBQ0csSUFBSSxDQUFDO1lBMkJELE1BQU0scUJBQXFCLEdBQUcsV0FBVyxDQUNyQyxJQUFJLENBQUMsVUFBVSxFQUNmLENBQUMsdUJBQXVCLENBQUMsQ0FDNUIsQ0FBQTtZQUNELE1BQU0sS0FBSyxHQUFHLFdBQVcsQ0FDckIsSUFBSSxDQUFDLFVBQVUsRUFDZixDQUFDLE9BQU8sRUFBRSxXQUFXLEVBQUUsYUFBYSxDQUFDLENBQ3hDLENBQUE7WUFFRCxJQUFJLFFBQWlCLENBQUE7WUFDckIsSUFBSSxZQUd3QyxDQUFBO1lBRTVDLElBQUkscUJBQXFCLEVBQUUsQ0FBQztnQkFDeEIsSUFBSSxDQUFDO29CQUNELE1BQU0sT0FBTyxHQUFHLE1BQU0scUJBQXFCLENBQUMsUUFBUSxDQUNoRCxJQUFJLENBQUMsU0FBUyxFQUNkLEVBQUUsTUFBTSxFQUFFLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRSxZQUFZLENBQUMsRUFBRSxDQUM3QyxDQUFBO29CQUNELFlBQVksR0FBRyxPQUFPO3dCQUNsQixDQUFDLENBQUM7NEJBQ0ksSUFBSSxFQUFFLE9BQU87NEJBQ2IsTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFNOzRCQUN0QixTQUFTLEVBQUUsT0FBTyxDQUFDLFVBQVU7eUJBQ2hDO3dCQUNILENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsQ0FBQTtnQkFDN0IsQ0FBQztnQkFBQyxPQUFPLENBQUMsRUFBRSxDQUFDO29CQUNULE1BQU0sR0FBRyxHQUFHLElBQUEsNkJBQWUsRUFBQyxDQUFDLENBQUMsQ0FBQTtvQkFDOUIsbUVBQW1FO29CQUNuRSxJQUFJLFlBQVksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQzt3QkFDekIsWUFBWSxHQUFHLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRSxDQUFBO29CQUN0QyxDQUFDO3lCQUFNLENBQUM7d0JBQ0osWUFBWSxHQUFHOzRCQUNYLElBQUksRUFBRSxZQUFZOzRCQUNsQixNQUFNLEVBQUUseUNBQXlDLEdBQUcsRUFBRTt5QkFDekQsQ0FBQTtvQkFDTCxDQUFDO2dCQUNMLENBQUM7WUFDTCxDQUFDO2lCQUFNLElBQUksS0FBSyxFQUFFLENBQUM7Z0JBQ2YsTUFBTSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsR0FBRyxNQUFNLEtBQUssQ0FBQyxLQUFLLENBQUM7b0JBQ3pDLE1BQU0sRUFBRSxpQkFBaUI7b0JBQ3pCLE1BQU0sRUFBRSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUUsWUFBWSxDQUFDO29CQUN0QyxPQUFPLEVBQUUsRUFBRSxFQUFFLEVBQUUsSUFBSSxDQUFDLFNBQVMsRUFBRTtpQkFDbEMsQ0FBQyxDQUFBO2dCQUNGLE1BQU0sT0FBTyxHQUFHLFFBQVEsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFBO2dCQUM3QixZQUFZLEdBQUcsT0FBTztvQkFDbEIsQ0FBQyxDQUFDO3dCQUNJLElBQUksRUFBRSxPQUFPO3dCQUNiLE1BQU0sRUFBRSxPQUFPLENBQUMsTUFBTTt3QkFDdEIsU0FBUyxFQUFFLE9BQU8sQ0FBQyxVQUFVO3FCQUNoQztvQkFDSCxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLENBQUE7WUFDN0IsQ0FBQztpQkFBTSxDQUFDO2dCQUNKLFlBQVksR0FBRztvQkFDWCxJQUFJLEVBQUUsWUFBWTtvQkFDbEIsTUFBTSxFQUFFLDhFQUE4RTtpQkFDekYsQ0FBQTtZQUNMLENBQUM7WUFFRCxJQUFJLFlBQVksQ0FBQyxJQUFJLEtBQUssT0FBTyxFQUFFLENBQUM7Z0JBQ2hDLE1BQU0sT0FBTyxHQUFHLFlBQVksQ0FBQyxTQUFTLElBQUksSUFBSSxDQUFBO2dCQUM5QyxNQUFNLFFBQVEsR0FBRyxZQUFZLENBQUMsTUFBTSxLQUFLLFVBQVUsQ0FBQTtnQkFDbkQsUUFBUSxHQUFHLE9BQU8sSUFBSSxRQUFRLENBQUE7Z0JBQzlCLElBQUksUUFBUSxFQUFFLENBQUM7b0JBQ1gsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2IsOEJBQThCLElBQUksQ0FBQyxTQUFTLFdBQVcsWUFBWSxDQUFDLE1BQU0sZUFBZSxZQUFZLENBQUMsU0FBUywrQkFBK0IsSUFBSSxDQUFDLGFBQWEsaUJBQWlCLENBQ3BMLENBQUE7Z0JBQ0wsQ0FBQztZQUNMLENBQUM7aUJBQU0sSUFBSSxZQUFZLENBQUMsSUFBSSxLQUFLLFNBQVMsRUFBRSxDQUFDO2dCQUN6QyxRQUFRLEdBQUcsSUFBSSxDQUFBO2dCQUNmLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLDhCQUE4QixJQUFJLENBQUMsU0FBUyx1Q0FBdUMsSUFBSSxDQUFDLGFBQWEsaUJBQWlCLENBQ3pILENBQUE7WUFDTCxDQUFDO2lCQUFNLENBQUM7Z0JBQ0osb0RBQW9EO2dCQUNwRCx5REFBeUQ7Z0JBQ3pELDBEQUEwRDtnQkFDMUQsMkRBQTJEO2dCQUMzRCwwREFBMEQ7Z0JBQzFELDREQUE0RDtnQkFDNUQsNkRBQTZEO2dCQUM3RCxRQUFRLEdBQUcsSUFBSSxDQUFBO2dCQUNmLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNiLDRDQUE0QyxJQUFJLENBQUMsU0FBUyxLQUFLLFlBQVksQ0FBQyxNQUFNLHVGQUF1RixDQUM1SyxDQUFBO1lBQ0wsQ0FBQztZQUVELElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztnQkFDWixPQUFPLEtBQUssQ0FBQTtZQUNoQixDQUFDO1lBRUQsNERBQTREO1lBQzVELDhEQUE4RDtZQUM5RCw0REFBNEQ7WUFDNUQsK0NBQStDO1lBQy9DLElBQUksYUFBYSxHQUFHLEVBQUUsQ0FBQTtZQUN0QixJQUFJLFlBQWdDLENBQUE7WUFDcEMsSUFBSSxhQUFhLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQTtZQUM1QyxJQUFJLENBQUM7Z0JBQ0Qsd0RBQXdEO2dCQUN4RCxNQUFNLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQyxzQkFBc0IsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUE7Z0JBQ3RFLE1BQU0sV0FBVyxHQUFHLFFBQVEsRUFBRSxJQUFJLEtBQUssUUFBUTtvQkFDM0MsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxPQUFPO29CQUNsQixDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUE7Z0JBQ3ZELGFBQWEsR0FBRyxXQUFXLENBQUMsYUFBYSxJQUFJLEVBQUUsQ0FBQTtnQkFDL0MsWUFBWSxHQUFHLFdBQVcsQ0FBQyxZQUFZLENBQUE7Z0JBQ3ZDLGFBQWEsR0FBRyxXQUFXLENBQUMsU0FBUztvQkFDakMsQ0FBQyxDQUFDLElBQUksSUFBSSxDQUFDLFdBQVcsQ0FBQyxTQUFTLENBQUMsQ0FBQyxXQUFXLEVBQUU7b0JBQy9DLENBQUMsQ0FBQyxhQUFhLENBQUE7WUFDdkIsQ0FBQztZQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7Z0JBQ1QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2IsaUNBQWlDLElBQUksQ0FBQyxhQUFhLGNBQWMsSUFBQSw2QkFBZSxFQUFDLENBQUMsQ0FBQyxzQ0FBc0MsQ0FDNUgsQ0FBQTtZQUNMLENBQUM7WUFRRCxNQUFNLFFBQVEsR0FBRyxXQUFXLENBQ3hCLElBQUksQ0FBQyxVQUFVLEVBQ2YsQ0FBQyxlQUFPLENBQUMsU0FBUyxFQUFFLGlCQUFpQixFQUFFLGVBQWUsQ0FBQyxDQUMxRCxDQUFBO1lBQ0QsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO2dCQUNaLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUNkLHlGQUF5RixJQUFJLENBQUMsYUFBYSxFQUFFLENBQ2hILENBQUE7Z0JBQ0QsT0FBTyxLQUFLLENBQUE7WUFDaEIsQ0FBQztZQUVELE1BQU0sUUFBUSxDQUFDLElBQUksQ0FBQztnQkFDaEIsSUFBSSxFQUFFLDBCQUEwQjtnQkFDaEMsSUFBSSxFQUFFO29CQUNGLGFBQWEsRUFBRSxJQUFJLENBQUMsYUFBYTtvQkFDakMsYUFBYSxFQUFFLElBQUksQ0FBQyxhQUFhO29CQUNqQyxNQUFNLEVBQUUsSUFBSSxDQUFDLE1BQU07b0JBQ25CLFlBQVksRUFBRSxJQUFJLENBQUMsWUFBWTtvQkFDL0IsYUFBYTtvQkFDYixZQUFZO29CQUNaLGFBQWE7b0JBQ2IsZ0JBQWdCLEVBQUUsSUFBSSxDQUFDLFNBQVM7aUJBQ25DO2FBQ0osQ0FBQyxDQUFBO1lBQ0YsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2IsMkRBQTJELElBQUksQ0FBQyxhQUFhLFNBQVMsSUFBSSxDQUFDLGFBQWEsV0FBVyxhQUFhLElBQUksU0FBUyxHQUFHLENBQ25KLENBQUE7WUFDRCxPQUFPLElBQUksQ0FBQTtRQUNmLENBQUM7UUFBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ1QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2QseUNBQXlDLElBQUEsNkJBQWUsRUFBQyxDQUFDLENBQUMsa0NBQWtDLENBQ2hHLENBQUE7WUFDRCxPQUFPLEtBQUssQ0FBQTtRQUNoQixDQUFDO0lBQ0wsQ0FBQztJQUVELHlEQUF5RDtJQUN6RCxrQkFBa0I7SUFDbEIseURBQXlEO0lBRXpEOzs7T0FHRztJQUNLLG9CQUFvQixDQUN4QixJQUE2QjtRQUU3QixJQUFJLE9BQU8sSUFBSSxLQUFLLFFBQVEsSUFBSSxJQUFJLEtBQUssSUFBSTtZQUFFLE9BQU8sSUFBSSxDQUFBO1FBRTFELE1BQU0sRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSyxJQUFZLENBQUMsWUFBWSxDQUFXLENBQUE7UUFDNUQsTUFBTSxNQUFNLEdBQUcsQ0FBQyxJQUFJLENBQUMsTUFBTSxJQUFLLElBQVksQ0FBQyxVQUFVLENBQVcsQ0FBQTtRQUNsRSxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsVUFBb0IsQ0FBQTtRQUM1QyxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsU0FBbUIsQ0FBQTtRQUUxQyxJQUFJLE9BQU8sRUFBRSxLQUFLLFFBQVEsSUFBSSxDQUFDLE9BQU8sTUFBTSxLQUFLLFFBQVEsSUFBSSxDQUFDLFNBQVMsQ0FBQztZQUFFLE9BQU8sSUFBSSxDQUFBO1FBRXJGLE9BQU87WUFDSCxFQUFFO1lBQ0YsTUFBTSxFQUFFLENBQUMsTUFBTSxJQUFJLFNBQVMsQ0FBc0I7WUFDbEQsU0FBUyxFQUFFLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUNqRSxDQUFDLE9BQVEsSUFBWSxDQUFDLGdCQUFnQixLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUUsSUFBWSxDQUFDLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDOUYsTUFBTSxFQUFFLENBQUMsT0FBTyxJQUFJLENBQUMsTUFBTSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUN4RCxDQUFDLE9BQVEsSUFBWSxDQUFDLGVBQWUsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFFLElBQVksQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQztZQUM3RixRQUFRLEVBQUUsT0FBTyxJQUFJLENBQUMsUUFBUSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSztZQUNuRSxVQUFVO1lBQ1YsU0FBUztZQUNULEtBQUssRUFBRyxJQUFZLENBQUMsS0FBSztTQUM3QixDQUFBO0lBQ0wsQ0FBQztJQUVELHlEQUF5RDtJQUN6RCxnQ0FBZ0M7SUFDaEMseURBQXlEO0lBRXpEOztPQUVHO0lBQ0gsS0FBSyxDQUFDLG1CQUFtQixDQUFDLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBNEI7UUFDakUsTUFBTSxFQUFFLGNBQWMsRUFBRSxRQUFRLEVBQUUsR0FBRyxPQUFPLENBQUE7UUFFNUMsSUFBSSxjQUFjLEVBQUUsSUFBSSxFQUFFLEVBQUUsRUFBRSxDQUFDO1lBQzNCLE9BQU8sRUFBRSxFQUFFLEVBQUUsY0FBYyxDQUFDLElBQUksQ0FBQyxFQUFZLEVBQUUsQ0FBQTtRQUNuRCxDQUFDO1FBRUQsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ1osTUFBTSxJQUFJLG1CQUFXLENBQ2pCLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIseURBQXlELENBQzVELENBQUE7UUFDTCxDQUFDO1FBRUQsSUFBSSxDQUFDO1lBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsMkNBQTJDLFFBQVEsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFBO1lBRTlFLE1BQU0sYUFBYSxHQUFHLE1BQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxtQkFBbUIsQ0FBQztnQkFDekQsSUFBSSxFQUFFLEdBQUcsUUFBUSxDQUFDLFVBQVUsSUFBSSxRQUFRLENBQUMsU0FBUyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksRUFBRSxJQUFJLFFBQVEsQ0FBQyxLQUFLO2dCQUNuRixJQUFJLEVBQUUsbUNBQXFCLENBQUMsUUFBUTthQUN2QyxDQUFDLENBQUE7WUFFRixPQUFPO2dCQUNILEVBQUUsRUFBRSxhQUFhLENBQUMsRUFBRTtnQkFDcEIsSUFBSSxFQUFFLGFBQW9CO2FBQzdCLENBQUE7UUFDTCxDQUFDO1FBQUMsT0FBTyxLQUFVLEVBQUUsQ0FBQztZQUNsQixJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxzQ0FBc0MsSUFBQSw2QkFBZSxFQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQTtZQUNsRixNQUFNLElBQUksbUJBQVcsQ0FDakIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLEVBQ2xDLHlDQUF5QyxJQUFBLDZCQUFlLEVBQUMsS0FBSyxDQUFDLEVBQUUsQ0FDcEUsQ0FBQTtRQUNMLENBQUM7SUFDTCxDQUFDO0lBRUQ7OztPQUdHO0lBQ0gsS0FBSyxDQUFDLGlCQUFpQixDQUFDLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBMEI7UUFDN0QsTUFBTSxhQUFhLEdBQUcsYUFBYSxDQUFDLElBQUksRUFBRSxpQkFBaUIsQ0FBQyxDQUFBO1FBRTVELElBQUksQ0FBQyxhQUFhLEVBQUUsQ0FBQztZQUNqQixNQUFNLElBQUksbUJBQVcsQ0FDakIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUM5QixpREFBaUQsQ0FDcEQsQ0FBQTtRQUNMLENBQUM7UUFFRCxPQUFPO1lBQ0gsRUFBRSxFQUFFLGFBQWE7WUFDakIsSUFBSSxFQUFFO2dCQUNGLEdBQUcsSUFBSTtnQkFDUCxxQkFBcUIsRUFBRSxhQUFhO2FBQ3ZDO1NBQ0osQ0FBQTtJQUNMLENBQUM7SUFFRDs7T0FFRztJQUNILEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxPQUFnQztRQUNyRCwwRUFBMEU7UUFDMUUsT0FBTyxFQUFFLENBQUE7SUFDYixDQUFDO0lBRUQ7O09BRUc7SUFDSCxLQUFLLENBQUMsbUJBQW1CLENBQUMsT0FBaUM7UUFDdkQscURBQXFEO1FBQ3JELE9BQU8sRUFBRSxDQUFBO0lBQ2IsQ0FBQztJQUVEOztPQUVHO0lBQ0sscUJBQXFCLENBQ3pCLFVBQXNDO1FBRXRDLE1BQU0sZ0JBQWdCLEdBQUksVUFBcUIsQ0FBQyxXQUFXLEVBQUUsQ0FBQTtRQUU3RCxRQUFRLGdCQUFnQixFQUFFLENBQUM7WUFDdkIsS0FBSyxRQUFRLENBQUM7WUFDZCxLQUFLLGNBQWMsQ0FBQztZQUNwQixLQUFLLG1CQUFtQixDQUFDO1lBQ3pCLEtBQUssTUFBTSxDQUFDO1lBQ1osS0FBSywrQkFBaUIsQ0FBQyxJQUFJO2dCQUN2QixPQUFPLFVBQWtDLENBQUE7WUFFN0MsS0FBSyxNQUFNLENBQUM7WUFDWixLQUFLLFNBQVMsQ0FBQztZQUNmLEtBQUssT0FBTyxDQUFDO1lBQ2IsS0FBSyxTQUFTLENBQUM7WUFDZixLQUFLLCtCQUFpQixDQUFDLElBQUksQ0FBQztZQUM1QixLQUFLLCtCQUFpQixDQUFDLE9BQU8sQ0FBQztZQUMvQixLQUFLLCtCQUFpQixDQUFDLEtBQUssQ0FBQztZQUM3QixLQUFLLCtCQUFpQixDQUFDLE9BQU87Z0JBQzFCLE9BQU8sU0FBaUMsQ0FBQTtZQUU1QyxLQUFLLGdCQUFnQixDQUFDO1lBQ3RCLEtBQUssK0JBQWlCLENBQUMsUUFBUTtnQkFDM0IsT0FBTyxPQUErQixDQUFBO1lBRTFDLEtBQUssV0FBVyxDQUFDO1lBQ2pCLEtBQUssK0JBQWlCLENBQUMsU0FBUztnQkFDNUIsT0FBTyxVQUFrQyxDQUFBO1lBRTdDLEtBQUssK0JBQWlCLENBQUMsUUFBUSxDQUFDO1lBQ2hDLEtBQUssK0JBQWlCLENBQUMsYUFBYSxDQUFDO1lBQ3JDLEtBQUssK0JBQWlCLENBQUMsYUFBYTtnQkFDaEMsT0FBTyxVQUFrQyxDQUFBO1lBRTdDO2dCQUNJLE9BQU8sU0FBaUMsQ0FBQTtRQUNoRCxDQUFDO0lBQ0wsQ0FBQztJQUVEOzs7Ozs7T0FNRztJQUNLLEtBQUssQ0FBQyxxQkFBcUIsQ0FDL0IsRUFBVSxFQUNWLFNBQXFCLElBQUksQ0FBQyxPQUFPO1FBRWpDLElBQUksQ0FBQztZQUNELHVDQUF1QztZQUN2QyxPQUFPLE1BQU0sTUFBTSxDQUFDLFVBQVUsQ0FBQyxFQUFFLENBQUMsQ0FBQTtRQUN0QyxDQUFDO1FBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNULGdCQUFnQjtZQUNoQixJQUFJLENBQUM7Z0JBQ0QsT0FBTyxNQUFNLE1BQU0sQ0FBQyxtQkFBbUIsQ0FBQyxFQUFFLENBQUMsQ0FBQTtZQUMvQyxDQUFDO1lBQUMsT0FBTyxjQUFjLEVBQUUsQ0FBQztnQkFDdEIsTUFBTSxJQUFJLEtBQUssQ0FBQywyREFBMkQsRUFBRSxFQUFFLENBQUMsQ0FBQTtZQUNwRixDQUFDO1FBQ0wsQ0FBQztJQUNMLENBQUM7O0FBMXhETSxxQ0FBVSxHQUFHLHdCQUFnQixDQUFBO0FBNnhEeEMsa0JBQWUsMEJBQTBCLENBQUEifQ==