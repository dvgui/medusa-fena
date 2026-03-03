/**
 * Fena Payment Gateway - TypeScript Types
 *
 * Based on the Fena Business Toolkit API docs:
 * https://toolkit-docs.fena.co
 *
 * Base URL: https://epos.api.prod-gcp.fena.co
 */

// ============================================================
// Enums & Constants
// ============================================================

/**
 * Payment statuses as documented in the Fena Payments API.
 */
export enum FenaPaymentStatus {
    Draft = "draft",
    Sent = "sent",
    Overdue = "overdue",
    Pending = "pending",
    Paid = "paid",
    Rejected = "rejected",
    Cancelled = "cancelled",
    RefundStarted = "refund_started",
    RefundRejected = "refund_rejected",
    Refunded = "refunded",
    PartialRefund = "partial_refund",
}

/**
 * Transaction statuses from the Fena Transactions API.
 */
export enum FenaTransactionStatus {
    Created = "created",
    Started = "started",
    InProgress = "in_progress",
    Aborted = "aborted",
    Pending = "pending",
    Rejected = "rejected",
    Completed = "completed",
    Missed = "missed",
    PartiallyPaid = "partially_paid",
    UnableToCheck = "unable_to_check",
    Cancelled = "cancelled",
}

/**
 * Payment methods supported by Fena.
 */
export enum FenaPaymentMethod {
    /** Standard Open Banking redirect */
    FenaOB = "fena_ob",
    /** Open Banking via QR code */
    FenaOBQR = "fena_ob_qr",
    /** Card payments (requires Fena Card Payments Onboarding) */
    FenaCardPayments = "fena_card_payments",
}

// ============================================================
// Client Configuration
// ============================================================

export interface FenaClientConfig {
    /** Integration ID (terminal-id header) */
    terminalId: string
    /** Integration Secret (terminal-secret header) — UUID format */
    terminalSecret: string
    /** Use sandbox environment. Defaults to false. */
    sandbox?: boolean
    /** Override the base URL (mainly for testing) */
    baseUrl?: string
}

// ============================================================
// Payment Note
// ============================================================

export interface FenaPaymentNote {
    text: string
}

// ============================================================
// Create Payment Request
// ============================================================

export interface CreatePaymentInput {
    /** Unique reference for this payment (max 255 chars) */
    reference: string
    /** Amount in decimal string, e.g. "9.50" */
    amount: string
    /** Bank account ID to receive payment. Uses default if omitted. */
    bankAccount?: string
    /** Customer name */
    customerName?: string
    /** Due date in ISO 8601 format. If not met, status → "overdue" */
    dueDate?: string
    /** Customer email */
    customerEmail?: string
    /** CC email addresses */
    customerEmailCC?: string[]
    /** Payment method */
    paymentMethod?: FenaPaymentMethod
    /** Payment description (max 1000 chars) */
    description?: string
    /**
     * Custom redirect URL after payment completion.
     * Overrides the default redirect URL configured in the API key.
     */
    customRedirectUrl?: string
    /** Optional payment notes */
    notes?: FenaPaymentNote[]
}

// ============================================================
// Bank Account
// ============================================================

export interface FenaBankAccount {
    id: string
    name: string
    sortCode: string
    accountNumber: string
    provider: string
    isDefault: boolean
    isSandbox?: boolean
    status: string
    creationType: string
    createdAt: string
    bankStatementAttachmentURL?: string
    consentID?: string
    bankConsentExpired?: string
}

// ============================================================
// Payment Response
// ============================================================

export interface FenaPayment {
    id: string
    amount: string
    currency: string
    reference: string
    status: FenaPaymentStatus
    customerName?: string
    customerEmail?: string
    customerEmailCC?: string[]
    paymentMethod: FenaPaymentMethod
    description?: string
    customRedirectUrl?: string
    createdAt: string
    dueDate?: string
    isSandbox: boolean
    bankAccount?: FenaBankAccount
    notes?: FenaPaymentNote[]
}

/**
 * Response from the "create-and-process" endpoint.
 * Includes `link` (redirect URL) and `qrCodeData` (QR code image URL).
 */
export interface FenaPaymentWithLink extends FenaPayment {
    /** Payment URL for redirect flow */
    link: string
    /** URL to QR code PNG image */
    qrCodeData: string
}

export interface FenaCreatePaymentResponse {
    created: boolean
    result: FenaPayment
}

export interface FenaCreateAndProcessPaymentResponse {
    created: boolean
    result: FenaPaymentWithLink
}

export interface FenaSavePaymentResponse {
    saved: boolean
    result: FenaPaymentWithLink
}

// ============================================================
// Transaction
// ============================================================

export interface FenaTransaction {
    id: string
    amount: string
    status: FenaTransactionStatus
    createdAt: string
    parentEntityType: string
    parentEntityId: string
    isSandbox: boolean
    direction: string
    expectedCompletedDate: string
    completedAt: string
    reference: string
    parentEntityDataApiCheckStatus: string
    parentEntityLastDataApiCheckAt: string
}

export interface FenaTransactionListResponse {
    data: {
        page: number
        totalDocs: number
        totalPages: number
        limit: number
        hasNextPage: boolean
        docs: FenaTransaction[]
    }
}

// ============================================================
// Webhook Payload
// ============================================================

/**
 * Webhook payload sent by Fena on payment status change.
 * Fena POSTs to the webhook URL configured in the API key settings.
 *
 * The redirect URL also receives query params:
 *   - order_id: your payment reference
 *   - payment_id: Fena's unique payment ID
 *   - status: payment status
 */
export interface FenaWebhookPayload {
    /** The Fena payment ID */
    id: string
    /** Payment status */
    status: FenaPaymentStatus
    /** The payment reference you provided */
    reference: string
    /** Amount */
    amount: string
    /** Currency code */
    currency: string
    /** Additional fields Fena may include */
    [key: string]: unknown
}

// ============================================================
// Bank Account Webhook
// ============================================================

export interface FenaBankAccountWebhookPayload {
    eventScope: "bank-accounts"
    eventName: "status-update"
    id: string
    sortCode: string
    accountNumber: string
    name: string
    provider: string
    isDefault: boolean
    status: "verified" | "pending" | "disabled"
    creationType: string
    createdAt: string
    bankStatementAttachmentURL?: string
    consentID?: string
    bankConsentExpired?: string
}
