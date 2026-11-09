'use strict';

const DISTRICTS = [
  'Bo', 'Bombali', 'Bonthe', 'Falaba', 'Kailahun', 'Kambia', 'Karene', 'Kenema',
  'Koinadugu', 'Kono', 'Moyamba', 'Port Loko', 'Pujehun', 'Tonkolili',
  'Western Area Rural', 'Western Area Urban',
];

const CATEGORIES = [
  'Vegetables', 'Fruits', 'Rice & grains', 'Roots & tubers', 'Legumes & nuts',
  'Palm oil & oils', 'Poultry & eggs', 'Livestock', 'Fish', 'Spices & peppers',
];

const UNITS = ['kg', 'bag (50kg)', 'bag (25kg)', 'bunch', 'basket', 'crate', 'litre', 'gallon', 'piece', 'dozen', 'tin'];

const ORDER_STATUSES = {
  placed: 'Waiting for farmer',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  declined: 'Declined by farmer',
  cancelled: 'Cancelled',
};

module.exports = { DISTRICTS, CATEGORIES, UNITS, ORDER_STATUSES };
