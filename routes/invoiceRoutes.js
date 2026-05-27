const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getInvoices,
  getInvoice,
  getInvoiceStats,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  markInvoicePaid,
} = require('../controllers/invoiceController');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: errors.array()[0].msg });
  }
  next();
};

// ─── Customers ─────────────────────────────────────────────────────────────

router.get('/customers', protect, getCustomers);

router.post(
  '/customers',
  protect,
  [body('name').notEmpty().withMessage('Name is required').trim()],
  validate,
  createCustomer
);

router.put(
  '/customers/:id',
  protect,
  [body('name').notEmpty().withMessage('Name is required').trim()],
  validate,
  updateCustomer
);

router.delete('/customers/:id', protect, deleteCustomer);

// ─── Invoices ──────────────────────────────────────────────────────────────

// Stats must come before /:id or it gets captured as an id
router.get('/stats', protect, getInvoiceStats);

router.get('/', protect, getInvoices);

router.get('/:id', protect, getInvoice);

router.post(
  '/',
  protect,
  [
    body('customer.name').notEmpty().withMessage('Customer name is required'),
    body('title').notEmpty().withMessage('Invoice title is required'),
    body('dueDate').notEmpty().withMessage('Due date is required').isISO8601().withMessage('Invalid due date'),
    body('products').isArray({ min: 1 }).withMessage('At least one product is required'),
    body('products.*.name').notEmpty().withMessage('Product name is required'),
    body('products.*.quantity').isFloat({ min: 1 }).withMessage('Product quantity must be at least 1'),
    body('products.*.price').isFloat({ min: 0 }).withMessage('Product price must be 0 or more'),
    body('currency').optional().isIn(['NGN', 'USD', 'EUR']).withMessage('Currency must be NGN, USD, or EUR'),
  ],
  validate,
  createInvoice
);

router.put(
  '/:id',
  protect,
  [
    body('products').optional().isArray({ min: 1 }).withMessage('At least one product is required'),
    body('currency').optional().isIn(['NGN', 'USD', 'EUR']).withMessage('Invalid currency'),
  ],
  validate,
  updateInvoice
);

router.delete('/:id', protect, deleteInvoice);

router.patch('/:id/mark-paid', protect, markInvoicePaid);

module.exports = router;
