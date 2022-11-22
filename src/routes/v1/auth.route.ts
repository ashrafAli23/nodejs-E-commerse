import express from "express";
import authController from "../../controller/auth.controller";
import { validateReq } from "../../middlewares/validate.req";
import authValidation from "../../validations/auth.validation";

const router = express.Router();

router.post("/", validateReq(authValidation.register), authController.register);
router.post("/login", validateReq(authValidation.login), authController.login);
router.post("/refresh-token", validateReq(authValidation.refreshToken), authController.refreshToken);
router.post("/logout", validateReq(authValidation.logout), authController.logout);

export default router;
