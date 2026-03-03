/**
 * Fena Webhook Route
 *
 * POST /fena/webhooks
 *
 * Receives payment status notifications from Fena and processes them
 * through Medusa's payment module.
 *
 * Configure this URL in your Fena dashboard as the webhook endpoint:
 *   https://your-medusa-backend.com/fena/webhooks
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { getErrorMessage } from "../../../lib/fena-client"

export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const logger = req.scope.resolve("logger") as Logger

    try {
        const paymentModuleService = req.scope.resolve("payment")

        const result = await paymentModuleService.getWebhookActionAndData({
            provider: "pp_fena_ob",
            payload: {
                data: req.body as Record<string, unknown>,
                rawData: JSON.stringify(req.body),
                headers: req.headers as Record<string, string>,
            },
        })

        logger.info(`Fena webhook processed — action: ${result?.action}`)

        res.status(200).json({ received: true })
    } catch (error: unknown) {
        const msg = getErrorMessage(error)
        logger.error(`Fena webhook error: ${msg}`)

        // Always return 200 to Fena to prevent retries on processing errors
        res.status(200).json({ received: true, error: msg })
    }
}
