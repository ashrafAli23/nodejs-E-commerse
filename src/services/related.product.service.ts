import { Request } from "express";
import { UnauthorizedError } from "../apiresponse/unauthorized.error";
import { UserRoleStatus } from "../enum/user.enum";
import { Product, RelatedProduct } from "../models";
import { isAdmin } from "../utils/admin.utils";

const create = async (req: Request) => {
  const { role } = req.user!;

  const { product_id, related_product_ids }: { product_id: string; related_product_ids: string[] } = req.body;

  if (!isAdmin(role) && role !== UserRoleStatus.VENDOR) {
    throw new UnauthorizedError();
  }

  const payload = related_product_ids.map((related_product_id) => ({
    related_product_id,
    product_id,
  }));

  const relatedProducts = await RelatedProduct.bulkCreate(payload, { ignoreDuplicates: true, validate: true });

  return relatedProducts;
};

const remove = async (req: Request) => {
  const { role } = req.user!;
  const { product_id, related_product_id }: { product_id: string; related_product_id: string } = req.body;

  if (!isAdmin(role) && role !== UserRoleStatus.VENDOR) {
    throw new UnauthorizedError();
  }
  const del = await RelatedProduct.destroy({ where: { product_id, related_product_id } });

  return !!del;
};

const findForProduct = async (req: Request) => {
  const { product_id } = req.params;

  const products = await Product.findAll({
    where: { "$related_products.product_id$": product_id } as any,
    subQuery: false,
    include: { model: RelatedProduct, as: "related_products" },
  });
  return products;
};
export default {
  create,
  remove,
  findForProduct,
};
