'use strict';

async function getInvoice(id) {
  const res = await fetch(`${process.env.BILLING_URL}/invoices/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`billing responded ${res.status}`);
  return res.text();
}

module.exports = { getInvoice };
