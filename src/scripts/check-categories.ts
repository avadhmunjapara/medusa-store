
import { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

export default async function checkCategories({ container }: { container: MedusaContainer }) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY);

    const { data: products } = await query.graph({
        entity: "product",
        fields: ["title", "categories.name"],
    });

    console.log("Sample Products with Categories:");
    products.forEach((p: any) => {
        const cats = p.categories?.map((c: any) => c.name).join(", ") || "None";
        console.log(`- ${p.title}: [${cats}]`);
    });
}
