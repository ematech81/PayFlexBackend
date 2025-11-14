
const Paystack = require('paystack-api')(process.env.PAYSTACK_SECRET_KEY);

class PaystackService {
  // Initialize transaction
  async initializeTransaction(email, amount, reference, metadata) {
    try {
      const response = await Paystack.transaction.initialize({
        email,
        amount: amount * 100, // Convert to kobo
        reference,
        metadata,
        callback_url: `${process.env.BASE_URL}/payment/verify`
      });
      return response;
    } catch (error) {
      throw error;
    }
  }

  // Verify transaction
  async verifyTransaction(reference) {
    try {
      const response = await Paystack.transaction.verify(reference);
      return response;
    } catch (error) {
      throw error;
    }
  }

  // Get transaction
  async getTransaction(id) {
    try {
      const response = await Paystack.transaction.get(id);
      return response;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = new PaystackService();