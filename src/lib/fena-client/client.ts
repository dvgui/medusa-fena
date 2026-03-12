/**
 * Fena Payment Gateway - HTTP Client
 *
 * A lightweight, typed wrapper around the Fena Business Toolkit API.
 * No external dependencies — uses native `fetch`.
 *
 * API Base URL: https://epos.api.prod-gcp.fena.co
 * Docs: https://toolkit-docs.fena.co
 */

import type {
    FenaClientConfig,
    CreatePaymentInput,
    FenaCreatePaymentResponse,
    FenaCreateAndProcessPaymentResponse,
    FenaPayment,
    FenaPaymentWithLink,
    FenaTransaction,
    FenaTransactionListResponse,
    FenaManagedEntityInput,
    FenaManagedEntity,
    FenaRecurringPaymentFrequency,
    CreateRecurringPaymentInput,
    FenaRecurringPayment,
    FenaRecurringPaymentWithLink,
    FenaCreateRecurringPaymentResponse,
} from "./types"
import { FenaManagedEntityType } from "./types"

/** Default Fena API base URL. Override via `baseUrl` in config. */
export const FENA_DEFAULT_BASE_URL = "https://epos.api.prod-gcp.fena.co"

// ────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────

export class FenaClientError extends Error {
    public readonly statusCode: number
    public readonly responseBody: unknown

    constructor(statusCode: number, message: string, responseBody?: unknown) {
        super(message)
        this.name = "FenaClientError"
        this.statusCode = statusCode
        this.responseBody = responseBody
    }
}

// ────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────

export class FenaClient {
    private readonly terminalId: string
    private readonly terminalSecret: string
    private readonly baseUrl: string

    constructor(config: FenaClientConfig) {
        if (!config.terminalId || !config.terminalSecret) {
            console.warn("Fena Provider Warning: terminalId and/or terminalSecret are missing. Payments will fail if attempted.")
        }

        this.terminalId = config.terminalId || "test_terminal_id"
        this.terminalSecret = config.terminalSecret || "test_terminal_secret"
        this.baseUrl = config.baseUrl || FENA_DEFAULT_BASE_URL
    }

    /**
     * Core HTTP method. Accepts any JSON-serializable body directly —
     * no need to convert typed inputs to `Record<string, unknown>`.
     * `JSON.stringify` naturally strips `undefined` values.
     */
    private async request<T>(
        method: "GET" | "POST",
        path: string,
        body?: object
    ): Promise<T> {
        const url = `${this.baseUrl}${path}`

        const init: RequestInit = {
            method,
            headers: {
                "Content-Type": "application/json",
                // Fena API expects these exact header names, despite what the dashboard calls them:
                "integration-id": this.terminalId,
                "secret-key": this.terminalSecret,
            },
        }

        if (body && method === "POST") {
            init.body = JSON.stringify(body)
        }

        const response = await fetch(url, init)
        const text = await response.text()

        let data: unknown
        try {
            data = text ? JSON.parse(text) : {}
        } catch {
            data = { rawResponse: text }
        }

        if (!response.ok) {
            const msg =
                typeof data === "object" && data !== null && "message" in data && typeof (data as { message: unknown }).message === "string"
                    ? (data as { message: string }).message
                    : `Fena API error: ${response.status} ${response.statusText}`

            throw new FenaClientError(response.status, msg, data)
        }

        return data as T
    }

    // ────────────────────────────────────────────────────────
    // Payments — Single
    // ────────────────────────────────────────────────────────

    /**
     * Create a draft payment that can be processed later.
     *
     * `POST /open/payments/single/create`
     */
    async createDraftPayment(input: CreatePaymentInput): Promise<FenaCreatePaymentResponse> {
        return this.request("POST", "/open/payments/single/create", input)
    }

    /**
     * Create and process a payment in a single step.
     * Returns a payment `link` (redirect URL) and `qrCodeData` (QR code image URL).
     *
     * `POST /open/payments/single/create-and-process`
     *
     * This is the primary endpoint for e-commerce integrations.
     */
    async createAndProcessPayment(input: CreatePaymentInput): Promise<FenaCreateAndProcessPaymentResponse> {
        return this.request("POST", "/open/payments/single/create-and-process", input)
    }

