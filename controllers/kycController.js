const { validationResult } = require("express-validator");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const User = require("../models/user");
const { verifyBVN } = require("../service/kycProvider");

// ====== BVN ======
exports.submitBVN = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { bvn, firstName, lastName, phone, dob } = req.body;

    const result = await verifyBVN({ bvn, firstName, lastName, phone, dob });

    if (!result.match) {
      req.user.kyc = {
        ...req.user.kyc,
        bvn,
        bvnVerified: false,
        status: "pending",
      };
      await req.user.save();
      return res
        .status(400)
        .json({ message: "BVN could not be verified", result: result.details });
    }

    req.user.kyc.bvn = bvn;
    req.user.kyc.bvnVerified = true;
    req.user.kyc.status = req.user.kyc.idVerified ? "verified" : "pending";
    await req.user.save();

    res.json({
      message: "BVN verified",
      kyc: req.user.kyc,
      provider: result.raw?.provider || "provider",
    });
  } catch (e) {
    next(e);
  }
};

// ====== ID Upload ======
// Local dev storage (for production, use Cloudinary/S3)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/ids"),
  filename: (req, file, cb) =>
    cb(null, `${req.user._id}-${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (req, file, cb) => {
    const ok = /jpeg|jpg|png/i.test(path.extname(file.originalname));
    ok ? cb(null, true) : cb(new Error("Only jpg, jpeg, png allowed"));
  },
}).single("idImage");

// If using Cloudinary instead, swap the handler to upload to cloud and store secure_url.

exports.uploadID = (req, res, next) => {
  upload(req, res, async (err) => {
    try {
      if (err) return next(err);
      if (!req.file)
        return res.status(400).json({ message: "No file uploaded" });

      const { idType } = req.body;
      if (
        !["NIN", "DRIVERS_LICENSE", "PASSPORT", "VOTER_ID"].includes(idType)
      ) {
        // cleanup
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ message: "Invalid idType" });
      }

      req.user.kyc.idType = idType;
      req.user.kyc.idImageUrl = `/${req.file.path.replace(/\\/g, "/")}`; // served via /uploads
      req.user.kyc.idVerified = false; // set true after manual/auto review
      req.user.kyc.status = req.user.kyc.bvnVerified ? "pending" : "unverified";
      await req.user.save();

      res.json({
        message: "ID uploaded. Pending verification.",
        kyc: req.user.kyc,
      });
    } catch (e2) {
      next(e2);
    }
  });
};

// Optional: Admin endpoint to approve/reject ID after review
exports.adminVerifyID = async (req, res, next) => {
  try {
    const { userId, approve, notes } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.kyc.idVerified = !!approve;
    user.kyc.notes = notes || null;
    user.kyc.status =
      user.kyc.bvnVerified && user.kyc.idVerified
        ? "verified"
        : approve
        ? "pending"
        : "rejected";
    await user.save();

    res.json({ message: "KYC updated", kyc: user.kyc });
  } catch (e) {
    next(e);
  }
};
