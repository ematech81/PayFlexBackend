
const paystackService = require('../service/paystackServices');
// const Payment = require('../models/Payment');
const vtpassService = require('../services/vtpassService'); // Your VTpass integration

class PaymentController {
  // Initialize payment
  async initializePayment(req, res) {
    try {
      const { amount, service, serviceData } = req.body;
      const userId = req.user.id; // From auth middleware
      
      // Generate unique reference
      const reference = `PF_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Initialize Paystack transaction
      const paystackResponse = await paystackService.initializeTransaction(
        req.user.email,
        amount,
        reference,
        { service, serviceData, userId }
      );
      
      // Save payment record
      const payment = new Payment({
        userId,
        reference,
        amount,
        service,
        status: 'pending',
        metadata: { serviceData }
      });
      await payment.save();
      
      res.status(200).json({
        success: true,
        data: {
          authorization_url: paystackResponse.data.authorization_url,
          access_code: paystackResponse.data.access_code,
          reference
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Verify payment and process VTpass service
  async verifyPayment(req, res) {
    try {
      const { reference } = req.params;
      
      // Verify with Paystack
      const paystackResponse = await paystackService.verifyTransaction(reference);
      
      if (paystackResponse.data.status !== 'success') {
        return res.status(400).json({
          success: false,
          message: 'Payment verification failed'
        });
      }
      
      // Update payment record
      const payment = await Payment.findOne({ reference });
      payment.status = 'success';
      payment.paystackResponse = paystackResponse.data;
      await payment.save();
      
      // Process VTpass service (airtime, data, etc.)
      const vtpassResponse = await vtpassService.processService(
        payment.service,
        payment.metadata.serviceData
      );
      
      payment.vtpassReference = vtpassResponse.requestId;
      await payment.save();
      
      res.status(200).json({
        success: true,
        message: 'Payment successful',
        data: {
          payment,
          serviceResponse: vtpassResponse
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Webhook handler for Paystack
  async handleWebhook(req, res) {
    try {
      const hash = crypto
        .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
        .update(JSON.stringify(req.body))
        .digest('hex');
      
      if (hash !== req.headers['x-paystack-signature']) {
        return res.status(400).send('Invalid signature');
      }
      
      const event = req.body;
      
      if (event.event === 'charge.success') {
        const reference = event.data.reference;
        // Process similar to verifyPayment
      }
      
      res.sendStatus(200);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }

  // Get payment history
  async getPaymentHistory(req, res) {
    try {
      const userId = req.user.id;
      const payments = await Payment.find({ userId })
        .sort({ createdAt: -1 })
        .limit(50);
      
      res.status(200).json({
        success: true,
        data: payments
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
}

module.exports = new PaymentController();