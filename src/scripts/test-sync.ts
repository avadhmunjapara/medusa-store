

import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import dailyProductSync from "../jobs/daily-product-sync";

export default async function testSync({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
    logger.info("Starting manual test of daily product sync...");
    await dailyProductSync(container);
    logger.info("Manual test completed.");
}
