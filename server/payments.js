'use strict';

/*
 * Payment gateway adapter.
 *
 * PAYMENT_MODE=simulated (default) approves every payment instantly so the full
 * order flow can be used before a real gateway contract is in place. To test a
 * failed payment in simulated mode, use a mobile number ending in 0000.
 *
 * To go live, implement `charge` for each method against the chosen provider
 * (e.g. a Mobile Money Operator API, or a National Switch / IPS participant such
 * as a licensed fintech aggregator) and set PAYMENT_MODE=live. Card payments
 * should use the provider's hosted checkout so card details never touch this server.
 */

const crypto = require('node:crypto');

const METHODS = {
  orange_money: { label: 'Orange Money', mobile: true },
  afrimoney: { label: 'Afrimoney', mobile: true },
  qmoney: { label: 'QMoney', mobile: true },
  card: { label: 'Bank card', mobile: false },
};

function mode() {
  return process.env.PAYMENT_MODE || 'simulated';
}

async function charge({ method, amount, msisdn, orderCode }) {
  if (!METHODS[method]) throw new Error('Unsupported payment method');
  if (mode() !== 'simulated') {
    throw new Error(`Live payments for ${METHODS[method].label} are not configured yet`);
  }
  const reference = `SIM-${orderCode}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  if (msisdn && msisdn.endsWith('0000')) {
    return { status: 'failed', reference, message: 'Payment declined (simulated): insufficient balance' };
  }
  return { status: 'success', reference, message: `Simulated ${METHODS[method].label} payment of ${amount} approved` };
}

function listMethods() {
  return Object.entries(METHODS).map(([id, m]) => ({ id, label: m.label, mobile: m.mobile }));
}

module.exports = { charge, listMethods, METHODS, mode };
