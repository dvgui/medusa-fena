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
                });
                const payment = response.result;
                // Attach notes AFTER creation — create-and-process doesn't persist notes
                try {
                    await this.client_.attachRecurringPaymentNote(payment.id, {
                        text: `medusa_session:${sessionId}`,
                        visibility: "restricted",
                    });
                    if (shippingAddress) {
                        await this.client_.attachRecurringPaymentNote(payment.id, {
                            text: `Shipping: ${shippingAddress}`,
                            visibility: "restricted",
                        });
                    }
                    if (billingAddress) {
                        await this.client_.attachRecurringPaymentNote(payment.id, {
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
        try {
            const payment = await this.getPaymentOrRecurring(fenaPaymentId);
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
        // Note format: "medusa_subscription:id1" or "medusa_subscription:id1,id2" (multiple subs from same order)
        const subscriptionIds = subNote.text.replace("medusa_subscription:", "").split(",").filter(Boolean);
        this.logger_.info(`Fena subscription handler: event="${eventName}" status="${status}" for subscriptions ${subscriptionIds.join(", ")}`);
        // 3. Resolve Medusa services from container
        const subscriptionModule = this.container_["subscriptionModuleService"];
        const notificationModule = this.container_[utils_1.Modules.NOTIFICATION];
        const query = this.container_["query"];
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
                // Initial payment received. Order will be created by cron
                // when next_order_date is reached (set by status-update handler).
                this.logger_.info(`Fena subscription handler: payment_made for ${subscriptions.length} subscriptions — cron will create order`);
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