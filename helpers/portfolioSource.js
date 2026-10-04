const { isProjectOrder, isPlanOrder, isServiceOrder, getOrderState } = require('./orderStatusEngine');

function publicUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.toString().length > 2000) return '';
    return url.toString();
  } catch { return ''; }
}

// Deliberate allowlist. Never send the order, user, product or payment documents.
function portfolioSource(order) {
  if (!order?.userId || order.userId.isGuest) return null;
  const project = isProjectOrder(order);
  if (!project && !isPlanOrder(order) && !isServiceOrder(order)) return null;
  return {
    id: String(order._id), available: true, type: project ? 'project' : 'service',
    customerId: String(order.userId._id), customerName: String(order.userId.name || '').slice(0, 300),
    name: String(order.projectSnapshot?.displayName || order.servicePlanSnapshot?.serviceName || order.productId?.serviceName || order.orderItems?.[0]?.serviceName || 'Untitled project').slice(0, 300),
    category: String(order.projectSnapshot?.category || order.productId?.category || (project ? 'software' : 'services')).slice(0, 100),
    state: getOrderState(order).code,
    linkedProjectId: project ? '' : String(order.linkedProjectOrderId || ''),
    url: publicUrl(order.projectLink), captureAllowed: order.portfolioCaptureAllowed !== false,
  };
}
module.exports = { portfolioSource, publicUrl };
