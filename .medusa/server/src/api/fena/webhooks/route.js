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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvYXBpL2ZlbmEvd2ViaG9va3Mvcm91dGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7O0dBVUc7O0FBTUgsb0JBNEJDO0FBOUJELDBEQUEwRDtBQUVuRCxLQUFLLFVBQVUsSUFBSSxDQUN0QixHQUFrQixFQUNsQixHQUFtQjtJQUVuQixNQUFNLE1BQU0sR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQVcsQ0FBQTtJQUVwRCxJQUFJLENBQUM7UUFDRCxNQUFNLG9CQUFvQixHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFBO1FBRXpELE1BQU0sTUFBTSxHQUFHLE1BQU0sb0JBQW9CLENBQUMsdUJBQXVCLENBQUM7WUFDOUQsUUFBUSxFQUFFLGlCQUFpQjtZQUMzQixPQUFPLEVBQUU7Z0JBQ0wsSUFBSSxFQUFFLEdBQUcsQ0FBQyxJQUErQjtnQkFDekMsT0FBTyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQztnQkFDakMsT0FBTyxFQUFFLEdBQUcsQ0FBQyxPQUFpQzthQUNqRDtTQUNKLENBQUMsQ0FBQTtRQUVGLE1BQU0sQ0FBQyxJQUFJLENBQUMsb0NBQW9DLE1BQU0sRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFBO1FBRWpFLEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUE7SUFDNUMsQ0FBQztJQUFDLE9BQU8sS0FBYyxFQUFFLENBQUM7UUFDdEIsTUFBTSxHQUFHLEdBQUcsSUFBQSw2QkFBZSxFQUFDLEtBQUssQ0FBQyxDQUFBO1FBQ2xDLE1BQU0sQ0FBQyxLQUFLLENBQUMsdUJBQXVCLEdBQUcsRUFBRSxDQUFDLENBQUE7UUFFMUMsb0VBQW9FO1FBQ3BFLEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQTtJQUN4RCxDQUFDO0FBQ0wsQ0FBQyJ9