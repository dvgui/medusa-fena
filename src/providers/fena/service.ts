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
    Modules,
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
    type FenaPaymentNote,
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
    [key: string]: any
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

/**
 * Format a Medusa address into a single readable string for Fena notes.
 */
function formatAddress(address: any): string {
    if (!address) return ""
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
    ].filter(Boolean)
    return parts.join(", ")
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
    protected container_: InjectedDependencies

    constructor(
        container: InjectedDependencies,
        options: FenaPaymentProviderOptions
    ) {
        super(container, options)

        this.logger_ = container.logger
        this.options_ = options
        this.container_ = container

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

            // Extract customer info: context.customer (logged-in) or input.data (guest)
            let customerEmail = context?.customer?.email || (input.data as any)?.email
            const customerFirstName = context?.customer?.first_name || (input.data as any)?.first_name
            const customerLastName = context?.customer?.last_name || (input.data as any)?.last_name
            const customerNameFromData = (input.data as any)?.customer_name || (input.data as any)?.name

            // Secondary fallback: none. We strictly rely on data passed from the storefront/workflow.
            // (Note: cross-module queries are restricted in v2 providers)
            if (!customerEmail) {
                this.logger_.warn(`Fena: No customer email provided for session: ${sessionId}`)
            }

            const customerName = (customerFirstName
                ? `${customerFirstName} ${customerLastName || ""}`.trim()
                : customerNameFromData) as string | undefined

            this.logger_.info(`Fena Debug — final customerEmail: ${customerEmail || "N/A"}, customerName: ${customerName || "N/A"}`)

            this.logger_.info(
                `Fena: Creating ${isRecurring ? "recurring " : ""}payment for ${sessionId} — Email: ${customerEmail || "N/A"}, Name: ${customerName || "N/A"}`
            )

            if (isRecurring) {
                // Determine frequency and period for recurring date calculation
                const frequency = (input.data?.frequency as FenaRecurringPaymentFrequency) || FenaRecurringPaymentFrequency.OneMonth

                // Calculate first standing order debit date = 1 cycle from now
                // (customer pays month 1 via initialPaymentAmount, standing order starts month 2)
                const startDate = new Date()
                switch (frequency) {
                    case FenaRecurringPaymentFrequency.OneWeek:
                        startDate.setDate(startDate.getDate() + 7)
                        break
                    case FenaRecurringPaymentFrequency.OneMonth:
                        startDate.setMonth(startDate.getMonth() + 1)
                        break
                    case FenaRecurringPaymentFrequency.ThreeMonths:
                        startDate.setMonth(startDate.getMonth() + 3)
                        break
                    case FenaRecurringPaymentFrequency.OneYear:
                        startDate.setFullYear(startDate.getFullYear() + 1)
                        break
                    default:
                        startDate.setMonth(startDate.getMonth() + 1)
                }

                // Fena requires the date to be a working day AND at least 6 working days out.
                // If it falls on a weekend, advance to Monday.
                const dayOfWeek = startDate.getDay()
                if (dayOfWeek === 0) startDate.setDate(startDate.getDate() + 1) // Sunday → Monday
                if (dayOfWeek === 6) startDate.setDate(startDate.getDate() + 2) // Saturday → Monday

                // Ensure at least 6 working days from now
                const minDate = new Date()
                let workDays = 0
                while (workDays < 6) {
                    minDate.setDate(minDate.getDate() + 1)
                    const d = minDate.getDay()
                    if (d !== 0 && d !== 6) workDays++
                }
                if (startDate < minDate) {
                    startDate.setTime(minDate.getTime())
                }

                const shippingAddress = formatAddress((input.data as any)?.shipping_address)
                const billingAddress = formatAddress((input.data as any)?.billing_address)

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
                })

                const payment = response.result

                // Attach notes AFTER creation — create-and-process doesn't persist notes
                try {
                    await this.client_.attachRecurringPaymentNote(payment.id, {
                        text: `medusa_session:${sessionId}`,
                        visibility: "restricted",
                    })
                    if (shippingAddress) {
                        await this.client_.attachRecurringPaymentNote(payment.id, {
                            text: `Shipping: ${shippingAddress}`,
                            visibility: "restricted",
                        })
                    }
                    if (billingAddress) {
                        await this.client_.attachRecurringPaymentNote(payment.id, {
                            text: `Billing: ${billingAddress}`,
                            visibility: "restricted",
                        })
                    }
                } catch (noteErr: unknown) {
                    this.logger_.warn(`Fena: Failed to attach notes to recurring ${payment.id}: ${getErrorMessage(noteErr)}`)
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
                }
            }


            const shippingAddress = formatAddress((input.data as any)?.shipping_address)
            const billingAddress = formatAddress((input.data as any)?.billing_address)

            const notes: any[] = []
            if (shippingAddress) notes.push({ text: `Shipping: ${shippingAddress}`, visibility: "restricted" })
            if (billingAddress) notes.push({ text: `Billing: ${billingAddress}`, visibility: "restricted" })

            // Standard Single Payment
            const response = await this.client_.createAndProcessPayment({
                reference,
                amount: formattedAmount,
                bankAccount: this.options_.bankAccountId,
                paymentMethod: this.options_.paymentMethod || FenaPaymentMethod.FenaOB,
                customerName,
                customerEmail,
                customRedirectUrl: this.options_.redirectUrl
                    ? this.options_.redirectUrl.replace("{cart_id}", sessionId)
                    : undefined,
                // Embed full Medusa session ID in description so we can recover it in webhooks
                description: `[medusa_session:${sessionId}] Order payment — ${currency_code.toUpperCase()}`,
                notes,
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

            // For recurring payments, Fena leaves the parent `status` at "sent" even after
            // the initial charge has cleared at the bank — the truth lives in
            // `initialPayment.status`. Treat a paid initial charge as authoritative so the
            // Medusa session can authorize on first-signup. Singles don't have this field,
            // so the optional chain is a no-op for the single-payment path.
            const initialPaidOnRecurring =
                (payment as FenaRecurringPayment).initialPayment?.status === "paid"
            const effectiveStatus = initialPaidOnRecurring ? "paid" : payment.status
            const fenaStatus = effectiveStatus.toLowerCase()
            const confirmedStatuses = ["paid", "active", "payment-made", "payment-confirmed"]
            const isConfirmed = confirmedStatuses.includes(fenaStatus)
            const isSent = fenaStatus === "sent" || fenaStatus === FenaPaymentStatus.Sent

            this.logger_.info(
                `[v2.5] Fena: authorizePayment — ID: ${fenaPaymentId}, Fena status: ${payment.status}, initialPaid: ${initialPaidOnRecurring}, confirmed: ${isConfirmed}, isSent: ${isSent}`
            )

            return {
                data: {
                    ...input.data,
                    fena_payment_status: payment.status,
                },
                status: (isConfirmed ? "authorized" : "pending") as PaymentSessionStatus,
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

            // Accept recurring.initialPayment.status === "paid" as capture confirmation —
            // same reasoning as authorizePayment (Fena leaves the recurring parent at "sent"
            // after the initial charge clears). Singles don't have initialPayment, so this
            // is a strict addition that never fires on the single-payment path.
            const initialPaidOnRecurring =
                (payment as FenaRecurringPayment).initialPayment?.status === "paid"

            if (
                initialPaidOnRecurring ||
                payment.status === FenaPaymentStatus.Paid ||
                payment.status === "active" ||
                payment.status === "payment-made"
            ) {
                this.logger_.info(
                    `Fena: Payment ${fenaPaymentId} confirmed as captured/active (initialPaid: ${initialPaidOnRecurring})`
                )
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
            const msg = `[v2.5] Fena: capturePayment — payment ${fenaPaymentId} status is "${payment.status}", not "paid" yet. Capture will be retried.`
            this.logger_.warn(msg)
            throw new MedusaError(MedusaError.Types.PAYMENT_REQUIRES_MORE_ERROR, msg)
        } catch (error: unknown) {
            // Re-throw intentional MedusaErrors (robust check for cross-module boundary issues)
            const isMedusaError = error instanceof MedusaError ||
                (error as any)?.name === "MedusaError" ||
                (error as any)?.constructor?.name === "MedusaError"

            if (isMedusaError) {
                throw error
            }

            this.logger_.error(`[v2.5] Fena: capturePayment failed — ${getErrorMessage(error)}`)
            // Don't return success data if we failed – throw something to stop Medusa
            throw error
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

            // ── Recurring-payment webhook events ──────────────────────
            // Medusa's process-payment workflow requires a pre-existing
            // payment session, which doesn't exist for standing-order
            // renewals. We handle subscription side-effects here and
            // ALWAYS return NOT_SUPPORTED so Medusa's built-in flow
            // never runs (which would crash). Single-payment webhooks
            // are completely unaffected — they skip this block.
            const isRecurringEvent = webhookData.eventScope === "recurring-payments"

            if (isRecurringEvent) {
                this.logger_.info(
                    `Fena webhook: recurring event "${webhookData.eventName}" for ${fenaPaymentId}`
                )

                // Handle subscription side-effects (safe — wrapped in try/catch)
                try {
                    await this.handleRecurringSubscriptionEvent(
                        fenaPaymentId,
                        webhookData.eventName || "",
                        webhookData.status as string,
                    )
                } catch (err: any) {
                    this.logger_.error(
                        `Fena webhook: subscription handler error — ${err.message}`
                    )
                }

                return {
                    action: PaymentActions.NOT_SUPPORTED,
                    data: {
                        session_id: "",
                        amount: new BigNumber(amount || 0),
                    },
                }
            }

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

                    // Search in notes for medusa_session (stored as { text: "medusa_session:xxx" })
                    const sessionNote = recurring.transactions?.[0]?.notes?.find((n: any) => n.text?.startsWith("medusa_session:")) ||
                        (recurring as any).notes?.find((n: any) => n.text?.startsWith("medusa_session:"))

                    if (sessionNote) {
                        const match = sessionNote.text.match(/medusa_session:(.+)/)
                        sessionId = match?.[1] || ""
                        this.logger_.info(`Fena webhook: recovered session_id from recurring notes: ${sessionId}`)
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
                        const paymentModule: any = this.container_.resolve(Modules.PAYMENT)
                        const pendingSessions: any[] = await paymentModule.listPaymentSessions(
                            { status: "pending" },
                            { take: 50, order: { created_at: "DESC" } }
                        )
                        const webhookAmount = Number(amount || 0)
                        const match = pendingSessions.find(
                            (s) =>
                                s.provider_id?.toLowerCase().includes("fena") &&
                                s.data?.fena_reference === reference &&
                                Number(s.amount) === webhookAmount
                        )
                        if (match?.id) {
                            sessionId = match.id
                            this.logger_.info(
                                `Fena webhook: recovered session_id via reverse lookup (fena_reference=${reference}, amount=${webhookAmount}): ${sessionId} (scanned ${pendingSessions.length} pending)`
                            )
                        } else {
                            this.logger_.warn(
                                `Fena webhook: reverse lookup found no match (ref=${reference}, amount=${webhookAmount}, scanned ${pendingSessions.length} pending)`
                            )
                        }
                    } catch (lookupErr: any) {
                        this.logger_.warn(
                            `Fena webhook: reverse lookup failed — ${lookupErr.message}`
                        )
                    }
                }

                if (!sessionId) {
                    sessionId = reference || ""
                    this.logger_.warn(`Fena webhook: no session_id found, using reference fallback: ${sessionId}`)
                }
            } catch (err: any) {
                sessionId = reference || ""
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
                case FenaPaymentStatus.Sent:
                    // "sent" = payment request sent to bank. Return NOT_SUPPORTED to
                    // avoid triggering Medusa's authorization workflow prematurely. 
                    this.logger_.info(`[v2.5] Fena webhook: status "sent" — returning NOT_SUPPORTED.`)
                    return {
                        action: PaymentActions.NOT_SUPPORTED,
                        data: payloadData,
                    }

                case "pending":
                case FenaPaymentStatus.Pending:
                    // Truly pending — not yet sent to bank. Return NOT_SUPPORTED
                    // to avoid triggering Medusa's authorization workflow prematurely. 
                    this.logger_.info(`[v2.5] Fena webhook: status "pending" — returning NOT_SUPPORTED.`)
                    return {
                        action: PaymentActions.NOT_SUPPORTED,
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
    private async handleRecurringSubscriptionEvent(
        fenaPaymentId: string,
        eventName: string,
        status: string,
    ): Promise<void> {
        // 1. Fetch recurring payment from Fena to get notes
        let recurring: FenaRecurringPayment
        try {
            recurring = await this.client_.getRecurringPayment(fenaPaymentId)
        } catch {
            this.logger_.info(`Fena subscription handler: could not fetch recurring ${fenaPaymentId}, skipping`)
            return
        }

        // 2. Find medusa_subscription:xxx note
        const notes = recurring.notes || []
        const subNote = notes.find((n) => n.text?.startsWith("medusa_subscription:"))
        if (!subNote) {
            this.logger_.info(`Fena subscription handler: no medusa_subscription note for ${fenaPaymentId}, skipping`)
            return
        }

        // Note format: "medusa_subscription:id1" or "medusa_subscription:id1,id2" (multiple subs from same order)
        const subscriptionIds = subNote.text.replace("medusa_subscription:", "").split(",").filter(Boolean)
        this.logger_.info(`Fena subscription handler: event="${eventName}" status="${status}" for subscriptions ${subscriptionIds.join(", ")}`)

        // 3. Resolve Medusa services from container
        const subscriptionModule = this.container_["subscriptionModuleService"] as
            | { updateSubscriptions: (data: Record<string, unknown>) => Promise<unknown> }
            | undefined
        const notificationModule = this.container_[Modules.NOTIFICATION] as
            | { createNotifications: (data: Record<string, unknown>) => Promise<unknown> }
            | undefined
        const query = this.container_["query"] as
            | { graph: (opts: Record<string, unknown>) => Promise<{ data: Record<string, unknown>[] }> }
            | undefined

        if (!subscriptionModule || !query) {
            this.logger_.warn(`Fena subscription handler: subscription module or query not available, skipping`)
            return
        }

        // 4. Fetch all subscriptions in the group
        const { data: subs } = await query.graph({
            entity: "subscription",
            fields: ["id", "status", "metadata", "interval", "period", "subscription_date"],
            filters: { id: subscriptionIds },
        })

        interface SubscriptionRecord {
            id: string
            status: string
            metadata: Record<string, string> | null
            interval: string
            period: number
            subscription_date: string
        }

        const subscriptions = (subs || []).map((s) => s as unknown as SubscriptionRecord)
        if (subscriptions.length === 0) {
            this.logger_.warn(`Fena subscription handler: no subscriptions found for IDs ${subscriptionIds.join(",")}`)
            return
        }

        // Use first subscription for metadata (they all share the same order)
        const subscription = subscriptions[0]
        const metadata = subscription.metadata || {}

        // 5. Handle based on event
        switch (eventName) {
            case "status-update": {
                const normalizedStatus = (status || "").toLowerCase()

                if (normalizedStatus === "active") {
                    // Standing order is now active — reactivate ALL subscriptions in the group
                    const tomorrow = new Date()
                    tomorrow.setDate(tomorrow.getDate() + 1)

                    for (const sub of subscriptions) {
                        const subMeta = sub.metadata || {}
                        await subscriptionModule.updateSubscriptions({
                            id: sub.id,
                            status: "active",
                            next_order_date: tomorrow,
                            metadata: {
                                ...subMeta,
                                fena_payment_id: subMeta.fena_renewal_id || fenaPaymentId,
                            },
                        })
                    }

                    this.logger_.info(
                        `Fena subscription handler: reactivated ${subscriptions.length} subscriptions, next_order_date=${tomorrow.toISOString().split("T")[0]}`
                    )
                } else {
                    this.logger_.info(
                        `Fena subscription handler: status-update to "${normalizedStatus}", no action`
                    )
                }
                break
            }

            case "payment_made": {
                // Initial payment received. Order will be created by cron
                // when next_order_date is reached (set by status-update handler).
                this.logger_.info(
                    `Fena subscription handler: payment_made for ${subscriptions.length} subscriptions — cron will create order`
                )
                break
            }

            case "payment-missed": {
                // Standing order payment failed — send reminder email
                const renewalLink = metadata.fena_renewal_link
                if (!renewalLink) {
                    this.logger_.warn(`Fena subscription handler: no renewal link for ${subscriptionIds.join(",")}, can't send reminder`)
                    break
                }

                if (!notificationModule) {
                    this.logger_.warn(`Fena subscription handler: notification module not available, can't send reminder`)
                    break
                }

                // Fetch order data for email content
                const originalOrderId = metadata.original_order_id
                if (!originalOrderId) break

                try {
                    const { data: orders } = await query.graph({
                        entity: "order",
                        fields: ["id", "email", "customer.first_name", "customer.last_name", "items.*"],
                        filters: { id: originalOrderId },
                    })

                    interface OrderRecord {
                        id: string
                        email: string
                        customer?: { first_name?: string; last_name?: string }
                        items?: Array<{ variant_id: string; title: string }>
                    }

                    const order = orders?.[0] as unknown as OrderRecord | undefined
                    if (!order?.email) break

                    const subItem = order.items?.find((i) => i.variant_id === metadata.variant_id)
                    const customerName = [order.customer?.first_name, order.customer?.last_name]
                        .filter(Boolean).join(" ") || "Customer"

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
                    })

                    this.logger_.info(`Fena subscription handler: sent payment-missed reminder to ${order.email}`)
                } catch (emailErr: unknown) {
                    this.logger_.error(`Fena subscription handler: failed to send reminder — ${getErrorMessage(emailErr)}`)
                }
                break
            }

            default:
                this.logger_.info(`Fena subscription handler: unhandled event "${eventName}" for ${subscriptionIds.join(",")}`)
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
            case "draft":
            case "overdue":
            case FenaPaymentStatus.Sent:
            case FenaPaymentStatus.Pending:
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
