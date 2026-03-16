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
                    customerName: context?.customer?.first_name
                        ? `${context.customer.first_name} ${context.customer.last_name || ""}`.trim()
                        : "Customer",
                    customerEmail: context?.customer?.email || "unknown@example.com",
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
                customerName: context?.customer?.first_name
                    ? `${context.customer.first_name} ${context.customer.last_name || ""}`.trim()
                    : undefined,
                customerEmail: context?.customer?.email ?? undefined,
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
            this.logger_.info(`[v2.4] Fena: authorizePayment — ID: ${fenaPaymentId}, Fena status: ${payment.status}, confirmed: ${isConfirmed}, isSent: ${isSent}`);
            return {
                data: {
                    ...input.data,
                    fena_payment_status: payment.status,
                },
                status: (isConfirmed || isSent ? "authorized" : "pending"),
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
            const msg = `[v2.4] Fena: capturePayment — payment ${fenaPaymentId} status is "${payment.status}", not "paid" yet. Capture will be retried.`;
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
            this.logger_.error(`[v2.4] Fena: capturePayment failed — ${(0, fena_client_1.getErrorMessage)(error)}`);
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
                    // "sent" = payment request sent to bank. Return AUTHORIZED to
                    // allow order creation, but capturePayment will reject it until "paid".
                    this.logger_.info(`[v2.4] Fena webhook: status "sent" — returning AUTHORIZED.`);
                    return {
                        action: utils_1.PaymentActions.AUTHORIZED,
                        data: payloadData,
                    };
                case "pending":
                case fena_client_1.FenaPaymentStatus.Pending:
                    // Truly pending — not yet sent to bank.
                    return {
                        action: utils_1.PaymentActions.PENDING,
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
            case fena_client_1.FenaPaymentStatus.Sent:
            case fena_client_1.FenaPaymentStatus.Pending:
                return "authorized";
            case "draft":
            case "overdue":
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvZmVuYS9zZXJ2aWNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7R0FXRzs7O0FBRUgscURBS2tDO0FBaUNsQyx1REFTOEI7QUF5QjlCLDJEQUEyRDtBQUMzRCxVQUFVO0FBQ1YsMkRBQTJEO0FBRTNEOzs7R0FHRztBQUNILFNBQVMsYUFBYSxDQUNsQixJQUF5QyxFQUN6QyxHQUFXO0lBRVgsSUFBSSxDQUFDLElBQUk7UUFBRSxPQUFPLFNBQVMsQ0FBQTtJQUMzQixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUE7SUFDdkIsT0FBTyxPQUFPLEtBQUssS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFBO0FBQ3hELENBQUM7QUFFRCwyREFBMkQ7QUFDM0Qsc0JBQXNCO0FBQ3RCLDJEQUEyRDtBQUU5QyxRQUFBLGdCQUFnQixHQUFHLFNBQVMsQ0FBQTtBQUV6QywyREFBMkQ7QUFDM0QsbUJBQW1CO0FBQ25CLDJEQUEyRDtBQUUzRCxNQUFNLDBCQUEyQixTQUFRLCtCQUFtRDtJQU94RixZQUNJLFNBQStCLEVBQy9CLE9BQW1DO1FBRW5DLEtBQUssQ0FBQyxTQUFTLEVBQUUsT0FBTyxDQUFDLENBQUE7UUFFekIsSUFBSSxDQUFDLE9BQU8sR0FBRyxTQUFTLENBQUMsTUFBTSxDQUFBO1FBQy9CLElBQUksQ0FBQyxRQUFRLEdBQUcsT0FBTyxDQUFBO1FBRXZCLGlDQUFpQztRQUNqQyxJQUFJLENBQUMsT0FBTyxHQUFHLElBQUksd0JBQVUsQ0FBQztZQUMxQixVQUFVLEVBQUUsT0FBTyxDQUFDLFVBQVU7WUFDOUIsY0FBYyxFQUFFLE9BQU8sQ0FBQyxjQUFjO1NBQ3pDLENBQUMsQ0FBQTtRQUVGLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFD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