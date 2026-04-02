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
class FenaPaymentProviderService extends utils_1.AbstractPaymentProvider {
    constructor(container, options) {
        super(container, options);
        this.logger_ = container.logger;
        this.options_ = options;
        this.container_ = container;
        // Initialize the Fena API client
        this.client_ = new fena_client_1.FenaClient({
            terminalId: options.terminalId,
            terminalSecret: options.terminalSecret,
        });
        this.logger_.info("Fena Payment Provider initialized");
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
                // 1. Calculate 6-working-day delay (at least)
                const startDate = new Date();
                let addedDays = 0;
                while (addedDays < 6) {
                    startDate.setDate(startDate.getDate() + 1);
                    const day = startDate.getDay();
                    if (day !== 0 && day !== 6) { // Skip Sunday(0) and Saturday(6)
                        addedDays++;
                    }
                }
                // Determine frequency and other recurring params from metadata or default
                const frequency = input.data?.frequency || fena_client_1.FenaRecurringPaymentFrequency.OneMonth;
                const shippingAddress = formatAddress(input.data?.shipping_address);
                const billingAddress = formatAddress(input.data?.billing_address);
                const notes = [
                    { text: `medusa_session:${sessionId}`, visibility: "private" },
                ];
                if (shippingAddress)
                    notes.push({ text: `Shipping: ${shippingAddress}`, visibility: "private" });
                if (billingAddress)
                    notes.push({ text: `Billing: ${billingAddress}`, visibility: "private" });
                const response = await this.client_.createAndProcessRecurringPayment({
                    reference,
                    recurringAmount: formattedAmount,
                    recurringPaymentDate: startDate.toISOString(),
                    numberOfPayments: 0, // Indefinite by default
                    frequency,
                    initialPaymentAmount: formattedAmount, // CHARGE IMMEDIATELY
                    bankAccount: this.options_.bankAccountId,
                    customerName: customerName || "Customer",
                    customerEmail: customerEmail || "unknown@example.com",
                    notes,
                });
                const payment = response.result;
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
                    },
                };
            }
            const shippingAddress = formatAddress(input.data?.shipping_address);
            const billingAddress = formatAddress(input.data?.billing_address);
            const notes = [];
            if (shippingAddress)
                notes.push({ text: `Shipping: ${shippingAddress}`, visibility: "restricted" });
            if (billingAddress)
                notes.push({ text: `Billing: ${billingAddress}`, visibility: "restricted" });
            // Standard Single Payment
            const response = await this.client_.createAndProcessPayment({
                reference,
                amount: formattedAmount,
                bankAccount: this.options_.bankAccountId,
                paymentMethod: this.options_.paymentMethod || fena_client_1.FenaPaymentMethod.FenaOB,
                customerName,
                customerEmail,
                customRedirectUrl: this.options_.redirectUrl
                    ? this.options_.redirectUrl.replace("{cart_id}", sessionId)
                    : undefined,
                // Embed full Medusa session ID in description so we can recover it in webhooks
                description: `[medusa_session:${sessionId}] Order payment — ${currency_code.toUpperCase()}`,
                notes,
            });
            const payment = response.result;
            this.logger_.info(`Fena: Payment created — ID: ${payment.id}, Link: ${payment.link}`);
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
                const payment = await this.getPaymentOrRecurring(fenaPaymentId);
                const status = this.mapFenaStatusToMedusa(payment.status);
                return {
                    data: {
                        ...input.data,
                        fena_payment_status: payment.status,
                    },
                    status,
                };
            }
            const payment = await this.getPaymentOrRecurring(fenaPaymentId);
            // Medusa's authorizePaymentSession only accepts "authorized" or "captured".
            // Only return "authorized" when the bank has CONFIRMED payment.
            // "sent" = just sent to bank, NOT confirmed — return "pending".
            const fenaStatus = payment.status.toLowerCase();
            const confirmedStatuses = ["paid", "active", "payment-made", "payment-confirmed"];
            const isConfirmed = confirmedStatuses.includes(fenaStatus);
            const isSent = fenaStatus === "sent" || fenaStatus === fena_client_1.FenaPaymentStatus.Sent;
            this.logger_.info(`[v2.5] Fena: authorizePayment — ID: ${fenaPaymentId}, Fena status: ${payment.status}, confirmed: ${isConfirmed}, isSent: ${isSent}`);
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
        try {
            const payment = await this.getPaymentOrRecurring(fenaPaymentId);
            if (payment.status === fena_client_1.FenaPaymentStatus.Paid || payment.status === "active" || payment.status === "payment-made") {
                this.logger_.info(`Fena: Payment ${fenaPaymentId} confirmed as captured/active`);
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
        try {
            const payment = await this.client_.getPayment(fenaPaymentId);
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
        return {
            data: {
                ...input.data,
                amount: amount?.toString(),
                currency_code,
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
        try {
            const payment = await this.client_.getPayment(fenaPaymentId);
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
            try {
                // Try Single Payment first
                try {
                    const payment = await this.client_.getPayment(fenaPaymentId);
                    authenticStatus = payment.status;
                    const descMatch = payment.description?.match(/\[medusa_session:([^\]]+)\]/);
                    if (descMatch) {
                        sessionId = descMatch[1];
                        this.logger_.info(`Fena webhook: recovered session_id from description: ${sessionId}`);
                    }
                }
                catch (e) {
                    // Try Recurring Payment
                    const recurring = await this.client_.getRecurringPayment(fenaPaymentId);
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
                case fena_client_1.FenaPaymentStatus.Paid:
                    return {
                        action: utils_1.PaymentActions.SUCCESSFUL,
                        data: payloadData,
                    };
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
        // 1. Fetch recurring payment from Fena to get notes
        let recurring;
        try {
            recurring = await this.client_.getRecurringPayment(fenaPaymentId);
        }
        catch {
            this.logger_.info(`Fena subscription handler: could not fetch recurring ${fenaPaymentId}, skipping`);
            return;
        }
        // 2. Find medusa_subscription:xxx note
        const notes = recurring.notes || [];
        const subNote = notes.find((n) => n.text?.startsWith("medusa_subscription:"));
        if (!subNote) {
            this.logger_.info(`Fena subscription handler: no medusa_subscription note for ${fenaPaymentId}, skipping`);
            return;
        }
        const subscriptionId = subNote.text.replace("medusa_subscription:", "");
        this.logger_.info(`Fena subscription handler: event="${eventName}" status="${status}" for subscription ${subscriptionId}`);
        // 3. Resolve Medusa services from container
        const subscriptionModule = this.container_["subscriptionModuleService"];
        const notificationModule = this.container_[utils_1.Modules.NOTIFICATION];
        const query = this.container_["query"];
        if (!subscriptionModule || !query) {
            this.logger_.warn(`Fena subscription handler: subscription module or query not available, skipping`);
            return;
        }
        // 4. Fetch subscription
        const { data: subs } = await query.graph({
            entity: "subscription",
            fields: ["id", "status", "metadata", "interval", "period", "subscription_date"],
            filters: { id: subscriptionId },
        });
        const subscription = subs?.[0];
        if (!subscription) {
            this.logger_.warn(`Fena subscription handler: subscription ${subscriptionId} not found`);
            return;
        }
        const metadata = subscription.metadata || {};
        // 5. Handle based on event
        switch (eventName) {
            case "status-update": {
                const normalizedStatus = (status || "").toLowerCase();
                if (normalizedStatus === "active") {
                    // Standing order is now active — reactivate subscription
                    // Set next_order_date to tomorrow so the cron picks it up
                    const tomorrow = new Date();
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    await subscriptionModule.updateSubscriptions({
                        id: subscriptionId,
                        status: "active",
                        next_order_date: tomorrow,
                        metadata: {
                            ...metadata,
                            fena_payment_id: metadata.fena_renewal_id || fenaPaymentId,
                        },
                    });
                    this.logger_.info(`Fena subscription handler: reactivated subscription ${subscriptionId}, next_order_date=${tomorrow.toISOString().split("T")[0]}`);
                }
                else {
                    this.logger_.info(`Fena subscription handler: status-update to "${normalizedStatus}" for ${subscriptionId}, no action`);
                }
                break;
            }
            case "payment_made": {
                // Initial payment received (month 2). Order will be created by
                // cron when next_order_date is reached (set by status-update handler).
                this.logger_.info(`Fena subscription handler: payment_made for ${subscriptionId} — cron will create order`);
                break;
            }
            case "payment-missed": {
                // Standing order payment failed — send reminder email
                const renewalLink = metadata.fena_renewal_link;
                if (!renewalLink) {
                    this.logger_.warn(`Fena subscription handler: no renewal link for ${subscriptionId}, can't send reminder`);
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
                this.logger_.info(`Fena subscription handler: unhandled event "${eventName}" for ${subscriptionId}`);
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
     * Helper to retrieve either a single payment or a recurring payment.
     */
    async getPaymentOrRecurring(id) {
        try {
            // Check if it's a single payment first
            return await this.client_.getPayment(id);
        }
        catch (e) {
            // Try recurring
            try {
                return await this.client_.getRecurringPayment(id);
            }
            catch (recurringError) {
                throw new Error(`Failed to retrieve payment or recurring payment with ID ${id}`);
            }
        }
    }
}
FenaPaymentProviderService.identifier = exports.FENA_PROVIDER_ID;
exports.default = FenaPaymentProviderService;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvZmVuYS9zZXJ2aWNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7R0FXRzs7O0FBRUgscURBTWtDO0FBaUNsQyx1REFVOEI7QUEwQjlCLDJEQUEyRDtBQUMzRCxVQUFVO0FBQ1YsMkRBQTJEO0FBRTNEOzs7R0FHRztBQUNILFNBQVMsYUFBYSxDQUNsQixJQUF5QyxFQUN6QyxHQUFXO0lBRVgsSUFBSSxDQUFDLElBQUk7UUFBRSxPQUFPLFNBQVMsQ0FBQTtJQUMzQixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUE7SUFDdkIsT0FBTyxPQUFPLEtBQUssS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFBO0FBQ3hELENBQUM7QUFFRDs7R0FFRztBQUNILFNBQVMsYUFBYSxDQUFDLE9BQVk7SUFDL0IsSUFBSSxDQUFDLE9BQU87UUFBRSxPQUFPLEVBQUUsQ0FBQTtJQUN2QixNQUFNLEtBQUssR0FBRztRQUNWLE9BQU8sQ0FBQyxVQUFVLElBQUksT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsR0FBRyxPQUFPLENBQUMsVUFBVSxJQUFJLEVBQUUsSUFBSSxPQUFPLENBQUMsU0FBUyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJO1FBQ2hILE9BQU8sQ0FBQyxPQUFPO1FBQ2YsT0FBTyxDQUFDLFNBQVM7UUFDakIsT0FBTyxDQUFDLFNBQVM7UUFDakIsT0FBTyxDQUFDLElBQUk7UUFDWixPQUFPLENBQUMsUUFBUTtRQUNoQixPQUFPLENBQUMsV0FBVztRQUNuQixPQUFPLENBQUMsWUFBWSxFQUFFLFdBQVcsRUFBRTtRQUNuQyxPQUFPLENBQUMsS0FBSztLQUNoQixDQUFDLE1BQU0sQ0FBQyxPQUFP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