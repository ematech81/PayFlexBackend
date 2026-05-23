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
      req.user.bvnVerification = {
        bvn,
        status: "failed",
        verifiedAt: new Date(),
      };
      req.user.isBVNVerified = false;
      await req.user.save();
      return res
        .status(400)
        .json({ message: "BVN could not be verified", result: result.details });
    }

    req.user.bvnVerification = {
      bvn,
      firstName: result.details?.firstName || firstName,
      surname: result.details?.lastName || lastName,
      phoneNumber: result.details?.phone || phone,
      dateOfBirth: result.details?.dob || dob,
      reportId: result.raw?.reportId,
      verifiedAt: new Date(),
      status: "verified",
    };
    req.user.isBVNVerified = true;

    // Promote overall kyc status
    if (req.user.isNINVerified) {
      req.user.kyc = "verified";
      req.user.verificationStatus = "fully_verified";
    } else {
      req.user.verificationStatus = "bvn_verified";
    }

    await req.user.save();

    res.json({
      message: "BVN verified",
      isBVNVerified: req.user.isBVNVerified,
      verificationStatus: req.user.verificationStatus,
      provider: result.raw?.provider || "provider",
    });
  } catch (e) {
    next(e);
  }
};

// ====== ID Upload ======
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

exports.uploadID = (req, res, next) => {
  upload(req, res, async (err) => {
    try {
      if (err) return next(err);
      if (!req.file)
        return res.status(400).json({ message: "No file uploaded" });

      const { idType } = req.body;
      if (!["NIN", "DRIVERS_LICENSE", "PASSPORT", "VOTER_ID"].includes(idType)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ message: "Invalid idType" });
      }

      // Store on ninVerification as a placeholder until a dedicated idDoc field is added
      req.user.ninVerification = {
        ...req.user.ninVerification?.toObject?.() || {},
        idType,
        idImageUrl: `/${req.file.path.replace(/\\/g, "/")}`,
        status: "pending",
      };
      await req.user.save();

      res.json({
        message: "ID uploaded. Pending verification.",
        idType,
        status: "pending",
      });
    } catch (e2) {
      next(e2);
    }
  });
};

// Admin approve/reject ID
exports.adminVerifyID = async (req, res, next) => {
  try {
    const { userId, approve, notes } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (approve) {
      user.isNINVerified = true;
      user.ninVerification = { ...user.ninVerification?.toObject?.() || {}, status: "verified", verifiedAt: new Date() };
      if (user.isBVNVerified) {
        user.kyc = "verified";
        user.verificationStatus = "fully_verified";
      } else {
        user.verificationStatus = "nin_verified";
      }
    } else {
      user.isNINVerified = false;
      user.ninVerification = { ...user.ninVerification?.toObject?.() || {}, status: "failed" };
      user.kyc = "rejected";
    }

    await user.save();

    res.json({
      message: "KYC updated",
      kyc: user.kyc,
      verificationStatus: user.verificationStatus,
      notes: notes || null,
    });
  } catch (e) {
    next(e);
  }
};
