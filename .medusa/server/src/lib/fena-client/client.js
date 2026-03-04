"use strict";
/**
 * Fena Payment Gateway - HTTP Client
 *
 * A lightweight, typed wrapper around the Fena Business Toolkit API.
 * No external dependencies — uses native `fetch`.
 *
 * API Base URL: https://epos.api.prod-gcp.fena.co
 * Docs: https://toolkit-docs.fena.co
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FenaClient = exports.FenaClientError = exports.FENA_DEFAULT_BASE_URL = void 0;
/** Default Fena API base URL. Override via `baseUrl` in config. */
exports.FENA_DEFAULT_BASE_URL = "https://epos.api.prod-gcp.fena.co";
// ────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────
class FenaClientError extends Error {
    constructor(statusCode, message, responseBody) {
        super(message);
        this.name = "FenaClientError";
        this.statusCode = statusCode;
        this.responseBody = responseBody;
    }
}
exports.FenaClientError = FenaClientError;
// ────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────
class FenaClient {
    constructor(config) {
        if (!config.terminalId || !config.terminalSecret) {
            console.warn("Fena Provider Warning: terminalId and/or terminalSecret are missing. Payments will fail if attempted.");
        }
        this.terminalId = config.terminalId || "test_terminal_id";
        this.terminalSecret = config.terminalSecret || "test_terminal_secret";
        this.baseUrl = config.baseUrl || exports.FENA_DEFAULT_BASE_URL;
    }
    /**
     * Core HTTP method. Accepts any JSON-serializable body directly —
     * no need to convert typed inputs to `Record<string, unknown>`.
     * `JSON.stringify` naturally strips `undefined` values.
     */
    async request(method, path, body) {
        const url = `${this.baseUrl}${path}`;
        const init = {
            method,
            headers: {
                "Content-Type": "application/json",
                // Fena API expects these exact header names, despite what the dashboard calls them:
                "integration-id": this.terminalId,
                "secret-key": this.terminalSecret,
            },
        };
        if (body && method === "POST") {
            init.body = JSON.stringify(body);
        }
        const response = await fetch(url, init);
        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : {};
        }
        catch {
            data = { rawResponse: text };
        }
        if (!response.ok) {
            const msg = typeof data === "object" && data !== null && "message" in data && typeof data.message === "string"
                ? data.message
                : `Fena API error: ${response.status} ${response.statusText}`;
            throw new FenaClientError(response.status, msg, data);
        }
        return data;
    }
    // ────────────────────────────────────────────────────────
    // Payments — Single
    // ────────────────────────────────────────────────────────
    /**
     * Create a draft payment that can be processed later.
     *
     * `POST /open/payments/single/create`
     */
    async createDraftPayment(input) {
        return this.request("POST", "/open/payments/single/create", input);
    }
    /**
     * Create and process a payment in a single step.
     * Returns a payment `link` (redirect URL) and `qrCodeData` (QR code image URL).
     *
     * `POST /open/payments/single/create-and-process`
     *
     * This is the primary endpoint for e-commerce integrations.
     */
    async createAndProcessPayment(input) {
        return this.request("POST", "/open/payments/single/create-and-process", input);
    }
    /**
     * Get a payment by its ID.
     *
     * `GET /open/payments/single/{id}`
     */
    async getPayment(id) {
        const res = await this.request("GET", `/open/payments/single/${id}`);
        return res.data;
    }
    /**
     * Process an existing draft payment.
     * Changes status from "draft" to "sent" and generates the payment link.
     *
     * `POST /open/payments/single/{id}/process`
     */
    async processPayment(id) {
        const res = await this.request("POST", `/open/payments/single/${id}/process`);
        return res.result;
    }
    // ────────────────────────────────────────────────────────
    // Transactions
    // ────────────────────────────────────────────────────────
    /**
     * Get a transaction by its ID.
     *
     * `GET /payments/transaction/{id}`
     */
    async getTransaction(id) {
        const res = await this.request("GET", `/payments/transaction/${id}`);
        return res.data;
    }
    /**
     * Get a paginated list of transactions.
     *
     * `GET /payments/transaction/list`
     */
    async listTransactions(page = 1, limit = 25) {
        return this.request("GET", `/payments/transaction/list?page=${page}&limit=${limit}`);
    }
}
exports.FenaClient = FenaClient;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xpZW50LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9mZW5hLWNsaWVudC9jbGllbnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7OztHQVFHOzs7QUFhSCxtRUFBbUU7QUFDdEQsUUFBQSxxQkFBcUIsR0FBRyxtQ0FBbUMsQ0FBQTtBQUV4RSwyREFBMkQ7QUFDM0QsU0FBUztBQUNULDJEQUEyRDtBQUUzRCxNQUFhLGVBQWdCLFNBQVEsS0FBSztJQUl0QyxZQUFZLFVBQWtCLEVBQUUsT0FBZSxFQUFFLFlBQXNCO1FBQ25FLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQTtRQUNkLElBQUksQ0FBQyxJQUFJLEdBQUcsaUJBQWlCLENBQUE7UUFDN0IsSUFBSSxDQUFDLFVBQVUsR0FBRyxVQUFVLENBQUE7UUFDNUIsSUFBSSxDQUFDLFlBQVksR0FBRyxZQUFZLENBQUE7SUFDcEMsQ0FBQztDQUNKO0FBVkQsMENBVUM7QUFFRCwyREFBMkQ7QUFDM0QsU0FBUztBQUNULDJEQUEyRDtBQUUzRCxNQUFhLFVBQVU7SUFLbkIsWUFBWSxNQUF3QjtRQUNoQyxJQUFJLENBQUMsTUFBTSxDQUFDLFVBQVUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxjQUFjLEVBQUUsQ0FBQztZQUMvQyxPQUFPLENBQUMsSUFBSSxDQUFDLHVHQUF1RyxDQUFDLENBQUE7UUFDekgsQ0FBQztRQUVELElBQUksQ0FBQyxVQUFVLEdBQUcsTUFBTSxDQUFDLFVBQVUsSUFBSSxrQkFBa0IsQ0FBQTtRQUN6RCxJQUFJLENBQUMsY0FBYyxHQUFHLE1BQU0sQ0FBQyxjQUFjLElBQUksc0JBQXNCLENBQUE7UUFDckUsSUFBSSxDQUFDLE9BQU8sR0FBRyxNQUFNLENBQUMsT0FBTyxJQUFJLDZCQUFxQixDQUFBO0lBQzFELENBQUM7SUFFRDs7OztPQUlHO0lBQ0ssS0FBSyxDQUFDLE9BQU8sQ0FDakIsTUFBc0IsRUFDdEIsSUFBWSxFQUNaLElB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