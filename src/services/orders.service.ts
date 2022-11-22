import { Request } from "express";
import sequelize, {
  StoreOrders,
  Orders,
  OrdersPayment,
  OrdersAddress,
  StoreOrdersProduct,
  UserWallet,
} from "../models";
import { Op, Transaction } from "sequelize";
import { FundingTypes, PaymentChannel, PaymentStatus } from "../enum/payment.enum";
import { DeliveryStatus, OrderStatus } from "../enum/orders.enum";
import moment from "moment";
import CONSTANTS from "../utils/constants";
import userWalletService from "./user.wallet.service";
import cartService from "./cart.service";
import couponService from "./coupon.service";
import { CouponInstance } from "../models/coupon.model";
import { ErrorResponse } from "../apiresponse/error.response";
import shippingService from "./shipping.service";
import { genUniqueColId } from "../utils/random.string";
import { asyncForEach } from "../utils/function.utils";
import { UnauthorizedError } from "../apiresponse/unauthorized.error";
import { Helpers } from "../utils/helpers";
import { NotFoundError } from "../apiresponse/not.found.error";
import { isAdmin } from "../utils/admin.utils";
import storeService from "./store.service";
import vendorSettlementService from "./vendor.settlement.service";
import userAddressService from "./user.address.service";
import orderAddressService from "./order.address.service";
import storeOrdersService from "./store.orders.service";
import productVariationService from "./product.variation.service";
import { VendorSettlementInstance } from "../models/vendor.settlement.model";
import { UserWalletAttributes } from "../models/user.wallet.model";
import { OrdersInstance } from "../models/orders.model";
import CouponUtils from "../utils/coupon.utils";
import { StockStatus } from "../enum/product.enum";

//create
const create = async (req: Request) => {
  const { user_id } = req.user!;
  const { coupon_code, address_id }: { coupon_code: string; address_id: string } = req.body;

  const userCarts = await cartService.findAllByUserId(user_id);
  const carts = userCarts.carts;

  // -->check product qty avaialability
  if (carts.length === 0) {
    throw new ErrorResponse("No product found on the cart");
  }
  // -->check product qty avaialability
  if (!cartService.validateCartProductQty(carts)) {
    throw new ErrorResponse("One or more Item is currently out of stock");
  }

  type CouponDataType = {
    coupon_amount: number;
    coupon_amount_without_cap: number;
    sub_total: number;
    coupon: CouponInstance;
  };

  let couponData: CouponDataType | undefined;

  if (coupon_code) {
    //validate coupon
    couponData = await couponService.applyCoupon(user_id, coupon_code);
  }

  const coupon_amount = couponData ? couponData.coupon_amount : 0;
  const overall_tax_amount = 0;
  const overall_shipping_amount = await shippingService.getTotalShipping(carts, address_id);
  const overall_amount = userCarts.sub_total - coupon_amount + overall_shipping_amount + overall_tax_amount;
  // {{ amount = sub_total - coupon_amount + shipping_amount + tax_amount }}

  const order_id = await genUniqueColId(Orders, "order_id", 12, "numeric", "uppercase");

  //Transaction starts...
  const result = await sequelize.transaction(async (transaction) => {
    const order = await Orders.create(
      {
        order_id,
        amount: overall_amount,
        sub_total: userCarts.sub_total,
        coupon_code,
        coupon_amount,
        shipping_amount: overall_shipping_amount,
        tax_amount: overall_tax_amount,
        purchased_by: user_id,
      },
      { transaction }
    );

    const cartStoreIds = carts.map((x) => x.store_id);
    const uniqueStoreIds = Array.from(new Set(cartStoreIds));

    //Iterate each store
    await asyncForEach(uniqueStoreIds, async (store_id) => {
      //Create Sub Order...
      await storeOrdersService.create(order_id, store_id, user_id, address_id, carts, transaction, couponData);
    });

    //Create order address
    const userAddress = await userAddressService.findById(address_id);
    await orderAddressService.create(userAddress, order_id, transaction);
    //clear the cart
    await cartService.clearCart(user_id, undefined, transaction);
    //get all orders
    const store_orders = await storeOrdersService.findAllByOrderId(order_id, transaction);

    return { order, store_orders };
  }); //Transaction ends...

  return findById(result.order.order_id);
};

