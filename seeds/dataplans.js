'use strict';

/**
 * Data Plan Seed Script
 *
 * Upserts all Active VTU Africa data plans into MongoDB.
 * Safe to re-run — uses upsert so it won't duplicate.
 * Disabled plans are NOT seeded.
 *
 * Usage:
 *   node seeds/dataplans.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const DataPlan = require('../models/DataPlan');

const PLANS = [
  // ── MTN SME (MTNSME) ───────────────────────────────────────────────────────
  { network: 'MTN',    serviceType: 'SME',       serviceCode: 'MTNSME',      dataPlanCode: '500W',   description: 'MTN SME Data',      size: '500MB',  validity: '7 Days',   costPrice: 360   },
  { network: 'MTN',    serviceType: 'SME',       serviceCode: 'MTNSME',      dataPlanCode: '1000',   description: 'MTN SME Data',      size: '1GB',    validity: '30 Days',  costPrice: 800   },
  { network: 'MTN',    serviceType: 'SME',       serviceCode: 'MTNSME',      dataPlanCode: '2000',   description: 'MTN SME Data',      size: '2GB',    validity: '30 Days',  costPrice: 1460  },
  { network: 'MTN',    serviceType: 'SME',       serviceCode: 'MTNSME',      dataPlanCode: '3000',   description: 'MTN SME Data',      size: '3GB',    validity: '30 Days',  costPrice: 1800  },
  { network: 'MTN',    serviceType: 'SME',       serviceCode: 'MTNSME',      dataPlanCode: '5000W',  description: 'MTN SME Data',      size: '5GB',    validity: '7 Days',   costPrice: 1870  },
  { network: 'MTN',    serviceType: 'SME',       serviceCode: 'MTNSME',      dataPlanCode: '6000W',  description: 'MTN SME Data',      size: '6GB',    validity: '7 Days',   costPrice: 2475  },
  { network: 'MTN',    serviceType: 'SME',       serviceCode: 'MTNSME',      dataPlanCode: '10000',  description: 'MTN SME Data',      size: '10GB',   validity: '30 Days',  costPrice: 4500  },

  // ── MTN Gifting (MTNGIFT) ──────────────────────────────────────────────────
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '40',     description: 'MTN Gifting Data',  size: '40MB',    validity: '1 Day',    costPrice: 67    },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '75',     description: 'MTN Gifting Data',  size: '75MB',    validity: '1 Day',    costPrice: 91    },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '500',    description: 'MTN Gifting Data',  size: '500MB',   validity: '7 Days',   costPrice: 505   },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '750',    description: 'MTN Gifting Data',  size: '750MB',   validity: '3 Days',   costPrice: 455   },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '1000D',  description: 'MTN Gifting Data',  size: '1GB',     validity: '1 Day',    costPrice: 505   },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '2000D',  description: 'MTN Gifting Data',  size: '2GB',     validity: '2 Days',   costPrice: 750   },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '2500D',  description: 'MTN Gifting Data',  size: '2.5GB',   validity: '1 Day',    costPrice: 750   },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '2500',   description: 'MTN Gifting Data',  size: '2.5GB',   validity: '2 Days',   costPrice: 895   },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '3200',   description: 'MTN Gifting Data',  size: '3.2GB',   validity: '2 Days',   costPrice: 995   },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '1000W',  description: 'MTN Gifting Data',  size: '1GB',     validity: '7 Days',   costPrice: 795   },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '1500W',  description: 'MTN Gifting Data',  size: '1.5GB',   validity: '7 Days',   costPrice: 990   },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '6000W',  description: 'MTN Gifting Data',  size: '6GB',     validity: '7 Days',   costPrice: 2430  },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '2000',   description: 'MTN Gifting Data',  size: '2GB',     validity: '30 Days',  costPrice: 1480  },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '2700',   description: 'MTN Gifting Data',  size: '2.7GB',   validity: '30 Days',  costPrice: 1965  },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '3500',   description: 'MTN Gifting Data',  size: '3.5GB',   validity: '30 Days',  costPrice: 2440  },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '5000',   description: 'MTN Gifting Data',  size: '5GB',     validity: '30 Days',  costPrice: 2600  },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '7000',   description: 'MTN Gifting Data',  size: '7GB',     validity: '30 Days',  costPrice: 3460  },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '10000',  description: 'MTN Gifting Data',  size: '10GB',    validity: '30 Days',  costPrice: 4390  },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '12500',  description: 'MTN Gifting Data',  size: '12.5GB',  validity: '30 Days',  costPrice: 5445  },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '16500',  description: 'MTN Gifting Data',  size: '16.5GB',  validity: '30 Days',  costPrice: 6370  },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '20000',  description: 'MTN Gifting Data',  size: '20GB',    validity: '30 Days',  costPrice: 7515  },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '25000',  description: 'MTN Gifting Data',  size: '25GB',    validity: '30 Days',  costPrice: 8915  },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '36000',  description: 'MTN Gifting Data',  size: '36GB',    validity: '30 Days',  costPrice: 10815 },
  { network: 'MTN',    serviceType: 'Gifting',   serviceCode: 'MTNGIFT',     dataPlanCode: '75000',  description: 'MTN Gifting Data',  size: '75GB',    validity: '30 Days',  costPrice: 17500 },

  // ── MTN Awoof (MTNAWOOF) ───────────────────────────────────────────────────
  { network: 'MTN',    serviceType: 'Awoof',     serviceCode: 'MTNAWOOF',    dataPlanCode: '1000D',  description: 'MTN Awoof Data',    size: '1GB',     validity: '1 Day',    costPrice: 505   },
  { network: 'MTN',    serviceType: 'Awoof',     serviceCode: 'MTNAWOOF',    dataPlanCode: '1400',   description: 'MTN Awoof Data',    size: '1.4GB',   validity: '3 Days',   costPrice: 1771  },
  { network: 'MTN',    serviceType: 'Awoof',     serviceCode: 'MTNAWOOF',    dataPlanCode: '20000W', description: 'MTN Awoof Data',    size: '20GB',    validity: '7 Days',   costPrice: 9840  },

  // ── Airtel SME (AIRTELSME) ─────────────────────────────────────────────────
  { network: 'Airtel', serviceType: 'SME',       serviceCode: 'AIRTELSME',   dataPlanCode: '150',    description: 'Airtel SME Data',   size: '150MB',  validity: '1 Day',    costPrice: 80    },
  { network: 'Airtel', serviceType: 'SME',       serviceCode: 'AIRTELSME',   dataPlanCode: '300',    description: 'Airtel SME Data',   size: '300MB',  validity: '2 Days',   costPrice: 130   },
  { network: 'Airtel', serviceType: 'SME',       serviceCode: 'AIRTELSME',   dataPlanCode: '600',    description: 'Airtel SME Data',   size: '600MB',  validity: '2 Days',   costPrice: 235   },
  { network: 'Airtel', serviceType: 'SME',       serviceCode: 'AIRTELSME',   dataPlanCode: '1000D',  description: 'Airtel SME Data',   size: '1GB',    validity: '1 Day',    costPrice: 373   },
  { network: 'Airtel', serviceType: 'SME',       serviceCode: 'AIRTELSME',   dataPlanCode: '3000W',  description: 'Airtel SME Data',   size: '3GB',    validity: '7 Days',   costPrice: 1085  },
  { network: 'Airtel', serviceType: 'SME',       serviceCode: 'AIRTELSME',   dataPlanCode: '7000W',  description: 'Airtel SME Data',   size: '7GB',    validity: '7 Days',   costPrice: 2050  },
  { network: 'Airtel', serviceType: 'SME',       serviceCode: 'AIRTELSME',   dataPlanCode: '4000',   description: 'Airtel SME Data',   size: '4GB',    validity: '30 Days',  costPrice: 2465  },
  { network: 'Airtel', serviceType: 'SME',       serviceCode: 'AIRTELSME',   dataPlanCode: '10000',  description: 'Airtel SME Data',   size: '10GB',   validity: '30 Days',  costPrice: 3115  },
  { network: 'Airtel', serviceType: 'SME',       serviceCode: 'AIRTELSME',   dataPlanCode: '13000',  description: 'Airtel SME Data',   size: '13GB',   validity: '30 Days',  costPrice: 4940  },

  // ── Airtel Corporate (AIRTELCG) ────────────────────────────────────────────
  { network: 'Airtel', serviceType: 'Corporate', serviceCode: 'AIRTELCG',    dataPlanCode: '100',    description: 'Airtel Corporate Data', size: '100MB', validity: '7 Days',  costPrice: 120   },
  { network: 'Airtel', serviceType: 'Corporate', serviceCode: 'AIRTELCG',    dataPlanCode: '300',    description: 'Airtel Corporate Data', size: '300MB', validity: '7 Days',  costPrice: 285   },
  { network: 'Airtel', serviceType: 'Corporate', serviceCode: 'AIRTELCG',    dataPlanCode: '500',    description: 'Airtel Corporate Data', size: '500MB', validity: '30 Days', costPrice: 505   },
  { network: 'Airtel', serviceType: 'Corporate', serviceCode: 'AIRTELCG',    dataPlanCode: '1000',   description: 'Airtel Corporate Data', size: '1GB',   validity: '30 Days', costPrice: 995   },
  { network: 'Airtel', serviceType: 'Corporate', serviceCode: 'AIRTELCG',    dataPlanCode: '2000',   description: 'Airtel Corporate Data', size: '2GB',   validity: '30 Days', costPrice: 1975  },
  { network: 'Airtel', serviceType: 'Corporate', serviceCode: 'AIRTELCG',    dataPlanCode: '5000',   description: 'Airtel Corporate Data', size: '5GB',   validity: '30 Days', costPrice: 4915  },
  { network: 'Airtel', serviceType: 'Corporate', serviceCode: 'AIRTELCG',    dataPlanCode: '10000',  description: 'Airtel Corporate Data', size: '10GB',  validity: '30 Days', costPrice: 9815  },
  { network: 'Airtel', serviceType: 'Corporate', serviceCode: 'AIRTELCG',    dataPlanCode: '15000',  description: 'Airtel Corporate Data', size: '15GB',  validity: '30 Days', costPrice: 14715 },
  { network: 'Airtel', serviceType: 'Corporate', serviceCode: 'AIRTELCG',    dataPlanCode: '20000',  description: 'Airtel Corporate Data', size: '20GB',  validity: '30 Days', costPrice: 19615 },

  // ── Airtel Gifting (AIRTELGIFT) ────────────────────────────────────────────
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '75',     description: 'Airtel Gifting Data', size: '75MB',   validity: '1 Day',    costPrice: 94.9  },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '200',    description: 'Airtel Gifting Data', size: '200MB',  validity: '3 Days',   costPrice: 221   },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '500',    description: 'Airtel Gifting Data', size: '500MB',  validity: '3 Days',   costPrice: 511   },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '1000D',  description: 'Airtel Gifting Data', size: '1GB',    validity: '1 Day',    costPrice: 510   },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '1500D',  description: 'Airtel Gifting Data', size: '1.5GB',  validity: '2 Days',   costPrice: 610   },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '3000D',  description: 'Airtel Gifting Data', size: '3GB',    validity: '2 Days',   costPrice: 1005  },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '1000W',  description: 'Airtel Gifting Data', size: '1GB',    validity: '7 Days',   costPrice: 805   },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '1500W',  description: 'Airtel Gifting Data', size: '1.5GB',  validity: '7 Days',   costPrice: 1010  },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '6000W',  description: 'Airtel Gifting Data', size: '6GB',    validity: '7 Days',   costPrice: 2508  },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '2000',   description: 'Airtel Gifting Data', size: '2GB',    validity: '30 Days',  costPrice: 1500  },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '3000',   description: 'Airtel Gifting Data', size: '3GB',    validity: '30 Days',  costPrice: 1995  },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '4000',   description: 'Airtel Gifting Data', size: '4GB',    validity: '30 Days',  costPrice: 2517  },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '8000',   description: 'Airtel Gifting Data', size: '8GB',    validity: '30 Days',  costPrice: 3008  },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '10000',  description: 'Airtel Gifting Data', size: '10GB',   validity: '30 Days',  costPrice: 4005  },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '13000',  description: 'Airtel Gifting Data', size: '13GB',   validity: '30 Days',  costPrice: 4988  },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '18000',  description: 'Airtel Gifting Data', size: '18GB',   validity: '30 Days',  costPrice: 6015  },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '25000',  description: 'Airtel Gifting Data', size: '25GB',   validity: '30 Days',  costPrice: 8070  },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '35000',  description: 'Airtel Gifting Data', size: '35GB',   validity: '30 Days',  costPrice: 10015 },
  { network: 'Airtel', serviceType: 'Gifting',   serviceCode: 'AIRTELGIFT',  dataPlanCode: '60000',  description: 'Airtel Gifting Data', size: '60GB',   validity: '30 Days',  costPrice: 15290 },

  // ── GLO SME (GLOSME) ───────────────────────────────────────────────────────
  { network: 'GLO',    serviceType: 'SME',       serviceCode: 'GLOSME',      dataPlanCode: '50',     description: 'GLO SME Data',      size: '50MB',   validity: '1 Day',       costPrice: 67   },
  { network: 'GLO',    serviceType: 'SME',       serviceCode: 'GLOSME',      dataPlanCode: '125',    description: 'GLO SME Data',      size: '125MB',  validity: '1 Day',       costPrice: 113  },
  { network: 'GLO',    serviceType: 'SME',       serviceCode: 'GLOSME',      dataPlanCode: '260',    description: 'GLO SME Data',      size: '260MB',  validity: '2 Days',      costPrice: 207  },
  { network: 'GLO',    serviceType: 'SME',       serviceCode: 'GLOSME',      dataPlanCode: '350',    description: 'GLO SME Data',      size: '350MB',  validity: '1 Day',       costPrice: 115  },
  { network: 'GLO',    serviceType: 'SME',       serviceCode: 'GLOSME',      dataPlanCode: '750N',   description: 'GLO SME Data',      size: '750MB',  validity: '1 Night',     costPrice: 134  },
  { network: 'GLO',    serviceType: 'SME',       serviceCode: 'GLOSME',      dataPlanCode: '750',    description: 'GLO SME Data',      size: '750MB',  validity: '1 Day',       costPrice: 220  },
  { network: 'GLO',    serviceType: 'SME',       serviceCode: 'GLOSME',      dataPlanCode: '1250D',  description: 'GLO SME Data',      size: '1.25GB', validity: '1 Sunday',    costPrice: 215  },
  { network: 'GLO',    serviceType: 'SME',       serviceCode: 'GLOSME',      dataPlanCode: '1500D',  description: 'GLO SME Data',      size: '1.5GB',  validity: '1 Day',       costPrice: 315  },
  { network: 'GLO',    serviceType: 'SME',       serviceCode: 'GLOSME',      dataPlanCode: '2500D',  description: 'GLO SME Data',      size: '2.5GB',  validity: '2 Days',      costPrice: 515  },
  { network: 'GLO',    serviceType: 'SME',       serviceCode: 'GLOSME',      dataPlanCode: '10000W', description: 'GLO SME Data',      size: '10GB',   validity: '7 Days',      costPrice: 2015 },

  // ── GLO Corporate (GLOCG) ─────────────────────────────────────────────────
  { network: 'GLO',    serviceType: 'Corporate', serviceCode: 'GLOCG',       dataPlanCode: '200',    description: 'GLO Corporate Data', size: '200MB',  validity: '14 Days',  costPrice: 105  },
  { network: 'GLO',    serviceType: 'Corporate', serviceCode: 'GLOCG',       dataPlanCode: '500',    description: 'GLO Corporate Data', size: '500MB',  validity: '30 Days',  costPrice: 225  },
  { network: 'GLO',    serviceType: 'Corporate', serviceCode: 'GLOCG',       dataPlanCode: '1000',   description: 'GLO Corporate Data', size: '1GB',    validity: '30 Days',  costPrice: 425  },
  { network: 'GLO',    serviceType: 'Corporate', serviceCode: 'GLOCG',       dataPlanCode: '2000',   description: 'GLO Corporate Data', size: '2GB',    validity: '30 Days',  costPrice: 830  },
  { network: 'GLO',    serviceType: 'Corporate', serviceCode: 'GLOCG',       dataPlanCode: '3000',   description: 'GLO Corporate Data', size: '3GB',    validity: '30 Days',  costPrice: 1240 },
  { network: 'GLO',    serviceType: 'Corporate', serviceCode: 'GLOCG',       dataPlanCode: '5000',   description: 'GLO Corporate Data', size: '5GB',    validity: '30 Days',  costPrice: 2060 },
  { network: 'GLO',    serviceType: 'Corporate', serviceCode: 'GLOCG',       dataPlanCode: '10000',  description: 'GLO Corporate Data', size: '10GB',   validity: '30 Days',  costPrice: 4070 },

  // ── GLO Gifting (GLOGIFT) ─────────────────────────────────────────────────
  { network: 'GLO',    serviceType: 'Gifting',   serviceCode: 'GLOGIFT',     dataPlanCode: '50',     description: 'GLO Gifting Data',  size: '50MB',   validity: '1 Day',    costPrice: 66   },
  { network: 'GLO',    serviceType: 'Gifting',   serviceCode: 'GLOGIFT',     dataPlanCode: '150',    description: 'GLO Gifting Data',  size: '150MB',  validity: '1 Day',    costPrice: 112  },
  { network: 'GLO',    serviceType: 'Gifting',   serviceCode: 'GLOGIFT',     dataPlanCode: '350',    description: 'GLO Gifting Data',  size: '350MB',  validity: '1 Day',    costPrice: 206  },
  { network: 'GLO',    serviceType: 'Gifting',   serviceCode: 'GLOGIFT',     dataPlanCode: '1000W',  description: 'GLO Gifting Data',  size: '1GB',    validity: '14 Days',  costPrice: 485  },
  { network: 'GLO',    serviceType: 'Gifting',   serviceCode: 'GLOGIFT',     dataPlanCode: '3900',   description: 'GLO Gifting Data',  size: '3.9GB',  validity: '30 Days',  costPrice: 960  },
  { network: 'GLO',    serviceType: 'Gifting',   serviceCode: 'GLOGIFT',     dataPlanCode: '7500',   description: 'GLO Gifting Data',  size: '7.5GB',  validity: '30 Days',  costPrice: 2395 },
  { network: 'GLO',    serviceType: 'Gifting',   serviceCode: 'GLOGIFT',     dataPlanCode: '9000',   description: 'GLO Gifting Data',  size: '9.2GB',  validity: '30 Days',  costPrice: 1920 },
  { network: 'GLO',    serviceType: 'Gifting',   serviceCode: 'GLOGIFT',     dataPlanCode: '10000',  description: 'GLO Gifting Data',  size: '10.8GB', validity: '30 Days',  costPrice: 2880 },
  { network: 'GLO',    serviceType: 'Gifting',   serviceCode: 'GLOGIFT',     dataPlanCode: '14000',  description: 'GLO Gifting Data',  size: '14GB',   validity: '30 Days',  costPrice: 3845 },
  { network: 'GLO',    serviceType: 'Gifting',   serviceCode: 'GLOGIFT',     dataPlanCode: '18000',  description: 'GLO Gifting Data',  size: '18GB',   validity: '30 Days',  costPrice: 4775 },

  // ── 9Mobile SME (9MOBILESME) ──────────────────────────────────────────────
  { network: '9Mobile', serviceType: 'SME',      serviceCode: '9MOBILESME',  dataPlanCode: '250',    description: '9Mobile SME Data',  size: '250MB',  validity: '14 Days',  costPrice: 96   },
  { network: '9Mobile', serviceType: 'SME',      serviceCode: '9MOBILESME',  dataPlanCode: '500',    description: '9Mobile SME Data',  size: '500MB',  validity: '30 Days',  costPrice: 150  },
  { network: '9Mobile', serviceType: 'SME',      serviceCode: '9MOBILESME',  dataPlanCode: '3500',   description: '9Mobile SME Data',  size: '3.5GB',  validity: '30 Days',  costPrice: 920  },
  { network: '9Mobile', serviceType: 'SME',      serviceCode: '9MOBILESME',  dataPlanCode: '7000',   description: '9Mobile SME Data',  size: '7GB',    validity: '30 Days',  costPrice: 1765 },
  { network: '9Mobile', serviceType: 'SME',      serviceCode: '9MOBILESME',  dataPlanCode: '15000',  description: '9Mobile SME Data',  size: '15GB',   validity: '30 Days',  costPrice: 3115 },

  // ── 9Mobile Corporate (9MOBILECG) ─────────────────────────────────────────
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '500',    description: '9Mobile Corporate Data', size: '500MB',  validity: '30 Days', costPrice: 162  },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '1000',   description: '9Mobile Corporate Data', size: '1GB',    validity: '30 Days', costPrice: 300  },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '1500',   description: '9Mobile Corporate Data', size: '1.5GB',  validity: '30 Days', costPrice: 450  },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '2000',   description: '9Mobile Corporate Data', size: '2GB',    validity: '30 Days', costPrice: 585  },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '3000',   description: '9Mobile Corporate Data', size: '3GB',    validity: '30 Days', costPrice: 870  },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '4000',   description: '9Mobile Corporate Data', size: '4GB',    validity: '30 Days', costPrice: 1155 },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '4500',   description: '9Mobile Corporate Data', size: '4.5GB',  validity: '30 Days', costPrice: 1298 },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '5000',   description: '9Mobile Corporate Data', size: '5GB',    validity: '30 Days', costPrice: 1440 },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '10000',  description: '9Mobile Corporate Data', size: '10GB',   validity: '30 Days', costPrice: 2865 },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '11000',  description: '9Mobile Corporate Data', size: '11GB',   validity: '30 Days', costPrice: 4140 },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '15000',  description: '9Mobile Corporate Data', size: '15GB',   validity: '30 Days', costPrice: 4290 },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '20000',  description: '9Mobile Corporate Data', size: '20GB',   validity: '30 Days', costPrice: 5715 },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '25000',  description: '9Mobile Corporate Data', size: '25GB',   validity: '30 Days', costPrice: 7140 },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '30000',  description: '9Mobile Corporate Data', size: '30GB',   validity: '30 Days', costPrice: 8565 },
  { network: '9Mobile', serviceType: 'Corporate', serviceCode: '9MOBILECG', dataPlanCode: '40000',  description: '9Mobile Corporate Data', size: '40GB',   validity: '30 Days', costPrice: 11365 },

  // ── 9Mobile Gifting (9MOBILEGIFT) ─────────────────────────────────────────
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '25',     description: '9Mobile Gifting Data', size: '25MB',   validity: '1 Day',    costPrice: 102   },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '2000D',  description: '9Mobile Gifting Data', size: '2GB',    validity: '1 Day',    costPrice: 865   },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '100',    description: '9Mobile Gifting Data', size: '100MB',  validity: '7 Days',   costPrice: 202   },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '250',    description: '9Mobile Gifting Data', size: '250MB',  validity: '14 Days',  costPrice: 175   },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '350',    description: '9Mobile Gifting Data', size: '350MB',  validity: '7 Days',   costPrice: 609   },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '1500W',  description: '9Mobile Gifting Data', size: '1.5GB',  validity: '7 Days',   costPrice: 720   },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '7000W',  description: '9Mobile Gifting Data', size: '7GB',    validity: '7 Days',   costPrice: 2540  },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '500',    description: '9Mobile Gifting Data', size: '500MB',  validity: '14 Days',  costPrice: 335   },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '5000W',  description: '9Mobile Gifting Data', size: '5GB',    validity: '14 Days',  costPrice: 2380  },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '1500',   description: '9Mobile Gifting Data', size: '1.5GB',  validity: '30 Days',  costPrice: 1675  },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '2000',   description: '9Mobile Gifting Data', size: '2GB',    validity: '30 Days',  costPrice: 2014  },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '3000',   description: '9Mobile Gifting Data', size: '3GB',    validity: '30 Days',  costPrice: 2510  },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '4500',   description: '9Mobile Gifting Data', size: '4.5GB',  validity: '30 Days',  costPrice: 3350  },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '5500',   description: '9Mobile Gifting Data', size: '5.5GB',  validity: '30 Days',  costPrice: 6870  },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '11000',  description: '9Mobile Gifting Data', size: '11GB',   validity: '30 Days',  costPrice: 6645  },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '15000',  description: '9Mobile Gifting Data', size: '15GB',   validity: '30 Days',  costPrice: 8330  },
  { network: '9Mobile', serviceType: 'Gifting',  serviceCode: '9MOBILEGIFT', dataPlanCode: '25000',  description: '9Mobile Gifting Data', size: '25GB',   validity: '30 Days',  costPrice: 17850 },
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  let upserted = 0;
  let errors   = 0;

  for (const plan of PLANS) {
    try {
      await DataPlan.findOneAndUpdate(
        { provider: 'vtuafrica', serviceCode: plan.serviceCode, dataPlanCode: plan.dataPlanCode },
        { ...plan, status: 'Active' },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      upserted++;
    } catch (err) {
      console.error(`Failed to upsert ${plan.serviceCode}/${plan.dataPlanCode}:`, err.message);
      errors++;
    }
  }

  console.log(`\nDone. ${upserted} plans upserted, ${errors} errors.`);
  console.log(`Total plans in spec: ${PLANS.length}`);
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
