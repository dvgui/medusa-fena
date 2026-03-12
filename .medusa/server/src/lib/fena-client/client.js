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
    // Recurring Payments
    // ────────────────────────────────────────────────────────
    /**
     * Create a draft recurring payment.
     *
     * `POST /payments/recurring/create`
     */
    async createDraftRecurringPayment(input) {
        return this.request("POST", "/payments/recurring/create", input);
    }
    /**
     * Create and process a recurring payment.
     *
     * `POST /payments/recurring/create-and-process`
     */
    async createAndProcessRecurringPayment(input) {
        return this.request("POST", "/payments/recurring/create-and-process", input);
    }
    /**
     * Get a recurring payment by ID.
     *
     * `GET /payments/recurring/{id}`
     */
    async getRecurringPayment(id) {
        const res = await this.request("GET", `/payments/recurring/${id}`);
        return res.data;
    }
    /**
     * Process a draft recurring payment.
     *
     * `POST /payments/recurring/{id}/process`
     */
    async processRecurringPayment(id) {
        const res = await this.request("POST", `/payments/recurring/${id}/process`);
        return res.result;
    }
    /**
     * Delete/Cancel a recurring payment.
     *
     * `POST /payments/recurring/{id}/delete`
     */
    async deleteRecurringPayment(id) {
        const res = await this.request("POST", `/payments/recurring/${id}/delete`);
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
        const res = await this.request("POST", "/companies/info/create", input);
        return res.data;
    }
    /**
     * Get a managed entity by ID.
     *
     * `GET /companies/info/{id}`
     */
    async getManagedEntity(id) {
        const res = await this.request("GET", `/companies/info/${id}`);
        return res.data;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xpZW50LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9mZW5hLWNsaWVudC9jbGllbnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7OztHQVFHOzs7QUFxQkgsbUVBQW1FO0FBQ3RELFFBQUEscUJBQXFCLEdBQUcsbUNBQW1DLENBQUE7QUFFeEUsMkRBQTJEO0FBQzNELFNBQVM7QUFDVCwyREFBMkQ7QUFFM0QsTUFBYSxlQUFnQixTQUFRLEtBQUs7SUFJdEMsWUFBWSxVQUFrQixFQUFFLE9BQWUsRUFBRSxZQUFzQjtRQUNuRSxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUE7UUFDZCxJQUFJLENBQUMsSUFBSSxHQUFHLGlCQUFpQixDQUFBO1FBQzdCLElBQUksQ0FBQyxVQUFVLEdBQUcsVUFBVSxDQUFBO1FBQzVCLElBQUksQ0FBQyxZQUFZLEdBQUcsWUFBWSxDQUFBO0lBQ3BDLENBQUM7Q0FDSjtBQVZELDBDQVVDO0FBRUQsMkRBQTJEO0FBQzNELFNBQVM7QUFDVCwyREFBMkQ7QUFFM0QsTUFBYSxVQUFVO0lBS25CLFlBQVksTUFBd0I7UUFDaEMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxVQUFVLElBQUksQ0FBQyxNQUFNLENBQUMsY0FBYyxFQUFFLENBQUM7WUFDL0MsT0FBTyxDQUFDLElBQUksQ0FBQyx1R0FBdUcsQ0FBQyxDQUFBO1FBQ3pILENBQUM7UUFFRCxJQUFJLENBQUMsVUFBVSxHQUFHLE1BQU0sQ0FBQyxVQUFVLElBQUksa0JBQWtCLENBQUE7UUFDekQsSUFBSSxDQUFDLGNBQWMsR0FBRyxNQUFNLENBQUMsY0FBYyxJQUFJLHNCQUFzQixDQUFBO1FBQ3JFLElBQUksQ0FBQyxPQUFPLEdBQUcsTUFBTSxDQUFDLE9BQU8sSUFBSSw2QkFBcUIsQ0FBQTtJQUMxRCxDQUFDO0lBRUQ7Ozs7T0FJRztJQUNLLEtBQUssQ0FBQyxPQUFPLENBQ2pCLE1BQXNCLEVBQ3RCLElBQVksRUFDWixJ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