//update order payment
const updatePayment = async (req: Request) => {
  const { user_id } = req.user!;

  const {
    order_id,
    payment_status,
    payment_reference,
    payed_from_wallet,
    payment_channel,
  }: {
    order_id: string;
    payment_status: PaymentStatus;
    payment_channel: PaymentChannel;
    payment_reference: string;
    payed_from_wallet: boolean;
  } = req.body;

  const subOrder = await StoreOrders.findOne({ where: { sub_order_id: order_id } });
  const orderId = subOrder ? subOrder.order_id : order_id;

  const order = await Orders.findOne({
    where: { order_id: orderId },
    include: [
      {
        model: StoreOrders,
        as: "store_orders",
        include: [{ model: StoreOrdersProduct, as: "products" }],
      },
    ],
  });

  if (!order) {
    throw new ErrorResponse("Order not found");
  }

  if (order.purchased_by !== user_id) {
    throw new UnauthorizedError();
  }

  if (order.store_orders.find((o) => o.order_status == OrderStatus.CANCELLED)) {
    throw new ErrorResponse("one or more StoreOrders already cancelled");
  }

  if (order.payment_completed) {
    throw new ErrorResponse("This order is already payed for");
  }

  if (payed_from_wallet) {
    const balance = await userWalletService.getWalletBalance(user_id);
    if (balance < order.amount) {
      throw new ErrorResponse("Insufficient balance to purchase the order from wallet");
    }
  }

  let transaction: Transaction | undefined;
  try {
    transaction = await sequelize.transaction();

    //Completed payment
    if (payment_status == PaymentStatus.COMPLETED || payed_from_wallet) {
      // update all the sub orders for stores with auto_complete_order == true
      await asyncForEach(order.store_orders, async (sub_order) => {
        const { store_id } = sub_order;
        const { settings } = await storeService.findById(store_id, transaction);
        if (settings.auto_complete_order) {
          await StoreOrders.update(
            { order_status: OrderStatus.COMPLETED },
            { where: { order_id: order.order_id, store_id }, transaction }
          );
        }
      });

      //update this order
      if (payed_from_wallet) order.payed_from_wallet = true;

      order.payment_completed = true;
      await order.save({ transaction });

      //Validate orders + Update product qty &/or product flashsale sold
      await validateOrder(order, transaction);
    }

    if (!payed_from_wallet) {
      //create payment
      await OrdersPayment.create({ order_id, payment_status, payment_reference, payment_channel }, { transaction });
    }

    await transaction.commit();
  } catch (error: any) {
    if (transaction) {
      await transaction.rollback();
    }
    throw new ErrorResponse(error);
  }

  return findById(order.order_id);
};
//Admin update order payment
const adminUpdatePayment = async (req: Request) => {
  const { role } = req.user!;

  const { order_id, payment_status }: { order_id: string; payment_status: PaymentStatus } = req.body;

  if (!isAdmin(role)) {
    throw new UnauthorizedError();
  }

  const subOrder = await StoreOrders.findOne({ where: { sub_order_id: order_id } });
  const orderId = subOrder ? subOrder.order_id : order_id;

  const order = await Orders.findOne({
    where: { order_id: orderId },
    include: [
      {
        model: StoreOrders,
        as: "store_orders",
        include: [{ model: StoreOrdersProduct, as: "products" }],
      },
    ],
  });

  if (!order) {
    throw new ErrorResponse("Order not found");
  }

  if (order.store_orders.find((o) => o.order_status == OrderStatus.CANCELLED)) {
    throw new ErrorResponse("one or more StoreOrders already cancelled");
  }

  if (order.payment_completed) {
    throw new ErrorResponse("Payment is already made for this order");
  }

  let transaction: Transaction | undefined;
  try {
    transaction = await sequelize.transaction();

    if (payment_status == PaymentStatus.COMPLETED) {
      // update all the sub orders for stores with auto_complete_order == true
      await asyncForEach(order.store_orders, async (sub_order) => {
        const { store_id } = sub_order;
        const { settings } = await storeService.findById(store_id, transaction);
        if (settings.auto_complete_order) {
          await StoreOrders.update(
            { order_status: OrderStatus.COMPLETED },
            { where: { order_id: order.order_id, store_id }, transaction }
          );
        }
      });

      order.payment_completed = true;
      await order.save({ transaction });

      //Validate orders + Update product qty &/or product flashsale sold
      await validateOrder(order, transaction);
    }

    const payment_channel = PaymentChannel.REFUND;
    const payment_reference = await genUniqueColId(OrdersPayment, "payment_reference", 15);
    //create payment
    await OrdersPayment.create({ order_id, payment_status, payment_reference, payment_channel }, { transaction });

    await transaction.commit();
  } catch (error: any) {
    if (transaction) {
      await transaction.rollback();
    }
    throw new ErrorResponse(error);
  }

  return findById(order!.order_id);
};

