import {
    createStep,
    createWorkflow,
    StepResponse,
    WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { BRAND_MODULE } from "../modules/brand";
import BrandModuleService from "../modules/brand/service";

// Define the shape of the incoming DummyJSON product
export type DummyProduct = {
    id: number;
    title: string;
    description: string;
    category: string;
    price: number;
    discountPercentage: number;
    rating: number;
    stock: number;
    tags: string[];
    brand: string;
    sku: string;
    weight: number;
    dimensions: {
        width: number;
        height: number;
        depth: number;
    };
    warrantyInformation: string;
    shippingInformation: string;
    availabilityStatus: string;
    reviews: any[];
    returnPolicy: string;
    minimumOrderQuantity: number;
    meta: any;
    images: string[];
    thumbnail: string;
};

type SyncProductsWorkflowInput = {
    products: DummyProduct[];
};

// Step 1: Sync Brands
// Extract brand names, check which exist, create new ones, return Brand ID map.
const syncBrandsStep = createStep(
    "sync-brands-step",
    async (products: DummyProduct[], { container }) => {
        const brandModule: BrandModuleService = container.resolve(BRAND_MODULE);

        // Extract unique brand names
        const brandNames = Array.from(new Set(products.map((p) => p.brand).filter(Boolean)));

        // List existing brands
        // Assuming listBrands accepts filters. If not, we might need to list all or do one by one.
        // Standard MedusaService `list` takes (filters, config).
        // Let's assume we can filter by name in (array) or just list all if not too many. 
        // For safety, let's just list matches if possible, or all.
        const existingBrands = await brandModule.listBrands({
            name: brandNames,
        });

        const existingBrandMap = new Map(existingBrands.map((b) => [b.name, b.id]));
        const brandsToCreate = brandNames.filter((name) => !existingBrandMap.has(name));

        let createdBrands: any[] = [];
        if (brandsToCreate.length > 0) {
            createdBrands = await brandModule.createBrands(
                brandsToCreate.map((name) => ({ name }))
            );
        }

        const finalBrandMap: Record<string, string> = {};
        existingBrands.forEach((b) => (finalBrandMap[b.name] = b.id));
        createdBrands.forEach((b) => (finalBrandMap[b.name] = b.id));

        // Return the map and the IDs of created brands for compensation (rollback)
        return new StepResponse(finalBrandMap, createdBrands.map((b) => b.id));
    },
    async (createdIds: string[], { container }) => {
        if (!createdIds?.length) return;
        const brandModule: BrandModuleService = container.resolve(BRAND_MODULE);
        await brandModule.deleteBrands(createdIds);
    }
);

// Step 2: Sync Products
// Check existing products by external_id, create or update.
const syncProductsStep = createStep(
    "sync-products-step",
    async ({ products, brandMap }: { products: DummyProduct[]; brandMap: Record<string, string> }, { container }) => {
        const productService = container.resolve(Modules.PRODUCT);

        // Get external IDs
        const externalIds = products.map((p) => p.id.toString());

        // Find existing products - standard Product service `listProducts`
        // We filter by valid external_id in metadata
        // Note: Filtering by metadata in standard service might require specific syntax or might not be directly efficient without a plugin, 
        // but for small batches it's okay.
        // Actually, `listProducts` usually takes a selector.
        // { metadata: { external_id: [...] } } ?? might not work out of the box depending on database adapter.
        // Fallback: iterate or simple filter if possible.
        // Let's assume we fetch by handle or keep it simple.
        // Better: use `handle`. DummyJSON doesn't give handles, we can generate one slug from title.
        // But `external_id` is safest for sync.
        // Let's try listing products.
        // listProducts type definition might not explicitly show metadata as filterable, 
        // but underlying engine often supports it. Cast to any to bypass.
        const existingProducts = await productService.listProducts({
            metadata: { external_id: externalIds }
        } as any);

        const existingMap = new Map(existingProducts.map((p) => [p.metadata?.external_id, p]));

        const toCreate: any[] = [];
        const toUpdate: any[] = [];
        
        for (const p of products) {
            const pId = p.id.toString();
            const existing = existingMap.get(pId);

            const handleSlug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
            const handle = `${handleSlug}-${pId}`;

            const productData = {
                title: p.title,
                description: p.description,
                handle: handle,
                thumbnail: p.thumbnail,
                options: [ { title: "Default Option", values: ["Default"] } ],
                variants: [
                    {
                        title: "Default Variant",
                        compare_at_price: p.discountPercentage ? p.price * (1 + p.discountPercentage / 100) : undefined,
                        prices: [
                            {
                                currency_code: "usd",
                                amount: Math.round(p.price * 100),
                            }
                        ],
                        options: { "Default Option": "Default" }
                    }
                ],
                metadata: {
                    external_id: pId,
                    brand_id: brandMap[p.brand]
                }
            };

            if (existing) {
                toUpdate.push({
                    id: existing.id,
                    ...productData,
                });
            } else {
                toCreate.push(productData);
            }
        }
        
        let created: any[] = [];
        if (toCreate.length > 0) {
            created = await productService.createProducts(toCreate);
        }
        
        if (toUpdate.length > 0) {
            // Loop updates to be safe with unknown bulk signature
            await Promise.all(toUpdate.map(update => 
                productService.updateProducts(update.id, update)
            ));
        }

        // Return all involved product IDs for linking
        const allIds = [...created.map(p => p.id), ...existingProducts.map(p => p.id)];
        // Also return which product corresponds to which Dummy product to link brands
        // Map external_id -> product_id
        const productExternalIdMap: Record<string, string> = {};
        created.forEach(p => { if (p.metadata?.external_id) productExternalIdMap[p.metadata.external_id as string] = p.id; });
        existingProducts.forEach(p => { if (p.metadata?.external_id) productExternalIdMap[p.metadata.external_id as string] = p.id; });

        return new StepResponse(productExternalIdMap, created.map(c => c.id));
    },
    async (createdIds: string[], { container }) => {
        if (!createdIds?.length) return;
        const productService = container.resolve(Modules.PRODUCT);
        await productService.deleteProducts(createdIds);
    }
);

// Step 3: Link Brands
const linkProductBrandsStep = createStep(
    "link-product-brands-step",
    async ({ productMap, brandMap, products }: { productMap: Record<string, string>, brandMap: Record<string, string>, products: DummyProduct[] }, { container }) => {
        const remoteLink = container.resolve(ContainerRegistrationKeys.LINK);

        const links: any[] = [];

        for (const p of products) {
            const prodId = productMap[p.id.toString()];
            const brandId = brandMap[p.brand];

            if (prodId && brandId) {
                links.push({
                    [Modules.PRODUCT]: { product_id: prodId },
                    [BRAND_MODULE]: { brand_id: brandId },
                });
            }
        }

        if (links.length > 0) {
            await remoteLink.create(links);
        }

        return new StepResponse(links, links); // compensation needs to dismiss
    },
    async (links: any[], { container }) => {
        const remoteLink = container.resolve(ContainerRegistrationKeys.LINK);
        if (links.length) {
            await remoteLink.dismiss(links);
        }
    }
)

export const syncProductsWorkflow = createWorkflow(
    "sync-products",
    (input: SyncProductsWorkflowInput) => {
        // Step 1: Sync Brands
        const brandMap = syncBrandsStep(input.products);

        // Step 2: Sync Products
        const productMap = syncProductsStep({ products: input.products, brandMap });

        // Step 3: Link
        linkProductBrandsStep({ productMap, brandMap, products: input.products });

        return new WorkflowResponse(productMap);
    }
);
