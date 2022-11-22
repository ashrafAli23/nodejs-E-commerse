import { Sequelize } from "sequelize";
import { Model, DataTypes } from "sequelize";
import { ModelRegistry } from ".";
import { PaymentChannel, PaymentStatus } from "../enum/payment.enum";
import { ModelStatic, SequelizeAttributes } from "../typing/sequelize.typing";

export interface OrdersPaymentAttributes {
  order_id: string;
  payment_status: PaymentStatus;
  payment_channel: PaymentChannel;
  payment_reference: string;
}

export interface OrdersPaymentInstance
  extends Model<OrdersPaymentAttributes, OrdersPaymentAttributes>,
    OrdersPaymentAttributes {}

//--> Model attributes
export const OrdersPaymentModelAttributes: SequelizeAttributes<OrdersPaymentAttributes> = {
  order_id: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  payment_status: {
    type: DataTypes.ENUM,
    values: Object.values(PaymentStatus),
    defaultValue: PaymentStatus.PENDING,
  },
  payment_channel: {
    type: DataTypes.ENUM,
    values: Object.values(PaymentChannel),
    allowNull: false,
  },
  payment_reference: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
};
// --> Factory....
export function OrdersPaymentFactory(sequelize: Sequelize) {
  const OrdersPayment = <ModelStatic<OrdersPaymentInstance>>sequelize.define(
    "OrdersPayment",
    OrdersPaymentModelAttributes as any,
    {
      timestamps: false,
      tableName: "OrdersPayment",
      freezeTableName: true,
      defaultScope: {},
      indexes: [{ fields: ["order_id"] }],
    }
  );

  OrdersPayment.associate = function (models: ModelRegistry) {
    const { OrdersPayment } = models;

    OrdersPayment.belongsTo(models.Orders, {
      as: "order",
      foreignKey: "order_id",
      targetKey: "order_id",
    });
  };

  OrdersPayment.prototype.toJSON = function () {
    const values = { ...this.get() };
    delete values.createdAt;
    delete values.updatedAt;
    return values;
  };
  return OrdersPayment;
}