const validateOrder = async (order: OrdersInstance, transaction: Transaction) => {
  let calcSubTotal = 0;
  let couponAmount = 0;

  await asyncForEach(order.store_orders, async (sub_order) => {
    await asyncForEach(sub_order.products, async (product) => {
      const { variation_id, qty } = product;
      const { discount, flash_discount, price } = await productVariationService.findById(variation_id);

      if (flash_discount) {
        calcSubTotal += qty * flash_discount.price;
      } else if (discount) {
        calcSubTotal += qty * discount.price;
      } else {
        calcSubTotal += qty * price;
      }

      if (order.coupon_code) {
        const coupon = await couponService.findByCouponCode(order.coupon_code);
        couponAmount += CouponUtils.calcCouponAmount(coupon, qty, price, discount, flash_discount);
      }
    });
  });

  const amount = calcSubTotal - couponAmount;

  if (amount !== order.amount) {
    throw new Error("Order couldn't be validated");
  }

  //Update qty remaining...
  //Extra validation(s) could be removed shaaa...
  await asyncForEach(order.store_orders, async (sub_order) => {
    await asyncForEach(sub_order.products, async (product) => {
      const { variation_id, qty } = product;
      const variation = await productVariationService.findById(variation_id, transaction);
      const { flash_discount } = variation;

      if (variation.with_storehouse_management) {
        if (variation.stock_qty < qty) {
          throw new Error(`Item(${variation.product.name}) is currently out of stock`);
        }

        variation.stock_qty = variation.stock_qty - qty;
        await variation.save({ transaction });
      } else {
        if (variation.stock_status !== StockStatus.IN_STOCK) {
          throw new Error(`Item ${variation.product.name} is currently out of stock`);
        }
      }
      //If flashsale is included
      if (flash_discount) {
        if (flash_discount.qty < flash_discount.sold + qty) {
          const qtyRem = flash_discount.qty - flash_discount.sold;
          throw new Error(`Item(${variation.product.name}) quantity remaining on flash sale is ${qtyRem}`);
        }
        flash_discount.sold = flash_discount.sold + qty;
        await flash_discount.save({ transaction });
      }
    });
  });
  return true;
};

// update order status (can't be changed once it's marked completed)
const updateOrderStatus = async (req: Request) => {
  const { role, stores, user_id } = req.user!;
  const { sub_order_id } = req.params;
  const { order_status }: { order_status: OrderStatus } = req.body;

  const sub_order = await storeOrdersService.findById(sub_order_id);

  if (!isAdmin(role) && !stores.includes(sub_order_id)) {
    throw new UnauthorizedError();
  }

  if (OrderStatus.CANCELLED == sub_order.order_status) {
    throw new ErrorResponse("Order already cancelled");
  }
  if (OrderStatus.COMPLETED === sub_order.order_status) {
    throw new ErrorResponse("Completed order can't be updated");
  }

  if (sub_order.refunded) {
    throw new ErrorResponse("Refunded order can't be updated");
  }
  if (sub_order.settled) {
    throw new ErrorResponse("Settled order can't be updated");
  }

  if (order_status === OrderStatus.CANCELLED) {
    sub_order.cancelled_by = user_id;
  }
  sub_order.order_status = order_status;
  await sub_order.save();
  return storeOrdersService.findById(sub_order_id);
};

// update delivery status
const updateDeliveryStatus = async (req: Request) => {
  const { role, stores } = req.user!;
  const { sub_order_id } = req.params;
  const { delivery_status }: { delivery_status: DeliveryStatus } = req.body;

  const sub_order = await storeOrdersService.findById(sub_order_id);

  if (!isAdmin(role) && !stores.includes(sub_order_id)) {
    throw new UnauthorizedError();
  }

  if (OrderStatus.CANCELLED === sub_order.order_status) {
    throw new ErrorResponse("This order is already cancelled");
  }

  if (DeliveryStatus.DELIVERED === sub_order.delivery_status) {
    if (delivery_status !== DeliveryStatus.AUDITED) {
      throw new ErrorResponse("Delivered order can only be audited");
    }
  }

  if (delivery_status == DeliveryStatus.DELIVERED && !sub_order.order.payment_completed) {
    throw new ErrorResponse('"None paid" order can\'t be marked "Delivered"');
  }

  if (DeliveryStatus.AUDITED === sub_order.delivery_status) {
    throw new ErrorResponse("Delivery already audited & can't be updated further");
  }
  if (DeliveryStatus.CANCELLED === sub_order.delivery_status) {
    throw new ErrorResponse("Delivery already cancelled");
  }

  if (sub_order.settled) {
    throw new ErrorResponse("Settled order can't be updated");
  }

  if (sub_order.order_status !== OrderStatus.COMPLETED && delivery_status == DeliveryStatus.DELIVERED) {
    throw new ErrorResponse(
      "None completed order can't be marked delivered. Mark order status to completed to proceed"
    );
  }

  if (DeliveryStatus.DELIVERED == delivery_status) {
    sub_order.delivered = true;
    sub_order.delivered_at = new Date();
  }

  sub_order.delivery_status = delivery_status;
  await sub_order.save();
  return storeOrdersService.findById(sub_order_id);
};

