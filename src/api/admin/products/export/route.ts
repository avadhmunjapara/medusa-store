import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=products.csv");

    const header = [
        "ID",
        "External ID",
        "Title",
        "Handle",
        "Status",
        "Brand",
        "Price (USD)",
        "Created At"
    ].join(",");

    res.write(header + "\n");

    const requestedLimit = parseInt(req.query.limit as string) || 100;
    const requestedOffset = parseInt(req.query.offset as string) || 0;

    // Batch size for internal fetching to avoid memory issues, but respecting limits
    const BATCH_SIZE = 50;

    let currentOffset = requestedOffset;
    let productsFetched = 0;
    let hasMore = true;

    try {
        while (hasMore && productsFetched < requestedLimit) {
            // Determine how many to fetch in this batch: min(BatchSize, RemainingLimit)
            const remaining = requestedLimit - productsFetched;
            const take = Math.min(BATCH_SIZE, remaining);

            const { data: products } = await query.graph({
                entity: "product",
                fields: [
                    "id",
                    "title",
                    "handle",
                    "status",
                    "created_at",
                    "metadata",
                    "variants.prices.*",
                    "brand.name"
                ],
                pagination: {
                    skip: currentOffset,
                    take: take
                }
            });

            if (!products || products.length === 0) {
                hasMore = false;
                break;
            }

            for (const product of products) {
                let usdPrice: number | undefined;
                // Check variants prices
                if (product.variants && product.variants.length > 0) {
                    const v = product.variants[0];
                    if (v.prices) {
                        const p = v.prices.find((pr: any) => pr.currency_code === 'usd');
                        if (p) usdPrice = p.amount;
                    }
                }

                const priceDisplay = usdPrice ? (usdPrice / 100).toFixed(2) : "N/A";
                const brandName = product.brand?.name || "";

                const row = [
                    product.id,
                    product.metadata?.external_id || "",
                    `"${product.title?.replace(/"/g, '""')}"`,
                    product.handle,
                    product.status,
                    `"${brandName.replace(/"/g, '""')}"`,
                    priceDisplay,
                    product.created_at
                ].join(",");

                res.write(row + "\n");
            }

            productsFetched += products.length;
            currentOffset += products.length;

            if (products.length < take) {
                hasMore = false;
            }
        }
    } catch (error) {
        console.error("Error exporting products:", error);
        res.write(`\nERROR: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    } finally {
        res.end();
    }
}
