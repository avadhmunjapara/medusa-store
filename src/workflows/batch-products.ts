import {
    createStep,
    createWorkflow,
    StepResponse,
    WorkflowResponse,
    transform,
} from "@medusajs/framework/workflows-sdk";
import { Modules, ContainerRegistrationKeys, ProductStatus } from "@medusajs/framework/utils";
import { BRAND_MODULE } from "../modules/brand";
import BrandModuleService from "../modules/brand/service";

// Define simplified inputs for the workflow
type ProductInput = {
    title: string;
    description: string;
    handle: string;
    status: string;
    metadata: Record<string, any>;
    variants: any[];
    images?: any[];
    thumbnail?: string;
    brandName?: string;
    categoryName?: string;
};

type BatchWorkflowInput = {
    create: ProductInput[];
    update: ({ id: string } & Partial<ProductInput>)[];
};

// Step 1: Manage Brands
// Input: All brand names from the batch
// Output: Map of Brand Name -> Brand ID
const manageBrandsStep = createStep(
    "manage-brands-step",
    async (brandNames: string[], { container }) => {
        const brandModule: BrandModuleService = container.resolve(BRAND_MODULE);

        if (brandNames.length === 0) {
            return new StepResponse({}, []);
        }

        const uniqueNames = Array.from(new Set(brandNames));
        const existingBrands = await brandModule.listBrands({
            name: uniqueNames,
        } as any);

        const brandMap: Record<string, string> = {};
        existingBrands.forEach((b) => (brandMap[b.name] = b.id));

        const toCreate = uniqueNames.filter((n) => !brandMap[n]);
        let createdIds: string[] = [];

        if (toCreate.length > 0) {
            const created = await brandModule.createBrands(toCreate.map(name => ({ name })));
            created.forEach((b) => (brandMap[b.name] = b.id));
            createdIds = created.map(b => b.id);
        }

        return new StepResponse(brandMap, createdIds);
    },
    async (createdIds: string[], { container }) => {
        if (!createdIds?.length) return;
        const brandModule = container.resolve(BRAND_MODULE);
        await brandModule.deleteBrands(createdIds);
    }
);

// Step 1.5: Manage Categories
const manageCategoriesStep = createStep(
    "manage-categories-step",
    async (categoryNames: string[], { container }) => {
        const productService = container.resolve(Modules.PRODUCT);

        if (categoryNames.length === 0) {
            return new StepResponse({}, []);
        }

        const uniqueNames = Array.from(new Set(categoryNames));
        
        const nameToHandle = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const handles = uniqueNames.map(nameToHandle);

        const existingCategories = await productService.listProductCategories({
            handle: handles
        });

        const categoryMap: Record<string, string> = {}; // Name -> ID
        const handleMap = new Map(existingCategories.map(c => [c.handle, c]));

        const toCreate: { name: string, handle: string }[] = [];

        for (const name of uniqueNames) {
            const handle = nameToHandle(name);
            if (handleMap.has(handle)) {
                categoryMap[name] = handleMap.get(handle)!.id;
            } else {
                toCreate.push({ name, handle });
            }
        }

        let createdIds: string[] = [];
        if (toCreate.length > 0) {
            try {
                const created = await productService.createProductCategories(toCreate);
                created.forEach(c => {
                     const original = uniqueNames.find(u => nameToHandle(u) === c.handle);
                     if (original) categoryMap[original] = c.id;
                });
                createdIds = created.map(c => c.id);
            } catch (error) {
                // If creation failed (likely constraint), re-fetch all handles to fill map
                // We assume one or more handles already existed.
                const fallbackCategories = await productService.listProductCategories({
                    handle: handles
                });
                fallbackCategories.forEach(c => {
                     // Find original name that maps to this handle
                     const original = uniqueNames.find(u => nameToHandle(u) === c.handle);
                     if (original) categoryMap[original] = c.id;
                });
            }
        }

        return new StepResponse(categoryMap, createdIds);
    },
    async (createdIds: string[], { container }) => {
        if (!createdIds?.length) return;
        const productService = container.resolve(Modules.PRODUCT);
        await productService.deleteProductCategories(createdIds);
    }
);

// Step 2: Create Products
const createProductsStep = createStep(
    "create-products-step",
    async (input: { products: ProductInput[], categoryMap: Record<string, string> }, { container }) => {
        const { products, categoryMap } = input;
        if (!products.length) return new StepResponse([], []);

        const productService = container.resolve(Modules.PRODUCT);
        
        const dtos = products.map(({ brandName, categoryName, status, ...rest }) => ({
            ...rest,
            status: ProductStatus[status.toUpperCase() as keyof typeof ProductStatus] || ProductStatus.DRAFT,
            category_ids: categoryName && categoryMap[categoryName] ? [categoryMap[categoryName]] : []
        }));
        
        const created = await productService.createProducts(dtos);
        
        return new StepResponse(created, created.map(p => p.id));
    },
    async (ids: string[], { container }) => {
        if (!ids?.length) return;
        const productService = container.resolve(Modules.PRODUCT);
        await productService.deleteProducts(ids);
    }
);

