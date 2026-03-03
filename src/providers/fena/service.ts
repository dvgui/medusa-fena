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

import {
    AbstractPaymentProvider,
    PaymentActions,
    MedusaError,
    BigNumber,
} from "@medusajs/framework/utils"
import type { Logger } from "@medusajs/framework/types"
import type {
    InitiatePaymentInput,
    InitiatePaymentOutput,
    AuthorizePaymentInput,
    AuthorizePaymentOutput,
    CapturePaymentInput,
    CapturePaymentOutput,
    CancelPaymentInput,
    CancelPaymentOutput,
    DeletePaymentInput,
    DeletePaymentOutput,
    RefundPaymentInput,
    RefundPaymentOutput,
    RetrievePaymentInput,
    RetrievePaymentOutput,
    UpdatePaymentInput,
    UpdatePaymentOutput,
    GetPaymentStatusInput,
    GetPaymentStatusOutput,
    ProviderWebhookPayload,
    WebhookActionResult,
    PaymentSessionStatus,
} from "@medusajs/framework/types"
import {
    FenaClient,
    FenaPaymentStatus,
    FenaPaymentMethod,
    getErrorMessage,
    type FenaWebhookPayload,
} from "../../lib/fena-client"

// ────────────────────────────────────────────────────────
// Provider options — configured in medusa-config.ts
// ────────────────────────────────────────────────────────

export type FenaPaymentProviderOptions = {
    /** Fena Integration ID (terminal-id) */
    terminalId: string
    /** Fena Integration Secret (terminal-secret) — UUID */
    terminalSecret: string
    /** Bank account ID to receive payments. Uses Fena default if omitted. */
    bankAccountId?: string
    /** Payment method — defaults to fena_ob (redirect) */
    paymentMethod?: FenaPaymentMethod
    /** Custom redirect URL after payment. Overrides the Fena dashboard setting. */
    redirectUrl?: string
    /** Webhook URL for Fena to send payment status updates */
    webhookUrl?: string
}

type InjectedDependencies = {
    logger: Logger
}

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

/**
 * Safely extracts a string from payment session `data` by key.
 * Returns `undefined` if the key doesn't exist or isn't a string.
 */
function getDataString(
    data: Record<string, unknown> | undefined,
    key: string
): string | undefined {
    if (!data) return undefined
    const value = data[key]
    return typeof value === "string" ? value : undefined
}

// ────────────────────────────────────────────────────────
// Provider identifier
// ────────────────────────────────────────────────────────

export const FENA_PROVIDER_ID = "fena"

// ────────────────────────────────────────────────────────
// Provider Service
// ────────────────────────────────────────────────────────

class FenaPaymentProviderService extends AbstractPaymentProvider<FenaPaymentProviderOptions> {
    static identifier = FENA_PROVIDER_ID

    protected logger_: Logger
    protected options_: FenaPaymentProviderOptions
    protected client_: FenaClient

    constructor(
        container: InjectedDependencies,
        options: FenaPaymentProviderOptions
    ) {
        super(container, options)

        this.logger_ = container.logger
        this.options_ = options

        // Initialize the Fena API client
        this.client_ = new FenaClient({
            terminalId: options.terminalId,
            terminalSecret: options.terminalSecret,
        })

        this.logger_.info("Fena Payment Provider initialized")
    }

    // ──────────────────────────────────────────────────────
    // initiatePayment
    // ──────────────────────────────────────────────────────