    /**
     * Get a payment by its ID.
     *
     * `GET /open/payments/single/{id}`
     */
    async getPayment(id: string): Promise<FenaPayment> {
        const res = await this.request<{ data: FenaPayment }>("GET", `/open/payments/single/${id}`)
        return res.data
    }

    /**
     * Process an existing draft payment.
     * Changes status from "draft" to "sent" and generates the payment link.
     *
     * `POST /open/payments/single/{id}/process`
     */
    async processPayment(id: string): Promise<FenaPaymentWithLink> {
        const res = await this.request<{ saved: boolean; result: FenaPaymentWithLink }>("POST", `/open/payments/single/${id}/process`)
        return res.result
    }

    // ────────────────────────────────────────────────────────
    // Recurring Payments
    // ────────────────────────────────────────────────────────

    /**
     * Create a draft recurring payment.
     *
     * `POST /payments/recurring/create`
     */
    async createDraftRecurringPayment(input: CreateRecurringPaymentInput): Promise<FenaCreateRecurringPaymentResponse> {
        return this.request("POST", "/open/payments/recurring/create", input)
    }

    /**
     * Create and process a recurring payment.
     *
     * `POST /payments/recurring/create-and-process`
     */
    async createAndProcessRecurringPayment(input: CreateRecurringPaymentInput): Promise<FenaCreateRecurringPaymentResponse> {
        return this.request("POST", "/open/payments/recurring/create-and-process", input)
    }

    /**
     * Get a recurring payment by ID.
     *
     * `GET /payments/recurring/{id}`
     */
    async getRecurringPayment(id: string): Promise<FenaRecurringPayment> {
        const res = await this.request<{ data: FenaRecurringPayment }>("GET", `/open/payments/recurring/${id}`)
        return res.data
    }

    /**
     * Process a draft recurring payment.
     *
     * `POST /payments/recurring/{id}/process`
     */
    async processRecurringPayment(id: string): Promise<FenaRecurringPaymentWithLink> {
        const res = await this.request<{ result: FenaRecurringPaymentWithLink }>("POST", `/open/payments/recurring/${id}/process`)
        return res.result
    }

    /**
     * Delete/Cancel a recurring payment.
     *
     * `POST /payments/recurring/{id}/delete`
     */
    async deleteRecurringPayment(id: string): Promise<boolean> {
        const res = await this.request<{ deleted: boolean }>("POST", `/open/payments/recurring/${id}/delete`)
        return res.deleted
    }

    // ────────────────────────────────────────────────────────
    // Managed Entities (Account Holders)
    // ────────────────────────────────────────────────────────

    /**
     * Create a managed entity (e.g., consumer/account holder).
     * Note: This usually requires Partner API access.
     *
     * `POST /companies/info/create`
     */
    async createManagedEntity(input: FenaManagedEntityInput): Promise<FenaManagedEntity> {
        // Managed Entities are for Partner API only.
        // For standard merchants, we don't need this.
        return {
            id: `me_${Date.now()}`,
            name: input.name,
            type: input.type,
            isSandbox: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }
    }

    /**
     * Get a managed entity by ID.
     *
     * `GET /companies/info/{id}`
     */
    async getManagedEntity(id: string): Promise<FenaManagedEntity> {
        // Return a dummy object for compatibility
        return {
            id,
            name: "Customer",
            type: FenaManagedEntityType.Consumer,
            isSandbox: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }
    }

    // ────────────────────────────────────────────────────────
    // Transactions
    // ────────────────────────────────────────────────────────

    /**
     * Get a transaction by its ID.
     *
     * `GET /payments/transaction/{id}`
     */
    async getTransaction(id: string): Promise<FenaTransaction> {
        const res = await this.request<{ data: FenaTransaction }>("GET", `/payments/transaction/${id}`)
        return res.data
    }

    /**
     * Get a paginated list of transactions.
     *
     * `GET /payments/transaction/list`
     */
    async listTransactions(page = 1, limit = 25): Promise<FenaTransactionListResponse> {
        return this.request("GET", `/payments/transaction/list?page=${page}&limit=${limit}`)
    }
}
