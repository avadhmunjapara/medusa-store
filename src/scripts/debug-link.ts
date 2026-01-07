import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
// @ts-ignore
import { BRAND_MODULE } from "../modules/brand"

export default async function debugLink({ container }: ExecArgs) {
    const remoteLink = container.resolve(ContainerRegistrationKeys.LINK)
    console.log("Checking links...")

    try {
        // Try to see if we can create a fake link or just check if it throws immediately
        // Or simply log that we are running
        console.log("Product Module:", Modules.PRODUCT)
        console.log("Brand Module:", BRAND_MODULE)

        // Creating a test link to see if it works
        // We need valid IDs usually, but let's test the "Module not found" error
        try {
            await remoteLink.create([
                {
                    [Modules.PRODUCT]: { id: "test-prod" },
                    [BRAND_MODULE]: { id: "test-brand" }
                }
            ])
        } catch (e: any) {
            console.log("Error creating link:", e.message)
        }

    } catch (error) {
        console.error("Debug Failed:", error)
    }
}