// user cancel order
const userCancelOrder = async (req: Request) => {
  const { user_id } = req.user!;
  const { sub_order_id } = req.params;

  const sub_order = await storeOrdersService.findById(sub_order_id);

  if (sub_order.purchased_by !== user_id) {
    throw new UnauthorizedError();
  }

  if (sub_order.order_status == OrderStatus.CANCELLED) {
    throw new ErrorResponse("Order already cancelled");
  }

  if (sub_order.delivered) {
    throw new ErrorResponse("Can't cancel this order");
  }

  if (sub_order.refunded) {
    throw new ErrorResponse("Order already refunded");
  }

  if (sub_order.settled) {
    throw new ErrorResponse("Refund not available(Order already settled)");
  }

  sub_order.order_status = OrderStatus.CANCELLED;
  sub_order.cancelled_by = user_id;
  await sub_order.save();

  return storeOrdersService.findById(sub_order_id);
};

// admin process refund
const processRefund = async (req: Request) => {
  const { role } = req.user!;
  const { sub_order_id } = req.params;
  const { amount }: { amount: number } = req.body;

  const sub_order = await storeOrdersService.findById(sub_order_id);
  const order = await findById(sub_order.order_id);

  if (!isAdmin(role)) {
    throw new UnauthorizedError();
  }

  if (amount > sub_order.amount) {
    throw new ErrorResponse(`Refund amount must be lower or equal ${sub_order.amount}`);
  }
  if (!order.payment_completed) {
    throw new ErrorResponse("Payment not yet made for this order");
  }

  if (sub_order.refunded) {
    throw new ErrorResponse("Order already refunded");
  }
  if (OrderStatus.CANCELLED !== sub_order.order_status) {
    throw new ErrorResponse("Order has to be cancelled before initiating refund");
  }

  if (sub_order.settled) {
    throw new ErrorResponse("Refund not available(Order already settled)");
  }

  const deliveredAtTillNow = moment(sub_order.delivered_at).add(CONSTANTS.RETURNABLE_DAYS_MILLISECONDS, "d"); //or day, days

  const isPeriodExpired = moment(deliveredAtTillNow).isAfter();

  if (isPeriodExpired) {
    throw new ErrorResponse("Guarantee period has passed");
  }

  try {
    await sequelize.transaction(async (t) => {
      sub_order.refunded = true;
      sub_order.refunded_at = new Date();
      await sub_order.save({ transaction: t });

      //refund the user wallet
      const payment_reference = await genUniqueColId(UserWallet, "payment_reference", 17);
      const creditPayload: UserWalletAttributes = {
        user_id: order.purchased_by,
        amount,
        fund_type: FundingTypes.REFUND,
        payment_reference,
        action_performed_by: order.purchased_by,
        sub_order_id,
      };
      await userWalletService.createCredit(creditPayload, t);
    });
  } catch (error: any) {
    throw new ErrorResponse(error);
  }

  return storeOrdersService.findById(sub_order_id);
};

// --> Process Teachers settlement(With order IDs)
const settleStore = async (req: Request) => {
  const { store_id, sub_order_ids } = req.body;
  const { role } = req.user!;

  const RETURNABLE_PERIOD = CONSTANTS.RETURNABLE_PERIOD;

  if (!isAdmin(role)) {
    throw new UnauthorizedError();
  }

  let settlement: VendorSettlementInstance | undefined;
  try {
    await sequelize.transaction(async (t) => {
      const [_, rows] = await StoreOrders.update(
        { settled: true, settled_at: new Date() },
        {
          where: {
            sub_order_id: { [Op.in]: sub_order_ids },
            settled: false,
            delivered: true,
            delivered_at: { [Op.lte]: RETURNABLE_PERIOD },
          },
          returning: true,
          transaction: t,
        }
      );

      const amountSettled = rows.map((o) => o.store_price).reduce((a, b) => a + b, 0);
      const updated_sub_order_ids = rows.map((o) => o.sub_order_id);
      settlement = await vendorSettlementService.create(updated_sub_order_ids, amountSettled, store_id, t);
    });
  } catch (error: any) {
    throw new ErrorResponse(error);
  }

  return settlement;
};

