const { formatIndiaDate } = require('./../../helpers/dateTime');
const orderModel = require("../../models/orderProductModel");
const PDFDocument = require('pdfkit');
const mongoose = require('mongoose');
const { getOrderDisplayName } = require('../../helpers/orderPresentation');

const downloadInvoice = async (req, res) => {
  try {
    const { orderId } = req.params;
    
    // Find the order with populated data
    const order = await orderModel.findById(orderId)
      .populate('productId', 'serviceName category')
      .populate('userId', 'name email address');
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    // Create PDF document
    const doc = new PDFDocument();
    
    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${orderId}.pdf`);
    
    // Pipe PDF to response
    doc.pipe(res);
    
    // Add content to PDF
    doc.fontSize(20).text('INVOICE', { align: 'center' });
    doc.moveDown();
    
    // Company info
    doc.fontSize(12).text('Your Company Name', { align: 'right' });
    doc.fontSize(10).text('123 Business Street', { align: 'right' });
    doc.text('City, State ZIP', { align: 'right' });
    doc.text('Email: support@yourcompany.com', { align: 'right' });
    doc.moveDown();
    
    // Invoice details
    doc.fontSize(12).text(`Invoice #: INV-${order._id.toString().substr(-6)}`);
    doc.text(`Order Date: ${formatIndiaDate(order.createdAt)}`);
    doc.moveDown();
    
    // Customer info
    doc.text('Bill To:');
    doc.fontSize(10).text(`${order.userId?.name || 'Customer'}`);
    doc.text(`${order.userId?.email || ''}`);
    if (order.userId?.address) {
      doc.text(order.userId.address);
    }
    doc.moveDown();
    
    // Order items table
    doc.fontSize(12).text('Order Summary', { underline: true });
    doc.moveDown();
    
    // Table headers
    const tableTop = doc.y;
    doc.fontSize(10);
    doc.text('Item', 50, tableTop);
    doc.text('Quantity', 250, tableTop);
    doc.text('Price', 350, tableTop);
    doc.text('Total', 450, tableTop);
    
    doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
    
    let tableRow = tableTop + 25;
    
    // Table rows
    if (order.orderItems && order.orderItems.length > 0) {
      order.orderItems.forEach(item => {
        doc.text(item.name, 50, tableRow);
        doc.text(item.quantity.toString(), 250, tableRow);
        doc.text(`₹${item.originalPrice.toLocaleString()}`, 350, tableRow);
        doc.text(`₹${(item.originalPrice * item.quantity).toLocaleString()}`, 450, tableRow);
        tableRow += 20;
      });
    } else {
      // Fallback if no order items
      doc.text(getOrderDisplayName(order), 50, tableRow);
      doc.text('1', 250, tableRow);
      doc.text(`₹${order.price.toLocaleString()}`, 350, tableRow);
      doc.text(`₹${order.price.toLocaleString()}`, 450, tableRow);
      tableRow += 20;
    }
    
    doc.moveTo(50, tableRow).lineTo(550, tableRow).stroke();
    tableRow += 15;
    
    // Subtotal, discount and total
    const subtotal = order.orderItems ? 
      order.orderItems.reduce((sum, item) => sum + (item.originalPrice * item.quantity), 0) : order.price;
    
    doc.text('Subtotal:', 350, tableRow);
    doc.text(`₹${subtotal.toLocaleString()}`, 450, tableRow);
    tableRow += 20;
    
    if (order.discountAmount && order.discountAmount > 0) {
      doc.text(`Discount ${order.couponApplied ? `(${order.couponApplied})` : ''}:`, 350, tableRow);
      doc.text(`-₹${order.discountAmount.toLocaleString()}`, 450, tableRow);
      tableRow += 20;
    }
    
    doc.fontSize(12);
    doc.text('Total:', 350, tableRow);
    doc.text(`₹${order.price.toLocaleString()}`, 450, tableRow);
    
    doc.moveDown(2);
    
    // Footer
    doc.fontSize(10).text('Thank you for your business!', { align: 'center' });
    
    // Finalize the PDF
    doc.end();
    
  } catch (error) {
    console.error('Error generating invoice:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate invoice'
    });
  }
};

module.exports = downloadInvoice;
