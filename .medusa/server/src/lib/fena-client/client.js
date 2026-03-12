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
const types_1 = require("./types");
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
    // Recurring Payments
    // ────────────────────────────────────────────────────────
    /**
     * Create a draft recurring payment.
     *
     * `POST /payments/recurring/create`
     */
    async createDraftRecurringPayment(input) {
        return this.request("POST", "/open/payments/recurring/create", input);
    }
    /**
     * Create and process a recurring payment.
     *
     * `POST /payments/recurring/create-and-process`
     */
    async createAndProcessRecurringPayment(input) {
        return this.request("POST", "/open/payments/recurring/create-and-process", input);
    }
    /**
     * Get a recurring payment by ID.
     *
     * `GET /payments/recurring/{id}`
     */
    async getRecurringPayment(id) {
        const res = await this.request("GET", `/open/payments/recurring/${id}`);
        return res.data;
    }
    /**
     * Process a draft recurring payment.
     *
     * `POST /payments/recurring/{id}/process`
     */
    async processRecurringPayment(id) {
        const res = await this.request("POST", `/open/payments/recurring/${id}/process`);
        return res.result;
    }
    /**
     * Delete/Cancel a recurring payment.
     *
     * `POST /payments/recurring/{id}/delete`
     */
    async deleteRecurringPayment(id) {
        const res = await this.request("POST", `/open/payments/recurring/${id}/delete`);
        return res.deleted;
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
    async createManagedEntity(input) {
        // Managed Entities are for Partner API only.
        // For standard merchants, we don't need this.
        return {
            id: `me_${Date.now()}`,
            name: input.name,
            type: input.type,
            isSandbox: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
    }
    /**
     * Get a managed entity by ID.
     *
     * `GET /companies/info/{id}`
     */
    async getManagedEntity(id) {
        // Return a dummy object for compatibility
        return {
            id,
            name: "Customer",
            type: types_1.FenaManagedEntityType.Consumer,
            isSandbox: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xpZW50LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9mZW5hLWNsaWVudC9jbGllbnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7OztHQVFHOzs7QUFtQkgsbUNBQStDO0FBRS9DLG1FQUFtRTtBQUN0RCxRQUFBLHFCQUFxQixHQUFHLG1DQUFtQyxDQUFBO0FBRXhFLDJEQUEyRDtBQUMzRCxTQUFTO0FBQ1QsMkRBQTJEO0FBRTNELE1BQWEsZUFBZ0IsU0FBUSxLQUFLO0lBSXRDLFlBQVksVUFBa0IsRUFBRSxPQUFlLEVBQUUsWUFBc0I7UUFDbkUsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFBO1FBQ2QsSUFBSSxDQUFDLElBQUksR0FBRyxpQkFBaUIsQ0FBQTtRQUM3QixJQUFJLENBQUMsVUFBVSxHQUFHLFVBQVUsQ0FBQTtRQUM1QixJQUFJLENBQUMsWUFBWSxHQUFHLFlBQVksQ0FBQTtJQUNwQyxDQUFDO0NBQ0o7QUFWRCwwQ0FVQztBQUVELDJEQUEyRDtBQUMzRCxTQUFTO0FBQ1QsMkRBQTJEO0FBRTNELE1BQWEsVUFBVTtJQUtuQixZQUFZLE1BQXdCO1FBQ2hDLElBQUksQ0FBQyxNQUFNLENBQUMsVUFBVSxJQUFJLENBQUMsTUFBTSxDQUFDLGNBQWMsRUFBRSxDQUFDO1lBQy9DLE9BQU8sQ0FBQyxJQUFJLENBQUMsdUdBQXVHLENBQUMsQ0FBQTtRQUN6SCxDQUFDO1FBRUQsSUFBSSxDQUFDLFVBQVUsR0FBRyxNQUFNLENBQUMsVUFBVSxJQUFJLGtCQUFrQixDQUFBO1FBQ3pELElBQUksQ0FBQyxjQUFjLEdBQUcsTUFBTSxDQUFDLGNBQWMsSUFBSSxzQkFBc0IsQ0FBQTtRQUNyRSxJQUFJLENBQUMsT0FBTyxHQUFHLE1BQU0sQ0FBQyxPQUFPLElBQUksNkJBQXFCLENBQUE7SUFDMUQsQ0FBQztJQUVEOzs7O09BSUc7SUFDSyxLQUFLLENBQUMsT0FBTyxDQUNqQixNQUFzQixFQUN0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