//--> store/Vendor Unsettled Orders
const storeUnsettledOrders = async (req: Request) => {
  const { store_id } = req.params;
  const { limit = 100, offset = 0 } = req.query as any;
  const { role, stores } = req.user!;

  const TOLERABLE_PERIOD = CONSTANTS.RETURNABLE_PERIOD;

  if (!stores.includes(store_id) && !isAdmin(role)) {
    throw new UnauthorizedError();
  }

  const totalUnsettled = await StoreOrders.findAll({
    where: {
      store_id,
      delivered: true,
      settled: false,
      delivered_at: { [Op.lte]: TOLERABLE_PERIOD },
    },
    limit,
    offset,
  });

  return totalUnsettled;
};

//find one
const findById = async (order_id: string, transaction?: Transaction) => {
  const order = await Orders.findOne({
    where: { order_id },
    paranoid: false,
    include: [
      {
        model: OrdersPayment,
        as: "payment",
        where: { payment_status: PaymentStatus.COMPLETED },
        required: false,
      },
      {
        model: StoreOrders,
        as: "store_orders",
        include: [{ model: StoreOrdersProduct, as: "products" }],
      },
      {
        model: OrdersAddress,
        as: "address",
        attributes: { exclude: ["createdAt", "updatedAt"] },
      },
    ],
  });
  if (!order) {
    throw new NotFoundError("Order not found");
  }

  return order;
};

//find many {limit, offset, createdAt}
const findAll = async (req: Request) => {
  const { limit, offset } = Helpers.getPaginate(req.query);
  const { user_id: current_user, role } = req.user!;
  const { search_query, order_status, coupon_code, user_id, store_id, refunded, amount } = req.query;

  const where: { [key: string]: any } = {};

  if (order_status) {
    where["$store_orders.order_status$"] = order_status;
  }
  if (store_id) {
    where["$store_orders.store_id$"] = store_id;
  }
  if (coupon_code) {
    where.coupon_code = coupon_code;
  }
  if (user_id) {
    if (user_id !== current_user && !isAdmin(role)) {
      throw new UnauthorizedError(`Unauthorized to access ${user_id} data`);
    }
    where.purchased_by = user_id;
  }
  if (refunded) {
    where.refunded = refunded;
  }
  if (amount) {
    where.amount = amount;
  }

  if (search_query) {
    where[Op.or as any] = [
      { order_id: { [Op.iLike]: `%${search_query}%` } },
      { ["$store_orders.sub_order_id$"]: { [Op.iLike]: `%${search_query}%` } },
    ];
  }

  const orders = await Orders.findAll({
    where,
    subQuery: false,
    include: [
      {
        model: OrdersPayment,
        as: "payment",
        required: false,
        where: { payment_status: PaymentStatus.COMPLETED },
      },
      {
        model: StoreOrders,
        as: "store_orders",
        include: [{ model: StoreOrdersProduct, as: "products" }],
      },
      {
        model: OrdersAddress,
        as: "address",
        attributes: { exclude: ["createdAt", "updatedAt"] },
      },
    ],

    order: [["createdAt", "DESC"]],
    ...{ limit, offset },
  });

  return orders;
};

//find all by coupon code(Internal route)
const findAllByCouponOrUser = async (coupon_code?: string, user_id?: string) => {
  const where: { [key: string]: any } = { payment_completed: true };

  if (coupon_code) {
    where.coupon_code = coupon_code;
  }
  if (user_id) {
    where.purchased_by = user_id;
  }

  const orders = await Orders.findAll({
    where,
    include: [{ model: StoreOrders, as: "store_orders" }],
  });

  return orders;
};

export default {
  create,
  updatePayment,
  adminUpdatePayment,
  updateOrderStatus,
  updateDeliveryStatus,
  userCancelOrder,
  processRefund,
  settleStore,
  storeUnsettledOrders,
  findById,
  findAll,
  findAllByCouponOrUser,
};
