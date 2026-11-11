const ADMIN_TOKEN_KEY = 'pazhi_admin_token';

function isLocalHost(host) {
  return !host || host === 'localhost' || host === '127.0.0.1' || /^192\.168\./.test(host) || /^10\./.test(host);
}

function resolveBackendOrigin() {
  const param = new URLSearchParams(window.location.search).get('backend');
  if (param) return param.replace(/\/+$/, '');
  const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
  const host = window.location.hostname || 'localhost';
  if (isLocalHost(host)) return `${proto}//${host}:5000`;
  if (typeof window.PULSE_BACKEND_URL === 'string' && window.PULSE_BACKEND_URL.trim()) {
    return window.PULSE_BACKEND_URL.trim().replace(/\/+$/, '');
  }
  return `${proto}//${host}:5000`;
}

const BACKEND = resolveBackendOrigin();
let currentTab = 'dashboard';

const el = {
  loginView: document.getElementById('admin-login-view'),
  shell: document.getElementById('admin-shell'),
  loginForm: document.getElementById('admin-login-form'),
  loginError: document.getElementById('admin-login-error'),
  emailInput: document.getElementById('admin-email'),
  passInput: document.getElementById('admin-password'),
  roleLabel: document.getElementById('admin-role-label'),
  tabHeading: document.getElementById('tab-heading'),
  tabSub: document.getElementById('tab-subheading'),
  toastWrap: document.getElementById('admin-toast-wrap')
};

function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function showToast(msg, isError = false) {
  const div = document.createElement('div');
  div.className = `toast${isError ? ' error' : ''}`;
  div.textContent = msg;
  el.toastWrap.appendChild(div);
  setTimeout(() => div.remove(), 3500);
}

function getToken() {
  return localStorage.getItem(ADMIN_TOKEN_KEY) || '';
}

function setToken(token) {
  if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
  else localStorage.removeItem(ADMIN_TOKEN_KEY);
}

async function api(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${BACKEND}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setToken('');
    showLogin('Session expired. Please sign in again.');
    throw new Error(data.error || 'Unauthorized');
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function showLogin(errMsg = '') {
  el.shell.classList.add('hidden');
  el.loginView.classList.remove('hidden');
  if (errMsg) {
    el.loginError.textContent = errMsg;
    el.loginError.classList.remove('hidden');
  } else {
    el.loginError.classList.add('hidden');
  }
}

function showShell(user) {
  el.loginView.classList.add('hidden');
  el.shell.classList.remove('hidden');
  el.roleLabel.textContent = `${user.name} (${user.email || user.username})`;
  switchTab('dashboard');
}

const TAB_META = {
  dashboard: ['Dashboard Overview', 'Real-time platform revenue, users, and operations'],
  executives: ['Executives & Approvals', 'Approve registrations, manage availability, and grant bonuses'],
  customers: ['Customer Management', 'Search accounts, manage status, and adjust coin balances'],
  pricing: ['Packages & Service Pricing', 'Configure coin packs, per-sec call rates, and commissions'],
  withdrawals: ['Withdrawals & Payments', 'Approve/complete executive payouts with UTR and refund orders'],
  bonuses: ['Bonuses & Announcements', 'Configure automated bonus rules, broadcasts, and sub-admins'],
  monitoring: ['Monitoring, Ledger & Logs', 'Active calls, safety reports, ledger, and admin audit logs']
};

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('hidden', p.id !== `tab-${tab}`);
  });
  const [title, sub] = TAB_META[tab] || ['Admin', ''];
  el.tabHeading.textContent = title;
  el.tabSub.textContent = sub;
  loadCurrentTab();
}

