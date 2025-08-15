const axios = require("axios");

/**
 * verifyBVN({ bvn, firstName, lastName, phone, dob })
 * Implement actual provider call here.
 * Return a normalized result:
 * { match: boolean, details: {...}, raw: providerResponse }
 */
exports.verifyBVN = async ({ bvn, firstName, lastName, phone, dob }) => {
  // Example (pseudo) with VERIFYME:
  // const res = await axios.post(process.env.VERIFYME_BVN_URL, { bvn }, {
  //   headers: { Authorization: `Bearer ${process.env.VERIFYME_KEY}` }
  // });
  // const match = (res.data?.data?.bvn === bvn); // simplify, add strong matching rules
  // return { match, details: res.data?.data ?? {}, raw: res.data };

  // Sandbox stub (DEV ONLY) — replace with real provider call above:
  if (process.env.NODE_ENV !== "production") {
    const match = String(bvn).length === 11; // fake rule
    return {
      match,
      details: { bvn, firstName, lastName, phone, dob },
      raw: { provider: "sandbox", ok: true },
    };
  }

  throw new Error("KYC provider not configured");
};