// Step 3: Update Products
const updateProductsStep = createStep(
    "update-products-step",
    async (input: { updates: ({ id: string } & Partial<ProductInput>)[], categoryMap: Record<string, string> }, { container }) => {
        const { updates, categoryMap } = input;
        if (!updates.length) return new StepResponse([], []);

        const productService = container.resolve(Modules.PRODUCT);
        
        const results = await Promise.all(updates.map(async (u) => {
            const { brandName, categoryName, id, status, ...rest } = u;
            const updateData: any = { ...rest };
            
            if (status) {
                updateData.status = ProductStatus[status.toUpperCase() as keyof typeof ProductStatus] || ProductStatus.DRAFT;
            }
            if (categoryName && categoryMap[categoryName]) {
                updateData.category_ids = [categoryMap[categoryName]];
            }

            return await productService.updateProducts(id, updateData);
        }));

        return new StepResponse(results, updates.map(u => u.id));
    },
    async (ids: string[], { container }) => {
        // Compensation omitted
    }
);

// Step 4: Link Brands
const linkProductBrandsStep = createStep(
    "link-product-brands-step",
    async ({
        createdProducts,
        updatedProducts,
        brandMap,
        originalCreateInput,
        originalUpdateInput
    }: {
        createdProducts: any[],
        updatedProducts: any[],
        brandMap: Record<string, string>,
        originalCreateInput: ProductInput[],
        originalUpdateInput: ({ id: string } & Partial<ProductInput>)[]
    }, { container }) => {
        const remoteLink = container.resolve(ContainerRegistrationKeys.LINK);
        const logger = container.resolve("logger");
        const links: any[] = [];

        // Helper to find brand ID for a product
        const getBrandId = (inputItems: any[], p: any) => {
            const extId = p.metadata?.external_id;
            const inputItem = inputItems.find(i => i.metadata?.external_id === extId);
            if (inputItem?.brandName) {
                return brandMap[inputItem.brandName];
            }
            return null;
        };

        // Links for created
        for (const p of createdProducts) {
            const brandId = getBrandId(originalCreateInput, p);
            if (brandId) {
                links.push({
                    [Modules.PRODUCT]: { product_id: p.id },
                    [BRAND_MODULE]: { brand_id: brandId },
                });
            }
        }

        // Links for updated
        for (const p of updatedProducts) {
            const brandId = getBrandId(originalUpdateInput, p);
            if (brandId) {
                links.push({
                    [Modules.PRODUCT]: { product_id: p.id },
                    [BRAND_MODULE]: { brand_id: brandId },
                });
            }
        }

        // Deduplicate links
        const uniqueLinks = Array.from(new Set(links.map(l => JSON.stringify(l)))).map((s: string) => JSON.parse(s));

        if (uniqueLinks.length > 0) {
            try {
                await remoteLink.dismiss(uniqueLinks);
            } catch (e) {
                // Ignore
            }
            
            try {
                await remoteLink.create(uniqueLinks);
            } catch (error) {
                logger.warn("Failed to create brand links, they might already exist.", error);
            }
        }

        return new StepResponse(links, links);
    },
    async (links: any[], { container }) => {
        if (links.length) {
            const remoteLink = container.resolve(ContainerRegistrationKeys.LINK);
            // We only compensate by dismissing if we created them. 
            // Since we might have swallowed creation error, strictly we shouldn't dismiss 
            // pre-existing links on compensation, but distinguishing is hard.
            // For sync, leaving links is safer than deleting correct links.
            // await remoteLink.dismiss(links);
        }
    }
);

export const batchProductsWorkflow = createWorkflow(
    "sync-batch-products",
    (input: BatchWorkflowInput) => {
        // Collect brands and categories
        const extracted = transform({ input }, (data) => {
            return {
                brands: [
                    ...data.input.create.map(p => p.brandName),
                    ...data.input.update.map(p => p.brandName)
                ].filter((n): n is string => !!n),
                categories: [
                    ...data.input.create.map(p => p.categoryName),
                    ...data.input.update.map(p => p.categoryName)
                ].filter((n): n is string => !!n)
            };
        });

        const brandMap = manageBrandsStep(extracted.brands);
        const categoryMap = manageCategoriesStep(extracted.categories);

        const createdProducts = createProductsStep({ 
            products: input.create, 
            categoryMap 
        });
        
        const updatedProducts = updateProductsStep({ 
            updates: input.update, 
            categoryMap 
        });

        linkProductBrandsStep({
            createdProducts,
            updatedProducts,
            brandMap,
            originalCreateInput: input.create,
            originalUpdateInput: input.update
        });

        return new WorkflowResponse({
            created: createdProducts,
            updated: updatedProducts
        });
    }
);