async function loadCurrentTab() {
  try {
    if (currentTab === 'dashboard') await loadDashboard();
    else if (currentTab === 'executives') await loadExecutives();
    else if (currentTab === 'customers') await loadCustomers();
    else if (currentTab === 'pricing') await loadPricing();
    else if (currentTab === 'withdrawals') await loadWithdrawalsAndPayments();
    else if (currentTab === 'bonuses') await loadBonuses();
    else if (currentTab === 'monitoring') await loadMonitoring();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------------- Dashboard ----------------
async function loadDashboard() {
  const days = document.getElementById('dashboard-days').value;
  const { stats } = await api(`/admin/dashboard?days=${days}`);
  const cards = [
    ['Total Customers', stats.totalCustomers],
    ['Total Executives', stats.totalExecutives],
    ['Approved Executives', stats.approvedExecutives],
    ['Pending Approvals', stats.pendingExecutives],
    ['Online Executives', stats.onlineExecutives],
    ['Active Calls Now', stats.activeCallsCount],
    ['Coin Sales (INR)', `₹${stats.totalCoinSalesInr}`],
    ['Chat Revenue (Gross)', `₹${stats.chatRevenueInr}`],
    ['Audio Revenue (Gross)', `₹${stats.audioRevenueInr}`],
    ['Video Revenue (Gross)', `₹${stats.videoRevenueInr}`],
    ['Platform Commission', `₹${stats.totalPlatformCommissionInr}`],
    ['Executive Earnings', `₹${stats.totalExecutiveEarningsInr}`],
    ['Bonus Expenses', `₹${stats.bonusExpensesInr}`],
    ['Pending Withdrawals', stats.pendingWithdrawals],
    ['Paid Orders', stats.paymentTransactions]
  ];

  document.getElementById('kpi-grid').innerHTML = cards
    .map(
      ([label, val]) =>
        `<div class="kpi-card"><div class="kpi-label">${esc(label)}</div><div class="kpi-val">${esc(val)}</div></div>`
    )
    .join('');
}

async function exportLedgerCsv() {
  try {
    const { transactions } = await api('/admin/reports/transactions?limit=500');
    const headers = ['txId', 'userId', 'role', 'kind', 'currency', 'amount', 'balanceAfter', 'grossInr', 'platformCommissionInr', 'executiveNetInr', 'note', 'createdAt'];
    const lines = [headers.join(',')];
    for (const tx of transactions) {
      lines.push(
        headers
          .map((h) => `"${String(tx[h] ?? '').replace(/"/g, '""')}"`)
          .join(',')
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pazhi-ledger-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------------- Executives ----------------
async function loadExecutives() {
  const approval = document.getElementById('exec-approval-filter').value;
  const query = approval ? `?approvalStatus=${encodeURIComponent(approval)}` : '';
  const { executives } = await api(`/admin/executives${query}`);
  const wrap = document.getElementById('executives-table-wrap');

  if (!executives.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">No executives found.</p>';
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Executive</th>
          <th>Category &amp; Bio</th>
          <th>Payout</th>
          <th>Approval</th>
          <th>Status</th>
          <th>Earnings (INR)</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${executives
          .map((ex) => {
            const pillCls = ex.approvalStatus === 'approved' ? 'ok' : ex.approvalStatus === 'rejected' ? 'bad' : 'warn';
            const e = ex.earnings || {};
            return `
              <tr>
                <td>
                  <strong>${esc(ex.name)}</strong><br/>
                  <small style="color:var(--muted)">${esc(ex.email || ex.username)} · ${esc(ex.mobile)}</small>
                </td>
                <td>
                  <span class="pill">${esc(ex.category)}</span><br/>
                  <small style="color:var(--muted)">${esc((ex.languages || []).join(', '))}</small>
                </td>
                <td><small>${esc(ex.payoutDetails?.upiId || ex.payoutDetails?.accountNumber || 'Not set')}</small></td>
                <td><span class="pill ${pillCls}">${esc(ex.approvalStatus)}</span></td>
                <td>
                  <span class="pill ${ex.accountStatus === 'active' ? 'ok' : 'bad'}">${esc(ex.accountStatus)}</span>
                  ${ex.isOnline ? '<span class="pill ok">Online</span>' : ''}
                </td>
                <td>
                  Avail: <strong>₹${esc(e.approvedInr || 0)}</strong><br/>
                  <small style="color:var(--muted)">Chat ₹${esc(e.chatInr || 0)} · Aud ₹${esc(e.audioInr || 0)} · Vid ₹${esc(e.videoInr || 0)} · Bonus ₹${esc(e.bonusInr || 0)}</small>
                </td>
                <td>
                  <div class="actions-row">
                    ${ex.approvalStatus !== 'approved' ? `<button class="btn sm success" data-exec-approve="${esc(ex.userId)}">Approve</button>` : ''}
                    ${ex.approvalStatus !== 'rejected' ? `<button class="btn sm danger" data-exec-reject="${esc(ex.userId)}">Reject</button>` : ''}
                    <button class="btn sm ghost" data-exec-toggle="${esc(ex.userId)}" data-next="${ex.accountStatus === 'active' ? 'suspended' : 'active'}">
                      ${ex.accountStatus === 'active' ? 'Suspend' : 'Activate'}
                    </button>
                    <button class="btn sm ghost" data-exec-bonus="${esc(ex.userId)}">+ Bonus</button>
                  </div>
                </td>
              </tr>`;
          })
          .join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('[data-exec-approve]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/admin/executives/${btn.dataset.execApprove}/approval`, {
        method: 'PATCH',
        body: JSON.stringify({ approvalStatus: 'approved' })
      });
      showToast('Executive approved!');
      loadExecutives();
    })
  );

  wrap.querySelectorAll('[data-exec-reject]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const note = prompt('Rejection reason (optional):') || '';
      await api(`/admin/executives/${btn.dataset.execReject}/approval`, {
        method: 'PATCH',
        body: JSON.stringify({ approvalStatus: 'rejected', note })
      });
      showToast('Executive rejected.');
      loadExecutives();
    })
  );

  wrap.querySelectorAll('[data-exec-toggle]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/admin/executives/${btn.dataset.execToggle}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ accountStatus: btn.dataset.next })
      });
      showToast(`Status updated to ${btn.dataset.next}`);
      loadExecutives();
    })
  );

  wrap.querySelectorAll('[data-exec-bonus]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const amountInr = Number(prompt('Bonus amount in INR:') || 0);
      if (!amountInr || amountInr <= 0) return;
      const note = prompt('Bonus reason:') || 'Admin performance bonus';
      await api(`/admin/executives/${btn.dataset.execBonus}/grant-bonus`, {
        method: 'POST',
        body: JSON.stringify({ amountInr, note })
      });
      showToast(`₹${amountInr} bonus credited!`);
      loadExecutives();
    })
  );
}

