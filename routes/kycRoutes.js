const router = require("express").Router();
const { body } = require("express-validator");
const { protect, requireRoles } = require("../middleware/auth");
const {
  submitBVN,
  uploadID,
  adminVerifyID,
} = require("../controllers/kycController");

// BVN verification
router.post(
  "/bvn",
  protect,
  [
    body("bvn")
      .isLength({ min: 11, max: 11 })
      .withMessage("BVN must be 11 digits"),
    body("firstName").notEmpty(),
    body("lastName").notEmpty(),
    body("phone").notEmpty().isMobilePhone(),
    body("dob").notEmpty(), // YYYY-MM-DD
  ],
  submitBVN
);

// ID upload (multipart/form-data) fields: idType, idImage(file)
router.post("/id", protect, uploadID);

// Admin approve/reject ID
router.post("/id/verify", protect, requireRoles("admin"), adminVerifyID);

module.exports = router;
