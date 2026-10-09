'use strict';
const { listOrders } = require('./orders');
const { listCustomers } = require('./customers');
const { listInvoices } = require('./invoices');
module.exports = { listOrders, listCustomers, listInvoices };
