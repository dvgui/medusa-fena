"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.POST = POST;
const fena_client_1 = require("../../../lib/fena-client");
async function POST(req, res) {
    const logger = req.scope.resolve("logger");
    try {
        const paymentModuleService = req.scope.resolve("payment");
        const result = await paymentModuleService.getWebhookActionAndData({
            provider: "pp_fena_fena-ob",
            payload: {
                data: req.body,
                rawData: JSON.stringify(req.body),
                headers: req.headers,
            },
        });
        logger.info(`Fena webhook processed — action: ${result?.action}`);
        res.status(200).json({ received: true });
    }
    catch (error) {
        const msg = (0, fena_client_1.getErrorMessage)(error);
        logger.error(`Fena webhook error: ${msg}`);
        // Always return 200 to Fena to prevent retries on processing errors
        res.status(200).json({ received: true, error: msg });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvYXBpL2ZlbmEvd2ViaG9vay9yb3V0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7Ozs7R0FVRzs7QUFNSCxvQkE0QkM7QUE5QkQsMERBQTBEO0FBRW5ELEtBQUssVUFBVSxJQUFJLENBQ3RCLEdBQWtCLEVBQ2xCLEdBQW1CO0lBRW5CLE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBVyxDQUFBO0lBRXBELElBQUksQ0FBQztRQUNELE1BQU0sb0JBQW9CLEdBQUcsR0FBRyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUE7UUFFekQsTUFBTSxNQUFNLEdBQUcsTUFBTSxvQkFBb0IsQ0FBQyx1QkFBdUIsQ0FBQztZQUM5RCxRQUFRLEVBQUUsaUJBQWlCO1lBQzNCLE9BQU8sRUFBRTtnQkFDTCxJQUFJLEVBQUUsR0FBRyxDQUFDLElBQStCO2dCQUN6QyxPQUFPLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDO2dCQUNqQyxPQUFPLEVBQUUsR0FBRyxDQUFDLE9BQWlDO2FBQ2pEO1NBQ0osQ0FBQyxDQUFBO1FBRUYsTUFBTSxDQUFDLElBQUksQ0FBQyxvQ0FBb0MsTUFBTSxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUE7UUFFakUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQTtJQUM1QyxDQUFDO0lBQUMsT0FBTyxLQUFjLEVBQUUsQ0FBQztRQUN0QixNQUFNLEdBQUcsR0FBRyxJQUFBLDZCQUFlLEVBQUMsS0FBSyxDQUFDLENBQUE7UUFDbEMsTUFBTSxDQUFDLEtBQUssQ0FBQyx1QkFBdUIsR0FBRyxFQUFFLENBQUMsQ0FBQTtRQUUxQyxvRUFBb0U7UUFDcEUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxHQUFHLEVBQUUsQ0FBQyxDQUFBO0lBQ3hELENBQUM7QUFDTCxDQUFDIn0=