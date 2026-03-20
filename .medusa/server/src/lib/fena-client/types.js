"use strict";
/**
 * Fena Payment Gateway - TypeScript Types
 *
 * Based on the Fena Business Toolkit API docs:
 * https://toolkit-docs.fena.co
 *
 * Base URL: https://epos.api.prod-gcp.fena.co
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FenaRecurringPaymentFrequency = exports.FenaManagedEntityType = exports.FenaPaymentMethod = exports.FenaTransactionStatus = exports.FenaPaymentStatus = void 0;
// ============================================================
// Enums & Constants
// ============================================================
/**
 * Payment statuses as documented in the Fena Payments API.
 */
var FenaPaymentStatus;
(function (FenaPaymentStatus) {
    FenaPaymentStatus["Draft"] = "draft";
    FenaPaymentStatus["Sent"] = "sent";
    FenaPaymentStatus["Overdue"] = "overdue";
    FenaPaymentStatus["Pending"] = "pending";
    FenaPaymentStatus["Paid"] = "paid";
    FenaPaymentStatus["Rejected"] = "rejected";
    FenaPaymentStatus["Cancelled"] = "cancelled";
    FenaPaymentStatus["RefundStarted"] = "refund_started";
    FenaPaymentStatus["RefundRejected"] = "refund_rejected";
    FenaPaymentStatus["Refunded"] = "refunded";
    FenaPaymentStatus["PartialRefund"] = "partial_refund";
})(FenaPaymentStatus || (exports.FenaPaymentStatus = FenaPaymentStatus = {}));
/**
 * Transaction statuses from the Fena Transactions API.
 */
var FenaTransactionStatus;
(function (FenaTransactionStatus) {
    FenaTransactionStatus["Created"] = "created";
    FenaTransactionStatus["Started"] = "started";
    FenaTransactionStatus["InProgress"] = "in_progress";
    FenaTransactionStatus["Aborted"] = "aborted";
    FenaTransactionStatus["Pending"] = "pending";
    FenaTransactionStatus["Rejected"] = "rejected";
    FenaTransactionStatus["Completed"] = "completed";
    FenaTransactionStatus["Missed"] = "missed";
    FenaTransactionStatus["PartiallyPaid"] = "partially_paid";
    FenaTransactionStatus["UnableToCheck"] = "unable_to_check";
    FenaTransactionStatus["Cancelled"] = "cancelled";
})(FenaTransactionStatus || (exports.FenaTransactionStatus = FenaTransactionStatus = {}));
/**
 * Payment methods supported by Fena.
 */
