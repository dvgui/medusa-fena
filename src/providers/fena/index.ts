import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import FenaPaymentProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
    services: [FenaPaymentProviderService],
})