    /**
     * Creates a payment with Fena and returns the payment link.
     * The storefront should redirect the customer to this link, or
     * display it as a QR code.
     */
    async initiatePayment(
        input: InitiatePaymentInput
    ): Promise<InitiatePaymentOutput> {
        const { amount, currency_code, context } = input

        try {
            // Fena strictly requires a max 12-char alphanumeric reference
            const sessionId = getDataString(input.data, "session_id") ?? `cart_${Date.now()}`
            const reference = sessionId.slice(-12)

            // Fena strictly requires the format "/^[0-9]*\.[0-9]{2}$/" 
            // Medusa v2 amounts are exact (20 = €20.00), not in cents.
            const formattedAmount = Number(amount).toFixed(2)

            const response = await this.client_.createAndProcessPayment({
                reference,
                amount: formattedAmount,
                bankAccount: this.options_.bankAccountId,
                paymentMethod: this.options_.paymentMethod || FenaPaymentMethod.FenaOB,
                customerName: context?.customer?.first_name
                    ? `${context.customer.first_name} ${context.customer.last_name || ""}`.trim()
                    : undefined,
                customerEmail: context?.customer?.email ?? undefined,
                customRedirectUrl: this.options_.redirectUrl
                    ? `${this.options_.redirectUrl.replace("{cart_id}", sessionId)}?country_code=${(
                        (context as any)?.region?.id ||
                        (context as any)?.billing_address?.country_code ||
                        (context as any)?.shipping_address?.country_code ||
                        currency_code.substring(0, 2)
                    ).toLowerCase()}`
                    : undefined,
                description: `Order payment — ${currency_code.toUpperCase()}`,
            })

            const payment = response.result

            this.logger_.info(
                `Fena: Payment created — ID: ${payment.id}, Link: ${payment.link}`
            )

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
            }
        } catch (error: unknown) {
            const msg = getErrorMessage(error)
            this.logger_.error(`Fena: initiatePayment failed — ${msg}`)
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                `Failed to initiate Fena payment: ${msg}`
            )
        }
    }

    // ──────────────────────────────────────────────────────
    // authorizePayment
    // ──────────────────────────────────────────────────────

    /**
     * Checks the payment status with Fena to confirm authorization.
     * Called after customer returns from the Fena redirect.
     */
    async authorizePayment(
        input: AuthorizePaymentInput
    ): Promise<AuthorizePaymentOutput> {
        const fenaPaymentId = getDataString(input.data, "fena_payment_id")

        if (!fenaPaymentId) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Fena payment ID is required for authorization"
            )
        }

        try {
            const payment = await this.client_.getPayment(fenaPaymentId)

            const status = this.mapFenaStatusToMedusa(payment.status)

            this.logger_.info(
                `Fena: authorizePayment — ID: ${fenaPaymentId}, Fena status: ${payment.status}, Medusa status: ${status}`
            )

            return {
                data: {
                    ...input.data,
                    fena_payment_status: payment.status,
                },
                status,
            }
        } catch (error: unknown) {
            const msg = getErrorMessage(error)
            this.logger_.error(`Fena: authorizePayment failed — ${msg}`)
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                `Failed to authorize Fena payment: ${msg}`
            )
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
    async capturePayment(
        input: CapturePaymentInput
    ): Promise<CapturePaymentOutput> {
        const fenaPaymentId = getDataString(input.data, "fena_payment_id")

        if (!fenaPaymentId) {
            return { data: input.data }
        }

        try {
            const payment = await this.client_.getPayment(fenaPaymentId)

            if (payment.status === FenaPaymentStatus.Paid) {
                this.logger_.info(`Fena: Payment ${fenaPaymentId} confirmed as paid`)
                return {
                    data: {
                        ...input.data,
                        fena_payment_status: payment.status,
                    },
                }
            }

            // If not paid yet, still return the data — the webhook will handle it
            this.logger_.warn(
                `Fena: capturePayment — payment ${fenaPaymentId} status is "${payment.status}", not "paid" yet`
            )
            return {
                data: {
                    ...input.data,
                    fena_payment_status: payment.status,
                },
            }
        } catch (error: unknown) {
            this.logger_.error(`Fena: capturePayment failed — ${getErrorMessage(error)}`)
            return { data: input.data }
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
    async cancelPayment(
        input: CancelPaymentInput
    ): Promise<CancelPaymentOutput> {
        this.logger_.info(
            `Fena: cancelPayment — ID: ${getDataString(input.data, "fena_payment_id") ?? "unknown"}`
        )
        return {
            data: {
                ...input.data,
                fena_payment_status: FenaPaymentStatus.Cancelled,
            },
        }
    }

    // ──────────────────────────────────────────────────────
    // deletePayment
    // ──────────────────────────────────────────────────────

    /**
     * Deletes a payment session. Called when a customer changes their
     * payment method during checkout.
     */
    async deletePayment(
        input: DeletePaymentInput
    ): Promise<DeletePaymentOutput> {
        this.logger_.info(
            `Fena: deletePayment — ID: ${getDataString(input.data, "fena_payment_id") ?? "unknown"}`
        )
        return { data: input.data }
    }

    // ──────────────────────────────────────────────────────
    // refundPayment
    // ──────────────────────────────────────────────────────

    /**
     * Refunds are handled through the Fena dashboard.
     * The API doesn't expose a direct refund endpoint for single payments.
     * We log the request and return the current data.
     */
    async refundPayment(
        input: RefundPaymentInput
    ): Promise<RefundPaymentOutput> {
        this.logger_.warn(
            `Fena: refundPayment — refunds must be processed via the Fena dashboard. Payment ID: ${getDataString(input.data, "fena_payment_id") ?? "unknown"}, Amount: ${input.amount}`
        )
        return {
            data: {
                ...input.data,
                refund_note:
                    "Refund must be processed manually via the Fena merchant dashboard",
            },
        }
    }

    // ──────────────────────────────────────────────────────
    // retrievePayment
    // ──────────────────────────────────────────────────────

    /**
     * Retrieves payment details from Fena.
     */
    async retrievePayment(
        input: RetrievePaymentInput
    ): Promise<RetrievePaymentOutput> {
        const fenaPaymentId = getDataString(input.data, "fena_payment_id")

        if (!fenaPaymentId) {
            return { data: input.data }
        }

        try {
            const payment = await this.client_.getPayment(fenaPaymentId)
            return {
                data: {
                    ...input.data,
                    fena_payment_id: payment.id,
                    fena_payment_status: payment.status,
                    fena_reference: payment.reference,
                    amount: payment.amount,
                    currency: payment.currency,
                },
            }
        } catch (error: unknown) {
            this.logger_.error(`Fena: retrievePayment failed — ${getErrorMessage(error)}`)
            return { data: input.data }
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
    async updatePayment(
        input: UpdatePaymentInput
    ): Promise<UpdatePaymentOutput> {
        const { amount, currency_code } = input

        this.logger_.info(
            `Fena: updatePayment — ID: ${getDataString(input.data, "fena_payment_id") ?? "unknown"}, amount: ${amount}`
        )

        return {
            data: {
                ...input.data,
                amount: amount?.toString(),
                currency_code,
            },
            status: "pending" as PaymentSessionStatus,
        }
    }

    // ──────────────────────────────────────────────────────
    // getPaymentStatus
    // ──────────────────────────────────────────────────────

    /**
     * Checks the current payment status via the Fena API.
     */
    async getPaymentStatus(
        input: GetPaymentStatusInput
    ): Promise<GetPaymentStatusOutput> {
        const fenaPaymentId = getDataString(input.data, "fena_payment_id")

        if (!fenaPaymentId) {
            return { status: "pending" as PaymentSessionStatus }
        }

        try {
            const payment = await this.client_.getPayment(fenaPaymentId)
            return { status: this.mapFenaStatusToMedusa(payment.status) }
        } catch (error: unknown) {
            this.logger_.error(`Fena: getPaymentStatus failed — ${getErrorMessage(error)}`)
            return { status: "pending" as PaymentSessionStatus }
        }
    }

    // ──────────────────────────────────────────────────────
    // getWebhookActionAndData
    // ──────────────────────────────────────────────────────

    /**
     * Processes incoming Fena webhook notifications.
     * Maps Fena payment statuses to Medusa payment actions.
     */
    async getWebhookActionAndData(
        payload: ProviderWebhookPayload["payload"]
    ): Promise<WebhookActionResult> {
        try {
            const { data } = payload

            // Validate incoming webhook data shape
            const webhookData = this.parseFenaWebhookData(data)

            if (!webhookData) {
                this.logger_.warn("Fena webhook: Missing or invalid payment data")
                return {
                    action: PaymentActions.NOT_SUPPORTED,
                    data: {
                        session_id: "",
                        amount: new BigNumber(0),
                    },
                }
            }

            const { id: fenaPaymentId, status: fenaStatus, amount, reference } = webhookData

            this.logger_.info(
                `Fena webhook: Payment ${fenaPaymentId} — status: ${fenaStatus}, ref: ${reference}`
            )

            // Look up the full payment to get the session_id
            let sessionId = reference || ""

            // Try to get updated payment data from Fena for accuracy
            try {
                const payment = await this.client_.getPayment(fenaPaymentId)
                sessionId = payment.reference || sessionId
            } catch {
                // Continue with webhook data if API lookup fails
            }

            const payloadData = {
                session_id: sessionId,
                amount: new BigNumber(amount || 0),
            }

            // Map Fena payment statuses to Medusa payment actions
            switch (fenaStatus) {
                case FenaPaymentStatus.Paid:
                    return {
                        action: PaymentActions.SUCCESSFUL,
                        data: payloadData,
                    }

                case FenaPaymentStatus.Pending:
                    return {
                        action: PaymentActions.AUTHORIZED,
                        data: payloadData,
                    }

                case FenaPaymentStatus.Sent:
                    // Payment link sent, waiting for customer — no action needed
                    return {
                        action: PaymentActions.NOT_SUPPORTED,
                        data: payloadData,
                    }

                case FenaPaymentStatus.Rejected:
                    return {
                        action: PaymentActions.FAILED,
                        data: payloadData,
                    }

                case FenaPaymentStatus.Cancelled:
                    return {
                        action: PaymentActions.CANCELED,
                        data: payloadData,
                    }

                case FenaPaymentStatus.Refunded:
                case FenaPaymentStatus.PartialRefund:
                    return {
                        action: PaymentActions.SUCCESSFUL,
                        data: payloadData,
                    }

                default:
                    this.logger_.info(
                        `Fena webhook: Unhandled status "${fenaStatus}" for payment ${fenaPaymentId}`
                    )
                    return {
                        action: PaymentActions.NOT_SUPPORTED,
                        data: payloadData,
                    }
            }
        } catch (error: unknown) {
            this.logger_.error(
                `Fena webhook: Error processing webhook — ${getErrorMessage(error)}`
            )
            return {
                action: PaymentActions.FAILED,
                data: {
                    session_id: "",
                    amount: new BigNumber(0),
                },
            }
        }
    }

    // ──────────────────────────────────────────────────────
    // Private helpers
    // ──────────────────────────────────────────────────────

    /**
     * Validates and extracts webhook data from the raw payload.
     * Returns null if the data doesn't match expected shape.
     */
    private parseFenaWebhookData(
        data: Record<string, unknown>
    ): FenaWebhookPayload | null {
        if (typeof data !== "object" || data === null) return null

        const id = data.id
        const status = data.status

        if (typeof id !== "string" || typeof status !== "string") return null

        return {
            id,
            status: status as FenaPaymentStatus,
            reference: typeof data.reference === "string" ? data.reference : "",
            amount: typeof data.amount === "string" ? data.amount : "0",
            currency: typeof data.currency === "string" ? data.currency : "",
        }
    }

    /**
     * Maps Fena payment statuses to Medusa PaymentSessionStatus values.
     */
    private mapFenaStatusToMedusa(
        fenaStatus: FenaPaymentStatus
    ): PaymentSessionStatus {
        switch (fenaStatus) {
            case FenaPaymentStatus.Draft:
            case FenaPaymentStatus.Sent:
            case FenaPaymentStatus.Overdue:
                return "pending" as PaymentSessionStatus

            case FenaPaymentStatus.Pending:
                return "authorized" as PaymentSessionStatus

            case FenaPaymentStatus.Paid:
                return "captured" as PaymentSessionStatus

            case FenaPaymentStatus.Rejected:
                return "error" as PaymentSessionStatus

            case FenaPaymentStatus.Cancelled:
                return "canceled" as PaymentSessionStatus

            case FenaPaymentStatus.Refunded:
            case FenaPaymentStatus.PartialRefund:
            case FenaPaymentStatus.RefundStarted:
                return "captured" as PaymentSessionStatus

            default:
                return "pending" as PaymentSessionStatus
        }
    }
}

export default FenaPaymentProviderService