var FenaPaymentMethod;
(function (FenaPaymentMethod) {
    /** Standard Open Banking redirect */
    FenaPaymentMethod["FenaOB"] = "fena_ob";
    /** Open Banking via QR code */
    FenaPaymentMethod["FenaOBQR"] = "fena_ob_qr";
    /** Card payments (requires Fena Card Payments Onboarding) */
    FenaPaymentMethod["FenaCardPayments"] = "fena_card_payments";
})(FenaPaymentMethod || (exports.FenaPaymentMethod = FenaPaymentMethod = {}));
// ============================================================
// Managed Entities (Account Holders)
// ============================================================
var FenaManagedEntityType;
(function (FenaManagedEntityType) {
    FenaManagedEntityType["Consumer"] = "consumer";
    FenaManagedEntityType["Company"] = "company";
})(FenaManagedEntityType || (exports.FenaManagedEntityType = FenaManagedEntityType = {}));
// ============================================================
// Recurring Payments
// ============================================================
var FenaRecurringPaymentFrequency;
(function (FenaRecurringPaymentFrequency) {
    FenaRecurringPaymentFrequency["OneWeek"] = "one_week";
    FenaRecurringPaymentFrequency["OneMonth"] = "one_month";
    FenaRecurringPaymentFrequency["ThreeMonths"] = "three_months";
    FenaRecurringPaymentFrequency["OneYear"] = "one_year";
})(FenaRecurringPaymentFrequency || (exports.FenaRecurringPaymentFrequency = FenaRecurringPaymentFrequency = {}));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidHlwZXMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL2ZlbmEtY2xpZW50L3R5cGVzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7OztHQU9HOzs7QUFFSCwrREFBK0Q7QUFDL0Qsb0JBQW9CO0FBQ3BCLCtEQUErRDtBQUUvRDs7R0FFRztBQUNILElBQVksaUJBWVg7QUFaRCxXQUFZLGlCQUFpQjtJQUN6QixvQ0FBZSxDQUFBO0lBQ2Ysa0NBQWEsQ0FBQTtJQUNiLHdDQUFtQixDQUFBO0lBQ25CLHdDQUFtQixDQUFBO0lBQ25CLGtDQUFhLENBQUE7SUFDYiwwQ0FBcUIsQ0FBQTtJQUNyQiw0Q0FBdUIsQ0FBQTtJQUN2QixxREFBZ0MsQ0FBQTtJQUNoQyx1REFBa0MsQ0FBQTtJQUNsQywwQ0FBcUIsQ0FBQTtJQUNyQixxREFBZ0MsQ0FBQTtBQUNwQyxDQUFDLEVBWlcsaUJBQWlCLGlDQUFqQixpQkFBaUIsUUFZNUI7QUFFRDs7R0FFRztBQUNILElBQVkscUJBWVg7QUFaRCxXQUFZLHFCQUFxQjtJQUM3Qiw0Q0FBbUIsQ0FBQTtJQUNuQiw0Q0FBbUIsQ0FBQTtJQUNuQixtREFBMEIsQ0FBQTtJQUMxQiw0Q0FBbUIsQ0FBQTtJQUNuQiw0Q0FBbUIsQ0FBQTtJQUNuQiw4Q0FBcUIsQ0FBQTtJQUNyQixnREFBdUIsQ0FBQTtJQUN2QiwwQ0FBaUIsQ0FBQTtJQUNqQix5REFBZ0MsQ0FBQTtJQUNoQywwREFBaUMsQ0FBQTtJQUNqQyxnREFBdUIsQ0FBQTtBQUMzQixDQUFDLEVBWlcscUJBQXFCLHFDQUFyQixxQkFBcUIsUUFZaEM7QUFFRDs7R0FFRztBQUNILElBQVksaUJBT1g7QUFQRCxXQUFZLGlCQUFpQjtJQUN6QixxQ0FBcUM7SUFDckMsdUNBQWtCLENBQUE7SUFDbEIsK0JBQStCO0lBQy9CLDRDQUF1QixDQUFBO0lBQ3ZCLDZEQUE2RDtJQUM3RCw0REFBdUMsQ0FBQTtBQUMzQyxDQUFDLEVBUFcsaUJBQWlCLGlDQUFqQixpQkFBaUIsUUFPNUI7QUE4SkQsK0RBQStEO0FBQy9ELHFDQUFxQztBQUNyQywrREFBK0Q7QUFFL0QsSUFBWSxxQkFHWDtBQUhELFdBQVkscUJBQXFCO0lBQzdCLDhDQUFxQixDQUFBO0lBQ3JCLDRDQUFtQixDQUFBO0FBQ3ZCLENBQUMsRUFIVyxxQkFBcUIscUNBQXJCLHFCQUFxQixRQUdoQztBQXVCRCwrREFBK0Q7QUFDL0QscUJBQXFCO0FBQ3JCLCtEQUErRDtBQUUvRCxJQUFZLDZCQUtYO0FBTEQsV0FBWSw2QkFBNkI7SUFDckMscURBQW9CLENBQUE7SUFDcEIsdURBQXNCLENBQUE7SUFDdEIsNkRBQTRCLENBQUE7SUFDNUIscURBQW9CLENBQUE7QUFDeEIsQ0FBQyxFQUxXLDZCQUE2Qiw2Q0FBN0IsNkJBQTZCLFFBS3hDIn0=