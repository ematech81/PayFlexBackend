const mongoose = require('mongoose');
const Invoice = require('../models/invoice');
const Customer = require('../models/customer');

// ─── helpers ──────────────────────────────────────────────────────────────────

const getUserId = (req) => req.user?.id || req.user?._id;

const generateInvoiceNumber = async (userId) => {
  const count = await Invoice.countDocuments({ userId });
  return `INV-${String(count + 1).padStart(3, '0')}`;
};

// Add `id` string alias for `_id` so the frontend can use invoice.id everywhere
const withId = (doc) => {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  obj.id = obj._id.toString();
  return obj;
};

const withIdMany = (docs) => docs.map(withId);


// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOMER ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

const getCustomers = async (req, res) => {
  try {
    const customers = await Customer.find({ userId: getUserId(req) })
      .sort({ createdAt: -1 });

    res.json({ success: true, data: withIdMany(customers) });
  } catch (error) {
    console.error('❌ Get Customers Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch customers' });
  }
};

const createCustomer = async (req, res) => {
  try {
    const { name, email, phone } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'Customer name is required' });
    }

    const customer = await Customer.create({
      userId: getUserId(req),
      name: name.trim(),
      email: email?.trim() || '',
      phone: phone?.trim() || '',
    });

    res.status(201).json({ success: true, data: withId(customer) });
  } catch (error) {
    console.error('❌ Create Customer Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to create customer' });
  }
};

const updateCustomer = async (req, res) => {
  try {
    const { name, email, phone } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'Customer name is required' });
    }

    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, userId: getUserId(req) },
      { name: name.trim(), email: email?.trim() || '', phone: phone?.trim() || '' },
      { new: true, runValidators: true }
    );

    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    res.json({ success: true, data: withId(customer) });
  } catch (error) {
    console.error('❌ Update Customer Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to update customer' });
  }
};

const deleteCustomer = async (req, res) => {
  try {
    const customer = await Customer.findOneAndDelete({
      _id: req.params.id,
      userId: getUserId(req),
    });

    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    res.json({ success: true, message: 'Customer deleted' });
  } catch (error) {
    console.error('❌ Delete Customer Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to delete customer' });
  }
};


// ═══════════════════════════════════════════════════════════════════════════════
// INVOICE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

const getInvoices = async (req, res) => {
  try {
    const { status, search, limit = 50, page = 1 } = req.query;
    const query = { userId: getUserId(req) };

    if (status) query.status = status;
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { invoiceNumber: { $regex: search, $options: 'i' } },
        { 'customer.name': { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [invoices, total] = await Promise.all([
      Invoice.find(query)
        .sort({ createdAt: -1 })
        .limit(Number(limit))
        .skip(skip),
      Invoice.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: withIdMany(invoices),
      pagination: { total, page: Number(page), limit: Number(limit) },
    });
  } catch (error) {
    console.error('❌ Get Invoices Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch invoices' });
  }
};

const getInvoice = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      userId: getUserId(req),
    });

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    res.json({ success: true, data: withId(invoice) });
  } catch (error) {
    console.error('❌ Get Invoice Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch invoice' });
  }
};

const getInvoiceStats = async (req, res) => {
  try {
    const userId = getUserId(req);

    const stats = await Invoice.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$total' },
        },
      },
    ]);

    const result = { Draft: 0, Pending: 0, Processing: 0, Paid: 0 };
    const amounts = { Draft: 0, Pending: 0, Processing: 0, Paid: 0 };

    stats.forEach(({ _id, count, totalAmount }) => {
      if (_id in result) {
        result[_id] = count;
        amounts[_id] = totalAmount;
      }
    });

    res.json({
      success: true,
      data: {
        counts: result,
        amounts,
        total: Object.values(result).reduce((a, b) => a + b, 0),
        totalRevenue: amounts.Paid,
        totalOutstanding: amounts.Pending + amounts.Processing,
      },
    });
  } catch (error) {
    console.error('❌ Get Invoice Stats Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
};

const createInvoice = async (req, res) => {
  try {
    const {
      customer,
      title,
      dueDate,
      currency,
      products,
      discount,
      tax,
      bank,
      accountNumber,
      accountName,
      additionalInfo,
      status,
    } = req.body;

    if (!customer?.name) {
      return res.status(400).json({ success: false, message: 'Customer name is required' });
    }
    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: 'Invoice title is required' });
    }
    if (!dueDate) {
      return res.status(400).json({ success: false, message: 'Due date is required' });
    }
    if (!products?.length) {
      return res.status(400).json({ success: false, message: 'At least one product is required' });
    }

    const invoiceNumber = await generateInvoiceNumber(getUserId(req));

    const invoice = await Invoice.create({
      userId: getUserId(req),
      invoiceNumber,
      customer,
      title: title.trim(),
      dueDate: new Date(dueDate),
      issuedDate: new Date(),
      currency: currency || 'NGN',
      products,
      discount: discount || { type: 'Fixed', value: 0 },
      tax: tax || { type: 'Fixed', value: 0 },
      bank: bank || '',
      accountNumber: accountNumber || '',
      accountName: accountName || '',
      additionalInfo: additionalInfo || '',
      status: status || 'Draft',
    });

    res.status(201).json({ success: true, data: withId(invoice) });
  } catch (error) {
    console.error('❌ Create Invoice Error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create invoice',
    });
  }
};

const updateInvoice = async (req, res) => {
  try {
    const existing = await Invoice.findOne({
      _id: req.params.id,
      userId: getUserId(req),
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    // Paid invoices are immutable
    if (existing.status === 'Paid') {
      return res.status(400).json({
        success: false,
        message: 'Paid invoices cannot be edited',
      });
    }

    const {
      customer,
      title,
      dueDate,
      currency,
      products,
      discount,
      tax,
      bank,
      accountNumber,
      accountName,
      additionalInfo,
      status,
    } = req.body;

    if (customer) existing.customer = customer;
    if (title) existing.title = title.trim();
    if (dueDate) existing.dueDate = new Date(dueDate);
    if (currency) existing.currency = currency;
    if (products?.length) existing.products = products;
    if (discount) existing.discount = discount;
    if (tax) existing.tax = tax;
    if (bank !== undefined) existing.bank = bank;
    if (accountNumber !== undefined) existing.accountNumber = accountNumber;
    if (accountName !== undefined) existing.accountName = accountName;
    if (additionalInfo !== undefined) existing.additionalInfo = additionalInfo;
    if (status && existing.status !== 'Paid') existing.status = status;

    await existing.save();

    res.json({ success: true, data: withId(existing) });
  } catch (error) {
    console.error('❌ Update Invoice Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to update invoice' });
  }
};

const deleteInvoice = async (req, res) => {
  try {
    const invoice = await Invoice.findOneAndDelete({
      _id: req.params.id,
      userId: getUserId(req),
    });

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    res.json({ success: true, message: 'Invoice deleted' });
  } catch (error) {
    console.error('❌ Delete Invoice Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to delete invoice' });
  }
};

const markInvoicePaid = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      userId: getUserId(req),
    });

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    if (invoice.status === 'Paid') {
      return res.status(400).json({ success: false, message: 'Invoice is already marked as paid' });
    }

    invoice.status = 'Paid';
    await invoice.save();

    res.json({ success: true, data: withId(invoice) });
  } catch (error) {
    console.error('❌ Mark Invoice Paid Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to mark invoice as paid' });
  }
};

module.exports = {
  // Customers
  getCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  // Invoices
  getInvoices,
  getInvoice,
  getInvoiceStats,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  markInvoicePaid,
};
