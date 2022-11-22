import { Request } from "express";
import { ErrorResponse } from "../apiresponse/error.response";
import { NotFoundError } from "../apiresponse/not.found.error";
import { UnauthorizedError } from "../apiresponse/unauthorized.error";
import sequelize, { UserAddress } from "../models";
import { UserAddressAttributes, UserAddressInstance } from "../models/user.address.model";
import { createModel } from "../utils/random.string";

const create = async (req: Request) => {
  const body: UserAddressAttributes = req.body;
  const { user_id } = req.user!;

  let address: UserAddressInstance | null;

  try {
    address = await sequelize.transaction(async function (transaction) {
      // If default
      if (body.is_default) {
        await UserAddress.update({ is_default: false }, { where: { user_id }, transaction });
      }
      // If not default but it's the first address
      if (!body.is_default) {
        const count = await UserAddress.count({ where: { user_id }, transaction });
        if (count == 0) {
          body.is_default = true;
        }
      }

      body.user_id = user_id;
      const address = await createModel<UserAddressInstance>(UserAddress, body, "address_id", transaction);
      return address;
    });
  } catch (error) {
    throw new ErrorResponse(error);
  }
  return address;
};
const update = async (req: Request) => {
  const { address_id } = req.params;
  const body: UserAddressAttributes = req.body;
  const { user_id } = req.user!;

  const address = await findById(address_id);
  if (address.user_id != user_id) {
    throw new UnauthorizedError("Cannot edit another person's address");
  }

  //Reset others default to false if this set to default
  if (body.is_default && !address.is_default) {
    await UserAddress.update({ is_default: false }, { where: { user_id } });
  }

  Object.assign(address, body);
  await address.save();
  return address.reload();
};

const findById = async (address_id: string) => {
  const report = await UserAddress.findOne({ where: { address_id } });
  if (!report) {
    throw new NotFoundError("Address not found");
  }
  return report;
};

const findAllByUserId = async (req: Request) => {
  const { user_id } = req.user!;

  const addresses = await UserAddress.findAll({
    where: { user_id },
  });
  return addresses;
};

export default {
  create,
  update,
  findById,
  findAllByUserId,
};