// ---------------- Customers ----------------
async function loadCustomers() {
  const q = document.getElementById('customer-search').value.trim();
  const status = document.getElementById('customer-status-filter').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);

  const { customers } = await api(`/admin/customers?${params.toString()}`);
  const wrap = document.getElementById('customers-table-wrap');

  if (!customers.length) {
    wrap.innerHTML = '<p style="color:var(--muted)">No customers found.</p>';
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Customer</th>
          <th>Contact</th>
          <th>Coin Balance</th>
          <th>Purchased</th>
          <th>Status</th>
          <th>Joined</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${customers
          .map(
            (c) => `
          <tr>
            <td><strong>${esc(c.name)}</strong><br/><small style="color:var(--muted)">@${esc(c.username)}</small></td>
            <td><small>${esc(c.email || '—')}<br/>${esc(c.mobile || '—')}</small></td>
            <td><strong>${esc(c.coinBalance || 0)}</strong> <small style="color:var(--muted)">(Bonus: ${esc(c.bonusCoinBalance || 0)})</small></td>
            <td>${esc(c.totalCoinsPurchased || 0)}</td>
            <td><span class="pill ${c.accountStatus === 'active' ? 'ok' : 'bad'}">${esc(c.accountStatus)}</span></td>
            <td><small>${esc(fmtTime(c.createdAt))}</small></td>
            <td>
              <div class="actions-row">
                <button class="btn sm ghost" data-cust-coins="${esc(c.userId)}">Adjust Coins</button>
                <button class="btn sm ${c.accountStatus === 'active' ? 'danger' : 'success'}" data-cust-status="${esc(c.userId)}" data-next="${c.accountStatus === 'active' ? 'blocked' : 'active'}">
                  ${c.accountStatus === 'active' ? 'Block' : 'Activate'}
                </button>
              </div>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('[data-cust-coins]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const delta = Number(prompt('Enter coins to add (positive) or deduct (negative):'));
      if (!delta) return;
      const reason = prompt('Audit reason for adjustment:') || 'Admin adjustment';
      try {
        await api(`/admin/customers/${btn.dataset.custCoins}/adjust-coins`, {
          method: 'POST',
          body: JSON.stringify({ delta, reason })
        });
        showToast('Coin balance adjusted & logged.');
        loadCustomers();
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );

  wrap.querySelectorAll('[data-cust-status]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/admin/customers/${btn.dataset.custStatus}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ accountStatus: btn.dataset.next })
      });
      showToast(`Customer ${btn.dataset.next}.`);
      loadCustomers();
    })
  );
}

// ---------------- Packages & Pricing ----------------
async function loadPricing() {
  const [{ settings }, { packages }] = await Promise.all([
    api('/admin/settings'),
    api('/admin/packages')
  ]);

  const form = document.getElementById('settings-form');
  form.platformName.value = settings.platformName || 'Pazhi';
  form.chatCoinPerMessage.value = settings.chatCoinPerMessage ?? 10;
  form.audioCoinPerSecond.value = settings.audioCoinPerSecond ?? 1;
  form.videoCoinPerSecond.value = settings.videoCoinPerSecond ?? 2;
  form.coinToInrRate.value = settings.coinToInrRate ?? 1;
  form.chatExecPct.value = settings.commissions?.chatExecPct ?? 70;
  form.audioExecPct.value = settings.commissions?.audioExecPct ?? 70;
  form.videoExecPct.value = settings.commissions?.videoExecPct ?? 70;
  form.minWithdrawalInr.value = settings.minWithdrawalInr ?? 500;
  form.lowBalanceWarningCoins.value = settings.lowBalanceWarningCoins ?? 30;
  form.messageExpirySeconds.value = settings.messageExpirySeconds ?? 0;
  form.freeMessageLimit.value = settings.freeMessageLimit ?? 0;
  form.freeMessagesEnabled.checked = Boolean(settings.freeMessagesEnabled);
  form.viewOnceEnabled.checked = settings.viewOnceEnabled !== false;
  form.maintenanceMode.checked = Boolean(settings.maintenanceMode);
  form.supportEmail.value = settings.supportEmail || '';

  const wrap = document.getElementById('packages-table-wrap');
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Price</th><th>Coins</th><th>Sales</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>
        ${packages
          .map(
            (p) => `
          <tr>
            <td><strong>${esc(p.name)}</strong> ${p.isPromotional ? '<span class="pill warn">Promo</span>' : ''}</td>
            <td>₹${esc(p.priceInr)}</td>
            <td>${esc(p.coins)} + ${esc(p.bonusCoins)} bonus</td>
            <td>${esc(p.salesCount || 0)} (₹${esc(p.totalRevenueInr || 0)})</td>
            <td><span class="pill ${p.isActive ? 'ok' : 'bad'}">${p.isActive ? 'Active' : 'Inactive'}</span></td>
            <td>
              <div class="actions-row">
                <button class="btn sm ghost" data-pkg-toggle="${esc(p.packageId)}" data-active="${!p.isActive}">
                  ${p.isActive ? 'Deactivate' : 'Activate'}
                </button>
                <button class="btn sm danger" data-pkg-delete="${esc(p.packageId)}">Delete</button>
              </div>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('[data-pkg-toggle]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/admin/packages/${btn.dataset.pkgToggle}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: btn.dataset.active === 'true' })
      });
      showToast('Package updated.');
      loadPricing();
    })
  );

  wrap.querySelectorAll('[data-pkg-delete]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this coin package?')) return;
      await api(`/admin/packages/${btn.dataset.pkgDelete}`, { method: 'DELETE' });
      showToast('Package deleted.');
      loadPricing();
    })
  );
}

