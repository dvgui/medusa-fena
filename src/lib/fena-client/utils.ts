/**
 * Fena Client — Shared Utilities
 *
 * Pure helper functions used across the Fena client and provider.
 */

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
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    return String(error)
}
