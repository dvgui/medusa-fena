/**
 * Fena Client — Public API
 *
 * Clean barrel export for the Fena mini-SDK.
 * If this ever gets extracted into a standalone package, this is the entry point.
 */

export { FenaClient, FenaClientError, FENA_DEFAULT_BASE_URL } from "./client"
export { getErrorMessage } from "./utils"
export {
    // Enums
    FenaPaymentStatus,
    FenaTransactionStatus,
    FenaPaymentMethod,
    // Config
    type FenaClientConfig,
    // Payment types
    type CreatePaymentInput,
    type FenaPayment,
    type FenaPaymentWithLink,
    type FenaCreatePaymentResponse,
    type FenaCreateAndProcessPaymentResponse,
    type FenaSavePaymentResponse,
    type FenaPaymentNote,
    // Transaction types
    type FenaTransaction,
    type FenaTransactionListResponse,
    // Bank account types
    type FenaBankAccount,
    // Managed Entity types
    FenaManagedEntityType,
    type FenaManagedEntityInput,
    type FenaManagedEntity,
    // Recurring Payment types
    FenaRecurringPaymentFrequency,
    type CreateRecurringPaymentInput,
    type FenaRecurringPayment,
    type FenaRecurringPaymentWithLink,
    type FenaCreateRecurringPaymentResponse,
    // Webhook types
    type FenaWebhookPayload,
    type FenaBankAccountWebhookPayload,
} from "./types"
