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
    CreateAccountHolderInput,
    CreateAccountHolderOutput,
    SavePaymentMethodInput,
    SavePaymentMethodOutput,
    ListPaymentMethodsInput,
    ListPaymentMethodsOutput,
    DeleteAccountHolderInput,
    DeleteAccountHolderOutput,
} from "@medusajs/framework/types"
import {
    FenaClient,
    FenaPaymentStatus,
    FenaPaymentMethod,
    getErrorMessage,
    FenaManagedEntityType,
    FenaRecurringPaymentFrequency,
    type FenaWebhookPayload,
    type FenaRecurringPayment,
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

export const FENA_PROVIDER_ID = "fena-ob"

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
            const isRecurring = !!input.data?.is_recurring
            const sessionId = getDataString(input.data, "session_id") ?? `cart_${Date.now()}`
            const reference = sessionId.replace(/[^a-z0-9]/gi, "").slice(-12)
            const formattedAmount = Number(amount).toFixed(2)

            if (isRecurring) {
                // 1. Calculate 6-working-day delay (at least)
                const startDate = new Date()
                let addedDays = 0
                while (addedDays < 6) {
                    startDate.setDate(startDate.getDate() + 1)
                    const day = startDate.getDay()
                    if (day !== 0 && day !== 6) { // Skip Sunday(0) and Saturday(6)
                        addedDays++
                    }
                }

                // Determine frequency and other recurring params from metadata or default
                const frequency = (input.data?.frequency as FenaRecurringPaymentFrequency) || FenaRecurringPaymentFrequency.OneMonth

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
                })

                const payment = response.result
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
                }
            }

            // Standard Single Payment
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
                    ? this.options_.redirectUrl.replace("{cart_id}", sessionId)
                    : undefined,
                // Embed full Medusa session ID in description so we can recover it in webhooks
                description: `[medusa_session:${sessionId}] Order payment — ${currency_code.toUpperCase()}`,
            })

            const payment = response.result

            this.logger_.info(
                `Fena: Payment created — ID: ${payment.id}, Link: ${payment.link}`
            )

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
        const { data, context } = input
        const fenaPaymentId = getDataString(data, "fena_payment_id") || getDataString(data, "fena_recurring_id")

        if (!fenaPaymentId) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Fena payment ID is required for authorization"
            )
        }

        try {
            // Handle off-session renewals or passive records
            const isPassive = input.data?.is_passive || (input.context as any)?.is_passive
            const isOffSession = input.data?.off_session || (input.context as any)?.off_session

            if (isPassive || isOffSession) {
                this.logger_.info(`Fena: authorizePayment (${isPassive ? "passive" : "off-session"}) — confirming context ${fenaPaymentId}`)
                
                if (isPassive) {
                    return {
                        data: {
                            ...input.data,
                            fena_payment_status: "paid",
                        },
                        status: "captured" as PaymentSessionStatus,
                    }
                }
                
                // For standing orders, we just check if it's still active.
                // The actual money capture will happen via webhook when the bank pushes.
                const payment = await this.getPaymentOrRecurring(fenaPaymentId)
                const status = this.mapFenaStatusToMedusa(payment.status)
                
                return {
                    data: {
                        ...input.data,
                        fena_payment_status: payment.status,
                    },
                    status,
                }
            }

            const payment = await this.getPaymentOrRecurring(fenaPaymentId)
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
        const fenaPaymentId = getDataString(input.data, "fena_payment_id") || getDataString(input.data, "fena_recurring_id")

        if (!fenaPaymentId) {
            return { data: input.data }
        }

        try {
            const payment = await this.getPaymentOrRecurring(fenaPaymentId)

            if (payment.status === FenaPaymentStatus.Paid || payment.status === "active" || payment.status === "payment-made") {
                this.logger_.info(`Fena: Payment ${fenaPaymentId} confirmed as captured/active`)
                return {
                    data: {
                        ...input.data,
                        fena_payment_status: payment.status,
                    },
                }
            }

            // Payment NOT confirmed by the bank yet — throw so Medusa does NOT
            // mark this as captured. The event-bus will retry the subscriber,
            // and when Fena sends the "paid" webhook, PaymentActions.SUCCESSFUL
            // will handle the capture automatically.
            const msg = `Fena: capturePayment — payment ${fenaPaymentId} status is "${payment.status}", not "paid" yet. Capture will be retried.`
            this.logger_.warn(msg)
            throw new MedusaError(MedusaError.Types.PAYMENT_REQUIRES_MORE_ERROR, msg)
        } catch (error: unknown) {
            // Re-throw intentional MedusaErrors (e.g. payment not yet confirmed)
            if (error instanceof MedusaError) throw error
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

            const { id: fenaPaymentId, status: webhookStatus, amount, reference } = webhookData

            this.logger_.info(
                `Fena webhook: Payment ${fenaPaymentId} — status: ${webhookStatus}, ref: ${reference}`
            )

            // The reference is only 12 chars (truncated). We need the full Medusa session ID.
            // We encoded it in the payment description as: [medusa_session:payses_...]
            // Call Fena API to get the full payment details and extract the session ID.
            let sessionId = ""
            // Use the authentic status from the API instead of trusting the webhook payload
            let authenticStatus = webhookStatus

            try {
                // Try Single Payment first
                try {
                    const payment = await this.client_.getPayment(fenaPaymentId)
                    authenticStatus = payment.status

                    const descMatch = payment.description?.match(/\[medusa_session:([^\]]+)\]/)
                    if (descMatch) {
                        sessionId = descMatch[1]
                        this.logger_.info(`Fena webhook: recovered session_id from description: ${sessionId}`)
                    }
                } catch (e) {
                    // Try Recurring Payment
                    const recurring = await this.client_.getRecurringPayment(fenaPaymentId)
                    authenticStatus = recurring.status
                    
                    // Search in notes for medusa_session
                    const sessionNote = recurring.transactions?.[0]?.notes?.find((n: any) => n.key === "medusa_session") || 
                                       (recurring as any).notes?.find((n: any) => n.key === "medusa_session")
                    
                    if (sessionNote) {
                        sessionId = sessionNote.value
                        this.logger_.info(`Fena webhook: recovered session_id from recurring notes: ${sessionId}`)
                    }
                }

                if (!sessionId) {
                    sessionId = reference || ""
                    this.logger_.warn(`Fena webhook: no session_id found, using reference fallback: ${sessionId}`)
                }
            } catch (err: any) {
                sessionId = reference || ""
                this.logger_.error(`Fena webhook: failed to fetch payment for session recovery: ${err.message}`)
            }

            this.logger_.info(`Fena webhook: resolved session_id: ${sessionId}, authentic_status: ${authenticStatus}`)

            const payloadData = {
                session_id: sessionId,
                amount: new BigNumber(amount || 0),
            }

            const normalizedStatus = authenticStatus.toLowerCase()

            // Map authentic Fena payment status to Medusa payment actions
            switch (normalizedStatus) {
                case "active":
                case "payment-made":
                case "payment-confirmed":
                case "paid":
                case FenaPaymentStatus.Paid:
                    return {
                        action: PaymentActions.SUCCESSFUL,
                        data: payloadData,
                    }

                case "sent":
                case "pending":
                case FenaPaymentStatus.Sent:
                case FenaPaymentStatus.Pending:
                    return {
                        action: PaymentActions.AUTHORIZED,
                        data: payloadData,
                    }

                case "payment-missed":
                case "cancelled":
                case FenaPaymentStatus.Cancelled:
                case FenaPaymentStatus.Rejected:
                    return {
                        action: PaymentActions.FAILED,
                        data: payloadData,
                    }

                case "refunded":
                case "partial-refund":
                case FenaPaymentStatus.Refunded:
                case FenaPaymentStatus.PartialRefund:
                    return {
                        action: PaymentActions.SUCCESSFUL,
                        data: payloadData,
                    }

                default:
                    this.logger_.info(
                        `Fena webhook: Unhandled status "${normalizedStatus}" for payment ${fenaPaymentId}`
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

        const id = (data.id || (data as any).recurring_id) as string
        const status = (data.status || (data as any).statusName) as string
        const eventScope = data.eventScope as string
        const eventName = data.eventName as string

        if (typeof id !== "string" || (typeof status !== "string" && !eventName)) return null

        return {
            id,
            status: (status || eventName) as FenaPaymentStatus,
            reference: (typeof data.reference === "string" ? data.reference : "") || 
                       (typeof (data as any).invoiceRefNumber === "string" ? (data as any).invoiceRefNumber : ""),
            amount: (typeof data.amount === "string" ? data.amount : "") || 
                    (typeof (data as any).recurringAmount === "string" ? (data as any).recurringAmount : "0"),
            currency: typeof data.currency === "string" ? data.currency : "GBP",
            eventScope,
            eventName,
            notes: (data as any).notes
        }
    }

    // ──────────────────────────────────────────────────────
    // Account Holder (Medusa v2.5+)
    // ──────────────────────────────────────────────────────

    /**
     * Creates an account holder in Fena (Managed Entity).
     */
    async createAccountHolder({ context, data }: CreateAccountHolderInput): Promise<CreateAccountHolderOutput> {
        const { account_holder, customer } = context

        if (account_holder?.data?.id) {
            return { id: account_holder.data.id as string }
        }

        if (!customer) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Missing customer data for Fena Account Holder creation."
            )
        }

        try {
            this.logger_.info(`Fena: creating local account holder for ${customer.email}`)
            
            const managedEntity = await this.client_.createManagedEntity({
                name: `${customer.first_name} ${customer.last_name || ""}`.trim() || customer.email,
                type: FenaManagedEntityType.Consumer,
            })

            return {
                id: managedEntity.id,
                data: managedEntity as any,
            }
        } catch (error: any) {
            this.logger_.error(`Fena: createAccountHolder failed — ${getErrorMessage(error)}`)
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                `Failed to create Fena Managed Entity: ${getErrorMessage(error)}`
            )
        }
    }

    /**
     * Saves a payment method for an account holder.
     * For Fena recurring, this is the Standing Order authorization.
     */
    async savePaymentMethod({ context, data }: SavePaymentMethodInput): Promise<SavePaymentMethodOutput> {
        const fenaPaymentId = getDataString(data, "fena_payment_id")

        if (!fenaPaymentId) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Missing Fena payment ID to save payment method."
            )
        }

        return {
            id: fenaPaymentId,
            data: {
                ...data,
                fena_saved_payment_id: fenaPaymentId,
            },
        }
    }

    /**
     * Lists saved payment methods for an account holder.
     */
    async listPaymentMethods(context: ListPaymentMethodsInput): Promise<ListPaymentMethodsOutput> {
        // Return saved payment methods if available in Medusa account holder data
        return []
    }

    /**
     * Deletes an account holder in Fena.
     */
    async deleteAccountHolder(context: DeleteAccountHolderInput): Promise<DeleteAccountHolderOutput> {
        // Optional: delete managed entity in Fena if desired
        return {}
    }

    /**
     * Maps Fena payment statuses to Medusa PaymentSessionStatus values.
     */
    private mapFenaStatusToMedusa(
        fenaStatus: FenaPaymentStatus | string
    ): PaymentSessionStatus {
        const normalizedStatus = (fenaStatus as string).toLowerCase()

        switch (normalizedStatus) {
            case "active":
            case "payment-made":
            case "payment-confirmed":
            case "paid":
            case FenaPaymentStatus.Paid:
                return "captured" as PaymentSessionStatus

            case "sent":
            case "pending":
            case FenaPaymentStatus.Sent:
            case FenaPaymentStatus.Pending:
                return "authorized" as PaymentSessionStatus

            case "draft":
            case "overdue":
            case FenaPaymentStatus.Draft:
            case FenaPaymentStatus.Overdue:
                return "pending" as PaymentSessionStatus

            case "payment-missed":
            case FenaPaymentStatus.Rejected:
                return "error" as PaymentSessionStatus

            case "cancelled":
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

    /**
     * Helper to retrieve either a single payment or a recurring payment.
     */
    private async getPaymentOrRecurring(id: string): Promise<any> {
        try {
            // Check if it's a single payment first
            return await this.client_.getPayment(id)
        } catch (e) {
            // Try recurring
            try {
                return await this.client_.getRecurringPayment(id)
            } catch (recurringError) {
                throw new Error(`Failed to retrieve payment or recurring payment with ID ${id}`)
            }
        }
    }
}

export default FenaPaymentProviderService
