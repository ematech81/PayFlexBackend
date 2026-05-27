const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    invoiceNumber: {
      type: String,
      required: true,
    },
    // Snapshot of customer at invoice creation time
    customer: {
      id: String,
      name: { type: String, required: true },
      email: { type: String, default: '' },
      phone: { type: String, default: '' },
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    issuedDate: {
      type: Date,
      default: Date.now,
    },
    currency: {
      type: String,
      enum: ['NGN', 'USD', 'EUR'],
      default: 'NGN',
    },
    products: {
      type: [productSchema],
      required: true,
      validate: {
        validator: (v) => v.length > 0,
        message: 'Invoice must have at least one product',
      },
    },
    discount: {
      type: { type: String, enum: ['Fixed', 'Percentage'], default: 'Fixed' },
      value: { type: Number, default: 0, min: 0 },
    },
    tax: {
      type: { type: String, enum: ['Fixed', 'Percentage'], default: 'Fixed' },
      value: { type: Number, default: 0, min: 0 },
    },
    // Calculated totals (stored for quick display)
    subtotal: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    // Payment details
    bank: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    accountName: { type: String, default: '' },
    additionalInfo: { type: String, default: '' },
    status: {
      type: String,
      enum: ['Draft', 'Pending', 'Processing', 'Paid'],
      default: 'Draft',
      index: true,
    },
    paidAt: { type: Date },
  },
  { timestamps: true }
);

invoiceSchema.index({ userId: 1, createdAt: -1 });
invoiceSchema.index({ userId: 1, status: 1 });
invoiceSchema.index({ userId: 1, invoiceNumber: 1 }, { unique: true });

// Calculate totals before save
invoiceSchema.pre('save', function (next) {
  const subtotal = this.products.reduce(
    (sum, p) => sum + p.quantity * p.price,
    0
  );
  const discountAmount =
    this.discount.value > 0
      ? this.discount.type === 'Fixed'
        ? this.discount.value
        : (subtotal * this.discount.value) / 100
      : 0;
  const taxAmount =
    this.tax.value > 0
      ? this.tax.type === 'Fixed'
        ? this.tax.value
        : (subtotal * this.tax.value) / 100
      : 0;

  this.subtotal = subtotal;
  this.discountAmount = discountAmount;
  this.taxAmount = taxAmount;
  this.total = subtotal - discountAmount + taxAmount;

  if (this.isModified('status') && this.status === 'Paid' && !this.paidAt) {
    this.paidAt = new Date();
  }

  next();
});

module.exports =
  mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema);
