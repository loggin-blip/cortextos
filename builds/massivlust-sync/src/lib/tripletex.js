import { config } from '../config.js';

const BASE = config.tripletex.apiBase;
let cachedSession = null;

async function getSessionToken() {
  if (cachedSession && cachedSession.expires > Date.now()) {
    return cachedSession.token;
  }

  const { consumerToken, employeeToken } = config.tripletex;
  if (!consumerToken || !employeeToken) {
    throw new Error('Missing TRIPLETEX_CONSUMER_TOKEN or TRIPLETEX_EMPLOYEE_TOKEN');
  }

  const d = new Date();
  d.setDate(d.getDate() + 2);
  const expDate = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });

  const res = await fetch(
    `${BASE}/token/session/:create?consumerToken=${encodeURIComponent(consumerToken)}&employeeToken=${encodeURIComponent(employeeToken)}&expirationDate=${expDate}`,
    { method: 'PUT', signal: AbortSignal.timeout(15000) },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tripletex session create failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  const token = json.value?.token ?? json.value?.sessionToken;
  if (!token) throw new Error('No session token in response');

  cachedSession = { token, expires: Date.now() + 20 * 60 * 60 * 1000 };
  return token;
}

export async function ttGet(path, params, _retries = 0) {
  const session = await getSessionToken();
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const auth = Buffer.from(`0:${session}`).toString('base64');
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 401 && _retries < 1) {
    cachedSession = null;
    return ttGet(path, params, _retries + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tripletex ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return res.json();
}

export async function searchEmployees() {
  const data = await ttGet('/employee', {
    count: '100',
    fields: 'id,firstName,lastName,email,employeeNumber,department(id,name)',
  });
  return data.values ?? [];
}

export async function searchProjects(opts = {}) {
  const params = {
    count: '100',
    fields: 'id,name,number,startDate,endDate,isInternal,isClosed,customer(id,name),projectManager(id,firstName,lastName),description',
  };
  if (opts.isClosed !== undefined) params.isClosed = String(opts.isClosed);
  const data = await ttGet('/project', params);
  return data.values ?? [];
}

export async function searchTimeEntries(opts = {}) {
  const params = {
    count: '1000',
    fields: 'id,employee(id,firstName,lastName),project(id,name),activity(id,name),date,hours,comment',
  };
  if (opts.projectId) params.projectId = String(opts.projectId);
  if (opts.dateFrom) params.dateFrom = opts.dateFrom;
  if (opts.dateTo) params.dateTo = opts.dateTo;

  let all = [];
  let from = 0;
  while (true) {
    params.from = String(from);
    const data = await ttGet('/timesheet/entry', params);
    const values = data.values ?? [];
    all.push(...values);
    if (all.length >= data.fullResultSize || values.length === 0) break;
    from += values.length;
  }
  return all;
}

export async function searchInvoices(opts = {}) {
  const now = new Date();
  const twoYearsAgo = new Date(now);
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  const params = {
    count: '500',
    invoiceDateFrom: opts.dateFrom ?? twoYearsAgo.toISOString().slice(0, 10),
    invoiceDateTo: opts.dateTo ?? now.toISOString().slice(0, 10),
    fields: 'id,invoiceNumber,invoiceDate,amount,amountOutstanding,isCredited,customer(id,name)',
  };
  if (opts.projectId) params.projectId = String(opts.projectId);

  const data = await ttGet('/invoice', params);
  return data.values ?? [];
}

export async function searchOrders(opts = {}) {
  const now = new Date();
  const twoYearsAgo = new Date(now);
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  const params = {
    count: '500',
    orderDateFrom: opts.dateFrom ?? twoYearsAgo.toISOString().slice(0, 10),
    orderDateTo: opts.dateTo ?? now.toISOString().slice(0, 10),
    fields: 'id,number,orderDate,deliveryDate,customer(id,name),project(id,name),isClosed',
  };
  if (opts.projectId) params.projectId = String(opts.projectId);

  const data = await ttGet('/order', params);
  return data.values ?? [];
}
