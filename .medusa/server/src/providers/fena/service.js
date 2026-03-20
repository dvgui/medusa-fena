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
            let customerEmail = (context?.customer?.email || context?.email || input.data?.email);
            if (!customerEmail && sessionId.startsWith("payses_")) {
                try {
                    const query = this.container_.resolve("query");
                    const { data: sessions } = await query.graph({
                        entity: "payment_session",
                        fields: ["payment_collection.cart.email", "payment_collection.cart.customer.email"],
                        filters: { id: sessionId }
                    });
                    const session = sessions[0];
                    if (session?.payment_collection?.cart) {
                        customerEmail = session.payment_collection.cart.email || session.payment_collection.cart.customer?.email;
                        this.logger_.info(`Fena: Recovered email from Cart Query: ${customerEmail || "still N/A"}`);
                    }
                }
                catch (err) {
                    this.logger_.warn(`Fena: Failed to query Cart for email — ${err.message}`);
                }
            }
            this.logger_.info(`Fena Debug — final customerEmail: ${customerEmail || "N/A"}`);
            const customerFirstName = context?.customer?.first_name || input.data?.first_name;
            const customerLastName = context?.customer?.last_name || input.data?.last_name;
            const customerNameFallback = input.data?.customer_name || input.data?.name;
            const customerName = (customerFirstName
                ? `${customerFirstName} ${customerLastName || ""}`.trim()
                : customerNameFallback);
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
                    notes: [{ text: `medusa_session:${sessionId}`, visibility: "private" }],
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
                    // Search in notes for medusa_session
                    const sessionNote = recurring.transactions?.[0]?.notes?.find((n) => n.key === "medusa_session") ||
                        recurring.notes?.find((n) => n.key === "medusa_session");
                    if (sessionNote) {
                        sessionId = sessionNote.value;
                        this.logger_.info(`[v2.1] Fena webhook: recovered session_id from recurring notes: ${sessionId}`);
                    }
                }
                if (!sessionId) {
                    sessionId = reference || "";
                    this.logger_.warn(`[v2.1] Fena webhook: no session_id found, using reference fallback: ${sessionId}`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvZmVuYS9zZXJ2aWNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7R0FXRzs7O0FBRUgscURBS2tDO0FBaUNsQyx1REFTOEI7QUEwQjlCLDJEQUEyRDtBQUMzRCxVQUFVO0FBQ1YsMkRBQTJEO0FBRTNEOzs7R0FHRztBQUNILFNBQVMsYUFBYSxDQUNsQixJQUF5QyxFQUN6QyxHQUFXO0lBRVgsSUFBSSxDQUFDLElBQUk7UUFBRSxPQUFPLFNBQVMsQ0FBQTtJQUMzQixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUE7SUFDdkIsT0FBTyxPQUFPLEtBQUssS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFBO0FBQ3hELENBQUM7QUFFRCwyREFBMkQ7QUFDM0Qsc0JBQXNCO0FBQ3RCLDJEQUEyRDtBQUU5QyxRQUFBLGdCQUFnQixHQUFHLFNBQVMsQ0FBQTtBQUV6QywyREFBMkQ7QUFDM0QsbUJBQW1CO0FBQ25CLDJEQUEyRDtBQUUzRCxNQUFNLDBCQUEyQixTQUFRLCtCQUFtRDtJQVF4RixZQUNJLFNBQStCLEVBQy9CLE9BQW1DO1FBRW5DLEtBQUssQ0FBQyxTQUFTLEVBQUUsT0FBTyxDQUFDLENBQUE7UUFFekIsSUFBSSxDQUFDLE9BQU8sR0FBRyxTQUFTLENBQUMsTUFBTSxDQUFBO1FBQy9CLElBQUksQ0FBQyxRQUFRLEdBQUcsT0FBTyxDQUFBO1FBQ3ZCLElBQUksQ0FBQyxVQUFVLEdBQUcsU0FBUyxDQUFBO1FBRTNCLGlDQUFpQztRQUNqQyxJQUFJLENBQUMsT0FBTyxHQUFHLElBQUksd0JBQVUsQ0FBQztZQUMxQixVQUFVLEVBQUUsT0FBTyxDQUFDLFVBQVU7WUFDOUIsY0FBYyxFQUFFLE9BQU8sQ0FBQyxjQUFjO1NBQ3pDLENBQUMsQ0FB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