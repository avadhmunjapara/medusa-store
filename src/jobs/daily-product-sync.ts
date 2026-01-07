import { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { batchProductsWorkflow } from "../workflows/batch-products";

type DummyProduct = {
    id: number;
    title: string;
    description: string;
    price: number;
    brand: string;
    thumbnail: string;
    images: string[];
    [key: string]: any;
};

type DummyResponse = {
    products: DummyProduct[];
    total: number;
    skip: number;
    limit: number;
};

// 1. fetchWithRetry
async function fetchWithRetry<T>(url: string, retries = 2, backoff = 1000): Promise<T> {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
            return (await res.json()) as T;
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise((resolve) => setTimeout(resolve, backoff * Math.pow(2, i)));
        }
    }
    throw new Error("Unreachable");
}

// 2. mapToMedusaFormat
function mapToMedusaFormat(product: DummyProduct) {
    return {
        title: product.title,
        description: product.description,
        // Ensure handle is URL safe
        handle: product.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") + "-" + product.id,
        status: "draft",
        metadata: {
            external_id: product.id.toString()
        },
        thumbnail: product.thumbnail,
        brandName: product.brand,
        categoryName: product.category,
        variants: [
            {
                title: "Default",
                prices: [
                    {
                        amount: Math.round(product.price * 100), // cents
                        currency_code: "usd",
                    },
                ],
                options: { "Default Option": "Default" }
            },
        ],
        options: [{ title: "Default Option", values: ["Default"] }]
    };
}

// 3. fetchAllProducts (Generator for batches)
async function* fetchAllProducts(limit = 20) {
    let skip = 0;
    let hasMore = true;

    while (hasMore) {
        const url = `https://dummyjson.com/products?limit=${limit}&skip=${skip}`;
        const data = await fetchWithRetry<DummyResponse>(url);

        if (!data.products || data.products.length === 0) {
            hasMore = false;
            break;
        }

        yield data.products;

        skip += limit;
        if (skip >= data.total) hasMore = false;
    }
}

// 4. Main sync logic
export default async function dailyProductSync(container: MedusaContainer) {
    const logger = container.resolve("logger");
    const productService = container.resolve(Modules.PRODUCT);

    logger.info("Starting daily product sync...");

    try {
        for await (const batch of fetchAllProducts(20)) {
            logger.info(`Processing batch of ${batch.length} products...`);

            const externalIds = batch.map(p => p.id.toString());

            // Check existing
            const existingProducts = await productService.listProducts({
                metadata: { external_id: externalIds } // Query assuming metadata filtering works or plugin enabled
            } as any);

            const existingMap = new Map(existingProducts.map(p => [p.metadata?.external_id, p]));

            const createBatch: any[] = [];
            const updateBatch: any[] = [];

            for (const p of batch) {
                const medusaProduct = mapToMedusaFormat(p);
                const externalId = p.id.toString();
                const existing = existingMap.get(externalId);

                if (existing) {
                    updateBatch.push({
                        id: existing.id,
                        ...medusaProduct,
                    });
                } else {
                    createBatch.push(medusaProduct);
                }
            }

            if (createBatch.length > 0 || updateBatch.length > 0) {
                const { errors } = await batchProductsWorkflow(container).run({
                    input: {
                        create: createBatch,
                        update: updateBatch
                    },
                    throwOnError: false
                });

                if (errors && errors.length) {
                    logger.error("Error syncing batch:", new Error(JSON.stringify(errors)));
                } else {
                    logger.info(`Synced batch: ${createBatch.length} created, ${updateBatch.length} updated.`);
                }
            }
        }
        logger.info("Daily product sync completed.");
    } catch (error) {
        logger.error("Critical error in product sync:", error);
    }
}

export const config = {
    name: "daily-product-sync",
    schedule: "0 0 * * *",
};
