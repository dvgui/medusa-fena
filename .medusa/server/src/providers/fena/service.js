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
exports.FENA_PROVIDER_ID = "fena";
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
            // Fena strictly requires a max 12-char alphanumeric reference
            const sessionId = getDataString(input.data, "session_id") ?? `cart_${Date.now()}`;
            const reference = sessionId.slice(-12);
            // Fena strictly requires the format "/^[0-9]*\.[0-9]{2}$/" 
            // Medusa v2 amounts are exact (20 = €20.00), not in cents.
            const formattedAmount = Number(amount).toFixed(2);
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
                    ? `${this.options_.redirectUrl.replace("{cart_id}", sessionId)}?country_code=${(context?.region?.id ||
                        context?.billing_address?.country_code ||
                        context?.shipping_address?.country_code ||
                        currency_code.substring(0, 2)).toLowerCase()}`
                    : undefined,
                description: `Order payment — ${currency_code.toUpperCase()}`,
            });
            const payment = response.result;
            this.logger_.info(`Fena: Payment created — ID: ${payment.id}, Link: ${payment.link}`);
            return {
                id: payment.id,
                data: {
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
        const fenaPaymentId = getDataString(input.data, "fena_payment_id");
        if (!fenaPaymentId) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Fena payment ID is required for authorization");
        }
        try {
            const payment = await this.client_.getPayment(fenaPaymentId);
            const status = this.mapFenaStatusToMedusa(payment.status);
            this.logger_.info(`Fena: authorizePayment — ID: ${fenaPaymentId}, Fena status: ${payment.status}, Medusa status: ${status}`);
            return {
                data: {
                    ...input.data,
                    fena_payment_status: payment.status,
                },
                status,
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
        const fenaPaymentId = getDataString(input.data, "fena_payment_id");
        if (!fenaPaymentId) {
            return { data: input.data };
        }
        try {
            const payment = await this.client_.getPayment(fenaPaymentId);
            if (payment.status === fena_client_1.FenaPaymentStatus.Paid) {
                this.logger_.info(`Fena: Payment ${fenaPaymentId} confirmed as paid`);
                return {
                    data: {
                        ...input.data,
                        fena_payment_status: payment.status,
                    },
                };
            }
            // If not paid yet, still return the data — the webhook will handle it
            this.logger_.warn(`Fena: capturePayment — payment ${fenaPaymentId} status is "${payment.status}", not "paid" yet`);
            return {
                data: {
                    ...input.data,
                    fena_payment_status: payment.status,
                },
            };
        }
        catch (error) {
            this.logger_.error(`Fena: capturePayment failed — ${(0, fena_client_1.getErrorMessage)(error)}`);
            return { data: input.data };
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
            status: "pending",
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
            const { id: fenaPaymentId, status: fenaStatus, amount, reference } = webhookData;
            this.logger_.info(`Fena webhook: Payment ${fenaPaymentId} — status: ${fenaStatus}, ref: ${reference}`);
            // Look up the full payment to get the session_id
            let sessionId = reference || "";
            // Try to get updated payment data from Fena for accuracy
            try {
                const payment = await this.client_.getPayment(fenaPaymentId);
                sessionId = payment.reference || sessionId;
            }
            catch {
                // Continue with webhook data if API lookup fails
            }
            const payloadData = {
                session_id: sessionId,
                amount: new utils_1.BigNumber(amount || 0),
            };
            // Map Fena payment statuses to Medusa payment actions
            switch (fenaStatus) {
                case fena_client_1.FenaPaymentStatus.Paid:
                    return {
                        action: utils_1.PaymentActions.SUCCESSFUL,
                        data: payloadData,
                    };
                case fena_client_1.FenaPaymentStatus.Pending:
                    return {
                        action: utils_1.PaymentActions.AUTHORIZED,
                        data: payloadData,
                    };
                case fena_client_1.FenaPaymentStatus.Sent:
                    // Payment link sent, waiting for customer — no action needed
                    return {
                        action: utils_1.PaymentActions.NOT_SUPPORTED,
                        data: payloadData,
                    };
                case fena_client_1.FenaPaymentStatus.Rejected:
                    return {
                        action: utils_1.PaymentActions.FAILED,
                        data: payloadData,
                    };
                case fena_client_1.FenaPaymentStatus.Cancelled:
                    return {
                        action: utils_1.PaymentActions.CANCELED,
                        data: payloadData,
                    };
                case fena_client_1.FenaPaymentStatus.Refunded:
                case fena_client_1.FenaPaymentStatus.PartialRefund:
                    return {
                        action: utils_1.PaymentActions.SUCCESSFUL,
                        data: payloadData,
                    };
                default:
                    this.logger_.info(`Fena webhook: Unhandled status "${fenaStatus}" for payment ${fenaPaymentId}`);
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
        const id = data.id;
        const status = data.status;
        if (typeof id !== "string" || typeof status !== "string")
            return null;
        return {
            id,
            status: status,
            reference: typeof data.reference === "string" ? data.reference : "",
            amount: typeof data.amount === "string" ? data.amount : "0",
            currency: typeof data.currency === "string" ? data.currency : "",
        };
    }
    /**
     * Maps Fena payment statuses to Medusa PaymentSessionStatus values.
     */
    mapFenaStatusToMedusa(fenaStatus) {
        switch (fenaStatus) {
            case fena_client_1.FenaPaymentStatus.Draft:
            case fena_client_1.FenaPaymentStatus.Sent:
            case fena_client_1.FenaPaymentStatus.Overdue:
                return "pending";
            case fena_client_1.FenaPaymentStatus.Pending:
                return "authorized";
            case fena_client_1.FenaPaymentStatus.Paid:
                return "captured";
            case fena_client_1.FenaPaymentStatus.Rejected:
                return "error";
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
}
FenaPaymentProviderService.identifier = exports.FENA_PROVIDER_ID;
exports.default = FenaPaymentProviderService;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9wcm92aWRlcnMvZmVuYS9zZXJ2aWNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7R0FXRzs7O0FBRUgscURBS2tDO0FBeUJsQyx1REFNOEI7QUF5QjlCLDJEQUEyRDtBQUMzRCxVQUFVO0FBQ1YsMkRBQTJEO0FBRTNEOzs7R0FHRztBQUNILFNBQVMsYUFBYSxDQUNsQixJQUF5QyxFQUN6QyxHQUFXO0lBRVgsSUFBSSxDQUFDLElBQUk7UUFBRSxPQUFPLFNBQVMsQ0FBQTtJQUMzQixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUE7SUFDdkIsT0FBTyxPQUFPLEtBQUssS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFBO0FBQ3hELENBQUM7QUFFRCwyREFBMkQ7QUFDM0Qsc0JBQXNCO0FBQ3RCLDJEQUEyRDtBQUU5QyxRQUFBLGdCQUFnQixHQUFHLE1BQU0sQ0FBQTtBQUV0QywyREFBMkQ7QUFDM0QsbUJBQW1CO0FBQ25CLDJEQUEyRDtBQUUzRCxNQUFNLDBCQUEyQixTQUFRLCtCQUFtRDtJQU94RixZQUNJLFNBQStCLEVBQy9CLE9BQW1DO1FBRW5DLEtBQUssQ0FBQyxTQUFTLEVBQUUsT0FBTyxDQUFDLENBQUE7UUFFekIsSUFBSSxDQUFDLE9BQU8sR0FBRyxTQUFTLENBQUMsTUFBTSxDQUFBO1FBQy9CLElBQUksQ0FBQyxRQUFRLEdBQUcsT0FBTyxDQUFBO1FBRXZCLGlDQUFpQztRQUNqQyxJQUFJLENBQUMsT0FBTyxHQUFHLElBQUksd0JBQVUsQ0FBQztZQUMxQixVQUFVLEVBQUUsT0FBTyxDQUFDLFVBQVU7WUFDOUIsY0FBYyxFQUFFLE9BQU8sQ0FBQyxjQUFjO1NBQ3pDLENBQUMsQ0FBQTtRQUVGLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFD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