// ---------------- Withdrawals & Payments ----------------
async function loadWithdrawalsAndPayments() {
  const wdStatus = document.getElementById('withdrawal-status-filter').value;
  const payStatus = document.getElementById('payment-status-filter').value;
  const [{ withdrawals }, { payments }] = await Promise.all([
    api(`/admin/withdrawals${wdStatus ? `?status=${encodeURIComponent(wdStatus)}` : ''}`),
    api(`/admin/payments${payStatus ? `?status=${encodeURIComponent(payStatus)}` : ''}`)
  ]);

  const wdWrap = document.getElementById('withdrawals-table-wrap');
  wdWrap.innerHTML = withdrawals.length
    ? `<table>
        <thead><tr><th>Executive</th><th>Amount</th><th>Method / Details</th><th>Status</th><th>UTR</th><th>Actions</th></tr></thead>
        <tbody>
          ${withdrawals
            .map((w) => {
              const cls = w.status === 'completed' ? 'ok' : w.status === 'rejected' ? 'bad' : 'warn';
              return `
              <tr>
                <td><strong>${esc(w.executive?.name || w.executiveId)}</strong><br/><small style="color:var(--muted)">${esc(fmtTime(w.createdAt))}</small></td>
                <td><strong>₹${esc(w.amountInr)}</strong></td>
                <td><small>${esc(w.payoutMethod.toUpperCase())}: ${esc(w.payoutDetails?.upiId || w.payoutDetails?.accountNumber || '')}</small></td>
                <td><span class="pill ${cls}">${esc(w.status)}</span></td>
                <td><small>${esc(w.utr || '—')}</small></td>
                <td>
                  <div class="actions-row">
                    ${w.status === 'pending' ? `<button class="btn sm ghost" data-wd-id="${esc(w.withdrawalId)}" data-wd-next="approved">Approve</button>` : ''}
                    ${['pending', 'approved', 'processing'].includes(w.status) ? `<button class="btn sm success" data-wd-id="${esc(w.withdrawalId)}" data-wd-next="completed">Mark Paid (UTR)</button>` : ''}
                    ${['pending', 'approved', 'processing'].includes(w.status) ? `<button class="btn sm danger" data-wd-id="${esc(w.withdrawalId)}" data-wd-next="rejected">Reject</button>` : ''}
                  </div>
                </td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>`
    : '<p style="color:var(--muted)">No withdrawal requests.</p>';

  wdWrap.querySelectorAll('[data-wd-id]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const next = btn.dataset.wdNext;
      const body = { status: next };
      if (next === 'completed') {
        body.utr = prompt('Enter Bank / UPI UTR reference:') || '';
        if (!body.utr) return;
      }
      if (next === 'rejected') {
        body.rejectionReason = prompt('Rejection reason:') || 'Rejected by Admin';
      }
      await api(`/admin/withdrawals/${btn.dataset.wdId}`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      });
      showToast(`Withdrawal marked ${next}.`);
      loadWithdrawalsAndPayments();
    })
  );

  const payWrap = document.getElementById('payments-table-wrap');
  payWrap.innerHTML = payments.length
    ? `<table>
        <thead><tr><th>Order ID</th><th>User</th><th>Package</th><th>Amount</th><th>Status</th><th>Date</th><th>Action</th></tr></thead>
        <tbody>
          ${payments
            .map(
              (p) => `
            <tr>
              <td><small>${esc(p.orderId)}</small></td>
              <td><small>${esc(p.userId)}</small></td>
              <td>${esc(p.packageName)} (${esc(p.coins)}+${esc(p.bonusCoins)})</td>
              <td>₹${esc(p.amountInr)}</td>
              <td><span class="pill ${p.status === 'paid' ? 'ok' : p.status === 'refunded' ? 'warn' : 'bad'}">${esc(p.status)}</span></td>
              <td><small>${esc(fmtTime(p.createdAt))}</small></td>
              <td>${p.status === 'paid' ? `<button class="btn sm danger" data-refund="${esc(p.orderId)}">Refund</button>` : '—'}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`
    : '<p style="color:var(--muted)">No payment orders.</p>';

  payWrap.querySelectorAll('[data-refund]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const reason = prompt('Refund reason:') || 'Admin refund';
      await api(`/admin/payments/${btn.dataset.refund}/refund`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
      showToast('Payment refunded & coins reversed.');
      loadWithdrawalsAndPayments();
    })
  );
}

// ---------------- Bonuses ----------------
async function loadBonuses() {
  const { rules } = await api('/admin/bonuses');
  const wrap = document.getElementById('bonuses-table-wrap');
  wrap.innerHTML = rules.length
    ? `<table>
        <thead><tr><th>Name</th><th>Metric</th><th>Target</th><th>Reward</th><th>Status</th></tr></thead>
        <tbody>
          ${rules
            .map(
              (r) => `
            <tr>
              <td><strong>${esc(r.name)}</strong><br/><small style="color:var(--muted)">${esc(r.period)}</small></td>
              <td>${esc(r.metric)}</td>
              <td>${esc(r.targetValue)}</td>
              <td>${r.bonusType === 'percentage' ? `${esc(r.rewardValue)}%` : `₹${esc(r.rewardValue)}`}</td>
              <td><span class="pill ${r.isActive ? 'ok' : 'bad'}">${r.isActive ? 'Active' : 'Off'}</span></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`
    : '<p style="color:var(--muted)">No bonus rules yet.</p>';
}

// ---------------- Monitoring & Logs ----------------
async function loadMonitoring() {
  const [{ activeCalls, recentCalls, reports }, { transactions }, { logs }] = await Promise.all([
    api('/admin/monitoring/sessions'),
    api('/admin/reports/transactions?limit=100'),
    api('/admin/audit-logs')
  ]);

  const calls = [...activeCalls, ...recentCalls.filter((c) => c.status !== 'active')].slice(0, 25);
  document.getElementById('sessions-table-wrap').innerHTML = calls.length
    ? `<table>
        <thead><tr><th>Call ID</th><th>Type</th><th>Caller &rarr; Callee</th><th>Duration</th><th>Coins</th><th>Exec INR</th><th>Status</th></tr></thead>
        <tbody>
          ${calls
            .map(
              (c) => `
            <tr>
              <td><small>${esc(c.callId)}</small></td>
              <td>${esc(c.callType)}</td>
              <td><small>${esc(c.callerId)} &rarr; ${esc(c.calleeId)}</small></td>
              <td>${esc(c.billedSeconds || 0)}s</td>
              <td>${esc(c.totalCoinsCharged || 0)}</td>
              <td>₹${esc(c.execEarnedInr || 0)}</td>
              <td><span class="pill ${c.status === 'active' ? 'ok' : ''}">${esc(c.status)}</span></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`
    : '<p style="color:var(--muted)">No call records yet.</p>';

  document.getElementById('reports-table-wrap').innerHTML = reports.length
    ? `<table>
        <thead><tr><th>Reporter</th><th>Reported User</th><th>Reason</th><th>Status</th><th>Date</th></tr></thead>
        <tbody>
          ${reports
            .map(
              (r) => `
            <tr>
              <td><small>${esc(r.reporterId)}</small></td>
              <td><small>${esc(r.reportedUserId)}</small></td>
              <td>${esc(r.reason)}</td>
              <td><span class="pill warn">${esc(r.status)}</span></td>
              <td><small>${esc(fmtTime(r.createdAt))}</small></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`
    : '<p style="color:var(--muted)">No user reports.</p>';

  document.getElementById('ledger-table-wrap').innerHTML = transactions.length
    ? `<table>
        <thead><tr><th>Tx ID</th><th>User</th><th>Kind</th><th>Amount</th><th>Balance After</th><th>Note</th><th>Time</th></tr></thead>
        <tbody>
          ${transactions
            .map(
              (t) => `
            <tr>
              <td><small>${esc(t.txId)}</small></td>
              <td><small>${esc(t.userId)} (${esc(t.role)})</small></td>
              <td><span class="pill">${esc(t.kind)}</span></td>
              <td>${t.currency === 'INR' ? `₹${esc(t.amount)}` : `${esc(t.amount)} coins`}</td>
              <td>${t.currency === 'INR' ? `₹${esc(t.balanceAfter)}` : `${esc(t.balanceAfter)} coins`}</td>
              <td><small>${esc(t.note)}</small></td>
              <td><small>${esc(fmtTime(t.createdAt))}</small></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`
    : '<p style="color:var(--muted)">No ledger transactions yet.</p>';

  document.getElementById('audit-table-wrap').innerHTML = logs.length
    ? `<table>
        <thead><tr><th>Actor</th><th>Action</th><th>Target</th><th>Details</th><th>Time</th></tr></thead>
        <tbody>
          ${logs
            .map(
              (l) => `
            <tr>
              <td><small>${esc(l.actorId)}</small></td>
              <td><span class="pill">${esc(l.action)}</span></td>
              <td><small>${esc(l.targetId || '—')}</small></td>
              <td><small>${esc(JSON.stringify(l.details || {}))}</small></td>
              <td><small>${esc(fmtTime(l.createdAt))}</small></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`
    : '<p style="color:var(--muted)">No audit logs yet.</p>';
}

// ---------------- Event Bindings ----------------
el.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.loginError.classList.add('hidden');
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        identifier: el.emailInput.value.trim(),
        password: el.passInput.value,
        role: 'admin'
      })
    });
    setToken(data.token);
    showShell(data.user);
  } catch (err) {
    showLogin(err.message);
  }
});

document.getElementById('btn-admin-logout').addEventListener('click', () => {
  setToken('');
  showLogin();
});

document.querySelectorAll('.nav-btn').forEach((btn) =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
);

document.getElementById('btn-refresh-tab').addEventListener('click', loadCurrentTab);
document.getElementById('dashboard-days').addEventListener('change', loadDashboard);
document.getElementById('btn-export-ledger').addEventListener('click', exportLedgerCsv);
document.getElementById('exec-approval-filter').addEventListener('change', loadExecutives);
document.getElementById('btn-search-customers').addEventListener('click', loadCustomers);
document.getElementById('customer-status-filter').addEventListener('change', loadCustomers);
document.getElementById('withdrawal-status-filter').addEventListener('change', loadWithdrawalsAndPayments);
document.getElementById('payment-status-filter').addEventListener('change', loadWithdrawalsAndPayments);

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        platformName: f.platformName.value.trim(),
        chatCoinPerMessage: Number(f.chatCoinPerMessage.value),
        audioCoinPerSecond: Number(f.audioCoinPerSecond.value),
        videoCoinPerSecond: Number(f.videoCoinPerSecond.value),
        coinToInrRate: Number(f.coinToInrRate.value),
        commissions: {
          chatExecPct: Number(f.chatExecPct.value),
          audioExecPct: Number(f.audioExecPct.value),
          videoExecPct: Number(f.videoExecPct.value)
        },
        minWithdrawalInr: Number(f.minWithdrawalInr.value),
        lowBalanceWarningCoins: Number(f.lowBalanceWarningCoins.value),
        messageExpirySeconds: Number(f.messageExpirySeconds.value),
        freeMessageLimit: Number(f.freeMessageLimit.value),
        freeMessagesEnabled: f.freeMessagesEnabled.checked,
        viewOnceEnabled: f.viewOnceEnabled.checked,
        maintenanceMode: f.maintenanceMode.checked,
        supportEmail: f.supportEmail.value.trim()
      })
    });
    showToast('Platform settings saved!');
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('package-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/admin/packages', {
      method: 'POST',
      body: JSON.stringify({
        name: f.name.value.trim(),
        priceInr: Number(f.priceInr.value),
        coins: Number(f.coins.value),
        bonusCoins: Number(f.bonusCoins.value || 0),
        displayOrder: Number(f.displayOrder.value || 0),
        isPromotional: f.isPromotional.checked
      })
    });
    f.reset();
    showToast('Coin package created!');
    loadPricing();
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('bonus-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/admin/bonuses', {
      method: 'POST',
      body: JSON.stringify({
        name: f.name.value.trim(),
        bonusType: f.bonusType.value,
        metric: f.metric.value,
        period: f.period.value,
        targetValue: Number(f.targetValue.value),
        rewardValue: Number(f.rewardValue.value),
        maxBonusInr: Number(f.maxBonusInr.value || 5000)
      })
    });
    f.reset();
    showToast('Bonus rule created!');
    loadBonuses();
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('broadcast-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const res = await api('/admin/notifications/broadcast', {
      method: 'POST',
      body: JSON.stringify({
        targetRole: f.targetRole.value,
        title: f.title.value.trim(),
        body: f.body.value.trim()
      })
    });
    f.reset();
    showToast(`Broadcast sent to ${res.sentCount} users!`);
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('subadmin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/admin/admins', {
      method: 'POST',
      body: JSON.stringify({
        name: f.name.value.trim(),
        email: f.email.value.trim(),
        password: f.password.value,
        permissions: f.permissions.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      })
    });
    f.reset();
    showToast('Sub-admin created!');
  } catch (err) {
    showToast(err.message, true);
  }
});

// Boot
(async () => {
  const token = getToken();
  if (!token) {
    showLogin();
    return;
  }
  try {
    const { user } = await api('/auth/me');
    if (user.role !== 'admin') {
      setToken('');
      showLogin('Admin account required.');
      return;
    }
    showShell(user);
  } catch {
    showLogin();
  }
})();

