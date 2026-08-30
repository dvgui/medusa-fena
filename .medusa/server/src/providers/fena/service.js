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
 * 4. authorizePayment verifies Fena and reports already-settled payments as
 *    captured, so redirect-time order placement does not depend on a webhook
 * 5. Fena webhooks remain an asynchronous backup/retry path
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.fenaAuthorizationStatus = exports.FENA_PROVIDER_ID = void 0;
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
/**
 * Translate Fena's live state into the state Medusa should persist while
 * completing checkout. A bank-settled payment is already captured in the real
 * world; returning `captured` makes Medusa create its capture bookkeeping and
 * order transaction in the same complete-cart workflow.
 *
 * `active` alone only proves that a recurring mandate exists. It authorizes the
 * session but must not pretend the initial debit settled.
 */
const fenaAuthorizationStatus = (input) => {
    const status = input.effectiveStatus.toLowerCase();
    if (input.initialPaymentPaid ||
        ["paid", "payment-made", "payment-confirmed"].includes(status)) {
        return "captured";
    }
    if (status === "active")
        return "authorized";
    return "pending";
};
exports.fenaAuthorizationStatus = fenaAuthorizationStatus;
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
    /**
     * Persist an external-attempt signal outside the disposable Medusa payment
     * session. The host records it on cart metadata, so refreshing checkout and
     * hard-deleting the session cannot erase the only local copy of Fena's id.
     * Best effort: the external payment already exists, so an event-bus outage
     * must be surfaced loudly but cannot be made transactional after the fact.
     */
    async emitFenaAttemptCreated(input) {
        if (!input.cartId) {
            this.logger_.warn(`Fena: attempt ${input.fenaPaymentId} has no cart_id; durable cart ledger is unavailable for this non-checkout flow`);
            return;
        }
        const eventBus = safeResolve(this.container_, [utils_1.Modules.EVENT_BUS, "eventBusService", "__event_bus__"]);
        if (!eventBus) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, `Fena: cannot persist attempt ${input.fenaPaymentId} because the event bus is unavailable`);
        }
        try {
            const attemptDate = new Date(input.createdAtIso);
            if (Number.isNaN(attemptDate.getTime())) {
                throw new Error("Fena returned an invalid attempt timestamp");
            }
            await eventBus.emit({
                name: "payment.fena_attempt_created",
                data: {
                    ...input,
                    createdAtIso: attemptDate.toISOString(),
                },
            });
        }
        catch (error) {
            this.logger_.error(`Fena: failed to emit payment.fena_attempt_created for ${input.fenaPaymentId} — ${(0, fena_client_1.getErrorMessage)(error)}`);
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, "Fena payment attempt could not be recorded safely");
        }
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
            const cartId = getDataString(input.data, "cart_id");
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
                    if (cartId) {
                        await client.attachRecurringPaymentNote(payment.id, {
                            text: `medusa_cart:${cartId}`,
                            visibility: "restricted",
                        });
                    }
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
                await this.emitFenaAttemptCreated({
                    cartId,
                    paymentSessionId: sessionId,
                    fenaPaymentId: payment.id,
                    fenaReference: reference,
                    amount: Number(formattedAmount),
                    currencyCode: currency_code.toUpperCase(),
                    brandSlug,
                    createdAtIso: payment.createdAt ?? new Date().toISOString(),
                    kind: "recurring",
                });
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
            if (cartId) {
                notes.push({ text: `medusa_cart:${cartId}`, visibility: "restricted" });
            }
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
                    ? opts.redirectUrl.replace("{cart_id}", cartId ?? sessionId)
                    : undefined,
                description,
                notes,
            });
            const payment = response.result;
            this.logger_.info(`Fena: Payment created — ID: ${payment.id}, Link: ${payment.link} (brand=${brandSlug})`);
            await this.emitFenaAttemptCreated({
                cartId,
                paymentSessionId: sessionId,
                fenaPaymentId: payment.id,
                fenaReference: reference,
                amount: Number(formattedAmount),
                currencyCode: currency_code.toUpperCase(),
                brandSlug,
                createdAtIso: payment.createdAt ?? new Date().toISOString(),
                kind: "single",
            });
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
            const authorizationStatus = (0, exports.fenaAuthorizationStatus)({
                effectiveStatus: fenaStatus,
                initialPaymentPaid: initialPaidOnRecurring,
            });
            const isConfirmed = authorizationStatus !== "pending";
            const isSent = fenaStatus === "sent" || fenaStatus === fena_client_1.FenaPaymentStatus.Sent;
            this.logger_.info(`[v2.5] Fena: authorizePayment — ID: ${fenaPaymentId}, Fena status: ${payment.status}, initialPaid: ${initialPaidOnRecurring}, confirmed: ${isConfirmed}, isSent: ${isSent}`);
            return {
                data: {
                    ...input.data,
                    fena_payment_status: payment.status,
                },
                status: authorizationStatus,
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
            let cartId = "";
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
                    const noteCart = payment.notes?.find?.((n) => typeof n?.text === "string" &&
                        n.text.startsWith("medusa_cart:"));
                    if (noteCart) {
                        cartId = String(noteCart.text).slice("medusa_cart:".length);
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
                    const recurringNotes = [
                        ...(recurring.notes ?? []),
                        ...(recurring.transactions?.flatMap?.((transaction) => transaction?.notes ?? []) ?? []),
                    ];
                    const cartNote = recurringNotes.find((note) => typeof note?.text === "string" &&
                        note.text.startsWith("medusa_cart:"));
                    if (cartNote) {
                        cartId = String(cartNote.text).slice("medusa_cart:".length);
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
                        cartId: cartId || undefined,
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
                    cartId: args.cartId,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvZmVuYS9zZXJ2aWNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7O0dBWUc7OztBQUVILHFEQU1rQztBQWlDbEMsdURBVThCO0FBNEQ5QiwyREFBMkQ7QUFDM0QsVUFBVTtBQUNWLDJEQUEyRDtBQUUzRDs7Ozs7O0dBTUc7QUFDSCxNQUFNLFdBQVcsR0FBRyxDQUNoQixTQUFrQyxFQUNsQyxJQUF1QixFQUNWLEVBQUU7SUFDZixLQUFLLE1BQU0sR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDO1FBQ3JCLElBQUksQ0FBQztZQUNELE1BQU0sS0FBSyxHQUFHLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQTtZQUM1QixJQUFJLEtBQUssSUFBSSxJQUFJO2dCQUFFLE9BQU8sS0FBVSxDQUFBO1FBQ3hDLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCw4QkFBOEI7UUFDbEMsQ0FBQztJQUNMLENBQUM7SUFDRCxPQUFPLFNBQVMsQ0FBQTtBQUNwQixDQUFDLENBQUE7QUFFRDs7O0dBR0c7QUFDSCxTQUFTLGFBQWEsQ0FDbEIsSUFBeUMsRUFDekMsR0FBVztJQUVYLElBQUksQ0FBQyxJQUFJO1FBQUUsT0FBTyxTQUFTLENBQUE7SUFDM0IsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFBO0lBQ3ZCLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQTtBQUN4RCxDQUFDO0FBRUQ7O0dBRUc7QUFDSCxTQUFTLGFBQWEsQ0FBQyxPQUFZO0lBQy9CLElBQUksQ0FBQyxPQUFPO1FBQUUsT0FBTyxFQUFFLENBQUE7SUFDdkIsTUFBTSxLQUFLLEdBQUc7UUFDVixPQUFPLENBQUMsVUFBVSxJQUFJLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FB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