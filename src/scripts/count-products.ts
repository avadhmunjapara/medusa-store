
import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";

export default async function countProducts({ container }: ExecArgs) {
    const productService = container.resolve(Modules.PRODUCT);
    const logger = container.resolve("logger");

    const [products, count] = await productService.listAndCountProducts({});
    logger.info(`Total products found: ${count}`);
    if (products.length > 0) {
        logger.info(`Sample product: ${products[0].title} (ID: ${products[0].id})`);
    } else {
        logger.info("No products returned by listAndCountProducts.");
    }
}
