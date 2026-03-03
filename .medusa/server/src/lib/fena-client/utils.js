"use strict";
/**
 * Fena Client — Shared Utilities
 *
 * Pure helper functions used across the Fena client and provider.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getErrorMessage = getErrorMessage;
/**
 * Extracts a human-readable message from an unknown error value.
 * Avoids the need for `catch (error: any)`.
 *
 * @example
 * ```ts
 * try { ... }
 * catch (error: unknown) {
 *   console.error(getErrorMessage(error))
 * }
 * ```
 */
function getErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === "string")
        return error;
    return String(error);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidXRpbHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL2ZlbmEtY2xpZW50L3V0aWxzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7OztHQUlHOztBQWNILDBDQUlDO0FBaEJEOzs7Ozs7Ozs7OztHQVdHO0FBQ0gsU0FBZ0IsZUFBZSxDQUFDLEtBQWM7SUFDMUMsSUFBSSxLQUFLLFlBQVksS0FBSztRQUFFLE9BQU8sS0FBSyxDQUFDLE9BQU8sQ0FBQTtJQUNoRCxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVE7UUFBRSxPQUFPLEtBQUssQ0FBQTtJQUMzQyxPQUFPLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQTtBQUN4QixDQUFDIn0=